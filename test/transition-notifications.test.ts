import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHandoffMessage } from '../src/messages/render-handoff-message.js';
import {
  deliverTransitionNotification,
  retryTransitionNotifications,
} from '../src/notifications/service.js';
import {
  formatBoardUpdateHandoff,
  formatMemberAccessHandoff,
  formatMemberRemovalHandoff,
} from '../src/services/governance/formatters.js';
import { projectRemovalMessage } from '../src/services/projects/formatters.js';
import {
  prepareAndDeliverProjectNotifications,
  queueProjectAssignmentNotification,
} from '../src/services/projects/notifications.js';

function deliveryDb({ sendError = null } = {}) {
  const state = {
    status: 'pending',
    retryable: true,
    attempts: 0,
    lastErrorCode: null,
    sendError,
  };
  return {
    state,
    async query(text, values = []) {
      if (text.includes("SET status = 'sending'")) {
        if (state.status !== 'pending' && state.status !== 'failed') return { rows: [], rowCount: 0 };
        if (!state.retryable) return { rows: [], rowCount: 0 };
        state.status = 'sending';
        state.attempts += 1;
        return {
          rows: [{
            id: 11,
            recipient_discord_user_id: 'member-1',
            kind: 'member.removed',
            payload: { content: 'Private transition', allowedMentions: { parse: [] } },
            attempt_count: state.attempts,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT status, retryable')) {
        return { rows: [{ status: state.status, retryable: state.retryable, last_error_code: state.lastErrorCode }], rowCount: 1 };
      }
      if (text.includes("SET status = 'delivered'")) {
        state.status = 'delivered';
        state.retryable = false;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET status = 'failed'")) {
        state.status = 'failed';
        state.retryable = Boolean(values[1]);
        state.lastErrorCode = values[3];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('notification claims make repeated delivery idempotent', async () => {
  const db = deliveryDb();
  let sends = 0;
  const recipient = {
    async send(payload) {
      sends += 1;
      assert.equal(payload.content, 'Private transition');
    },
  };
  const guild = { members: { async fetch() { return recipient; } } };

  const first = await deliverTransitionNotification({ db, guild, notificationId: 11, recipient });
  const second = await deliverTransitionNotification({ db, guild, notificationId: 11, recipient });

  assert.equal(first.status, 'delivered');
  assert.equal(second.status, 'delivered');
  assert.equal(sends, 1);
  assert.equal(db.state.status, 'delivered');
});

test('closed DMs become a durable non-retryable failure without rolling state back', async () => {
  const error = Object.assign(new Error('Cannot send messages to this user'), { code: 50_007 });
  const db = deliveryDb({ sendError: error });
  const recipient = { async send() { throw error; } };
  const guild = { members: { async fetch() { return recipient; } } };

  const result = await deliverTransitionNotification({ db, guild, notificationId: 11, recipient });

  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(db.state.status, 'failed');
  assert.equal(db.state.retryable, false);
  assert.equal(db.state.lastErrorCode, '50007');
});

test('a removed member can still receive a safe retry through the Discord user route', async () => {
  const db = deliveryDb();
  let sent = 0;
  const guild = {
    members: {
      async fetch() {
        throw Object.assign(new Error('Unknown Member'), { code: 10_007 });
      },
    },
    client: {
      users: {
        async fetch(id) {
          assert.equal(id, 'member-1');
          return { async send() { sent += 1; } };
        },
      },
    },
  };
  const result = await deliverTransitionNotification({ db, guild, notificationId: 11 });
  assert.equal(result.status, 'delivered');
  assert.equal(sent, 1);
});

test('a sent DM with an unrecorded acknowledgement becomes uncertain instead of replaying', async () => {
  let status = 'pending';
  let sends = 0;
  const db = {
    async query(text) {
      if (text.includes("SET status = 'sending'")) {
        if (status !== 'pending') return { rows: [], rowCount: 0 };
        status = 'sending';
        return {
          rows: [{
            id: 22,
            recipient_discord_user_id: 'member-2',
            kind: 'board.authority_changed',
            payload: { content: 'Authority changed', allowedMentions: { parse: [] } },
            attempt_count: 1,
          }],
          rowCount: 1,
        };
      }
      if (text.includes("SET status = 'delivered'")) throw new Error('database disconnected after send');
      if (text.includes('SELECT status, retryable')) {
        return { rows: [{ status, retryable: true, last_error_code: null }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const recipient = { async send() { sends += 1; } };
  const guild = { members: { async fetch() { return recipient; } } };

  const first = await deliverTransitionNotification({ db, guild, notificationId: 22, recipient });
  const second = await deliverTransitionNotification({ db, guild, notificationId: 22, recipient });

  assert.equal(first.status, 'uncertain');
  assert.equal(second.status, 'sending');
  assert.equal(sends, 1);
});

test('stale sending claims become uncertain and are never replayed automatically', async () => {
  const calls = [];
  const db = {
    async query(text) {
      calls.push(text);
      if (text.includes("SET status = 'uncertain'")) return { rows: [{ id: 91 }], rowCount: 1 };
      if (text.includes('FROM transition_notifications')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const results = await retryTransitionNotifications({ guild: {}, db });
  assert.deepEqual(results, []);
  assert.ok(calls.some((text) => text.includes("status = 'sending'")));
  assert.ok(calls.every((text) => !text.includes("status IN ('pending', 'failed')") || text.includes('SELECT id')));
});

test('handoff rendering preserves recovery guidance near Discord limits', () => {
  const payload = renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'danger',
    title: 'Access changed',
    statusLabel: 'Access removed',
    context: 'A high-impact transition was committed.',
    sections: [{ heading: 'Long detail', body: 'x'.repeat(3_000) }],
    nextActions: ['Contact the university board through a safe route.'],
    fallback: 'Use your existing external contact if no shared Discord space remains.',
    provenance: 'BAINSA governance · Recovery test',
  });
  assert.ok(payload.content.length <= 2_000);
  assert.match(payload.content, /\*\*Status\*\*\nAccess removed/);
  assert.match(payload.content, /\*\*What to do next\*\*/);
  assert.match(payload.content, /\*\*If you need help\*\*/);
  assert.match(payload.content, /Recovery test$/);
});

test('member removal never exposes an internal audit reason unless policy supplies a shareable explanation', () => {
  const result = {
    universityName: 'Bocconi',
    divisions: [{ name: 'Analysis' }],
    boardRoles: [{ role: 'head', division_name: 'Analysis' }],
    projects: [{ name: 'Signals' }],
  };
  const privateOnly = formatMemberRemovalHandoff(result);
  assert.doesNotMatch(privateOnly.content, /internal investigation/i);
  assert.match(privateOnly.content, /Internal board notes.*not included/s);

  const shareable = formatMemberRemovalHandoff(result, {
    shareableReason: 'Your membership term ended on 31 July.',
  });
  assert.match(shareable.content, /Your membership term ended on 31 July/);
});

test('effective-access handoffs name changed spaces, responsibility, remaining access, and safe help', () => {
  const member = formatMemberAccessHandoff({
    guildId: 'guild',
    memberType: 'researcher',
    university: { name: 'Bocconi' },
    divisions: [{ name: 'Analysis', text_channel_id: 'analysis-channel' }],
    previousRecord: { member_type: 'alumni', university_name: 'Bocconi' },
    previousDivisions: [],
  });
  assert.match(member.content, /Member type: Alumni → Researcher/);
  assert.match(member.content, /Spaces available now/);
  assert.match(member.content, /What remains/);
  assert.match(member.content, /Open Analysis/);
  assert.match(member.content, /If you need help/);

  const board = formatBoardUpdateHandoff(
    {
      guildId: 'guild',
      university: { name: 'Bocconi', board_channel_id: 'board-channel' },
      divisions: [],
    },
    {
      before: [],
      after: ['Vice President'],
      nextRoles: [{ role: 'vice_president' }],
    },
  );
  assert.match(board.content, /Responsibility added/);
  assert.match(board.content, /Open university board/);
});

test('project removal gives role-aware closure without exposing unrelated notes', () => {
  const payload = projectRemovalMessage(
    'guild',
    {
      id: 42,
      name: 'Signals',
      university_name: 'Bocconi',
      showcase_thread_id: 'showcase',
    },
    'The team no longer needs this assignment.',
    'supervisor',
  );
  assert.match(payload.content, /Project access removed/);
  assert.match(payload.content, /Previous role\*\*\nSupervisor/);
  assert.match(payload.content, /What remains/);
  assert.match(payload.content, /If you need help/);
  assert.doesNotMatch(payload.content, /internal notes/i);
});

test('project handoffs wait for reconciliation and recover with current workspace links', async () => {
  const state = { row: null, sent: null };
  const db = {
    async query(text, values = []) {
      if (text.includes('INSERT INTO transition_notifications')) {
        assert.equal(values[8], false);
        state.row = {
          id: 70,
          kind: 'project.assigned',
          recipient_discord_user_id: 'member-1',
          metadata: JSON.parse(values[7]),
          payload: JSON.parse(values[6]),
          status: 'pending',
          ready: false,
        };
        return { rows: [{ id: 70 }], rowCount: 1 };
      }
      if (text.includes('SELECT id, kind, recipient_discord_user_id, metadata')) {
        return { rows: [state.row], rowCount: 1 };
      }
      if (text.includes('SET payload = $2::jsonb')) {
        state.row.payload = JSON.parse(values[1]);
        state.row.ready = true;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("SET status = 'sending'")) {
        state.row.status = 'sending';
        return {
          rows: [{
            ...state.row,
            recipient_discord_user_id: 'member-1',
            attempt_count: 1,
          }],
          rowCount: 1,
        };
      }
      if (text.includes("SET status = 'delivered'")) {
        state.row.status = 'delivered';
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  const pendingProject = {
    id: 42,
    name: 'Signals',
    university_id: 3,
    university_name: 'Bocconi',
    division_name: 'Analysis',
    division_color: 'orange',
    discord_channel_id: null,
    showcase_thread_id: null,
  };
  await queueProjectAssignmentNotification(db, {
    auditId: 9,
    guildId: 'guild',
    project: pendingProject,
    person: { discord_user_id: 'member-1', role: 'member' },
  });
  assert.doesNotMatch(state.row.payload.content, /channels\/guild\/workspace/);

  const guild = {
    id: 'guild',
    members: {
      async fetch() {
        return { async send(payload) { state.sent = payload; } };
      },
    },
  };
  await prepareAndDeliverProjectNotifications({
    db,
    guild,
    project: {
      ...pendingProject,
      discord_channel_id: 'workspace',
      showcase_thread_id: 'showcase',
    },
  });

  assert.equal(state.row.status, 'delivered');
  assert.match(state.sent.content, /channels\/guild\/workspace/);
  assert.match(state.sent.content, /channels\/guild\/showcase/);
});
