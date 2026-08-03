import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE_NAMES } from '../src/constants.js';
import { reconcileExistingMembers } from '../src/provision/members.js';
import { normalizePlan } from '../src/provision/plan.js';

const plan = normalizePlan({
  universities: [{ name: 'Bocconi', divisions: ['Projects', 'Analysis'] }],
});

const resources = {
  universities: [{
    id: 1,
    slug: 'bocconi',
    divisions: [
      { id: 11, slug: 'projects' },
      { id: 12, slug: 'analysis' },
    ],
  }],
};

function roleMap() {
  return new Map([
    [ROLE_NAMES.RESEARCHER, { id: 'researcher', name: ROLE_NAMES.RESEARCHER }],
    [ROLE_NAMES.ALUMNI, { id: 'alumni', name: ROLE_NAMES.ALUMNI }],
  ]);
}

function member(id, roleNames, { onAdd, onRemove } = {}) {
  const roles = roleNames.map((name, index) => ({ id: `${id}-${index}`, name }));
  return {
    id: String(id),
    user: { bot: false },
    roles: {
      cache: {
        map(callback) {
          return roles.map(callback);
        },
        has(roleId) {
          return roles.some((role) => role.id === roleId);
        },
      },
      async add(role) {
        return onAdd?.(role);
      },
      async remove(role) {
        return onRemove?.(role);
      },
    },
  };
}

function guildFrom(members) {
  return {
    members: {
      async fetch() {
        return new Map(members.map((entry) => [entry.id, entry]));
      },
    },
  };
}

function recordingDatabase() {
  const statements = [];
  const db = {
    async transaction(work) {
      return work(this);
    },
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('FROM project_people pp')) return { rows: [] };
      return { rows: [] };
    },
  };
  return { db, statements };
}

test('existing-member reconciliation orders summaries by Discord ID and dry runs without effects', async () => {
  const high = member('20', ['Bocconi | Member'], {
    onAdd() {
      throw new Error('dry run must not add roles');
    },
  });
  const low = member('10', ['Bocconi | Member'], {
    onAdd() {
      throw new Error('dry run must not add roles');
    },
  });
  const db = {
    async query() {
      throw new Error('dry run must not query the database');
    },
  };

  const result = await reconcileExistingMembers({
    guild: guildFrom([high, low]),
    rolesByName: roleMap(),
    plan,
    db,
    resources,
    dryRun: true,
  });

  assert.deepEqual(result.members.map((summary) => summary.discordUserId), ['10', '20']);
  assert.equal(result.planned, 2);
  assert.equal(result.changedRoleCount, 2);
  assert.equal(result.skippedDatabase, true);
});

test('existing-member reconciliation set-writes members, divisions, and board assignments', async () => {
  const first = member('10', [
    'Bocconi | Member',
    'Bocconi | Projects',
    'Bocconi | Analysis',
    'Bocconi | President',
  ]);
  const second = member('20', [
    'Bocconi | Member',
    'Bocconi | Projects',
    'Bocconi | Vice-President',
    'Global Admin',
  ]);
  const { db, statements } = recordingDatabase();

  const result = await reconcileExistingMembers({
    guild: guildFrom([second, first]),
    rolesByName: roleMap(),
    plan,
    db,
    resources,
  });

  assert.deepEqual(result.members.map((summary) => summary.discordUserId), ['10', '20']);
  const inserts = statements.filter((statement) => statement.sql.startsWith('INSERT INTO'));
  assert.equal(inserts.filter((statement) => statement.sql.startsWith('INSERT INTO members')).length, 1);
  assert.equal(inserts.filter((statement) => statement.sql.startsWith('INSERT INTO member_divisions')).length, 1);
  assert.equal(inserts.filter((statement) => statement.sql.startsWith('INSERT INTO board_assignments')).length, 1);
  assert.equal(statements.length, 7);
  const boardInsert = inserts.find((statement) => statement.sql.startsWith('INSERT INTO board_assignments'));
  assert.equal(boardInsert.params.length, 15);
  const divisionInsert = inserts.find((statement) => statement.sql.startsWith('INSERT INTO member_divisions'));
  assert.equal(divisionInsert.params.length, 6);
});

test('existing-member reconciliation bounds Discord role mutations and reports mixed failures', async () => {
  let inFlight = 0;
  let peakConcurrency = 0;
  const members = ['1', '2', '3', '4', '5'].map((id) => member(id, ['Bocconi | Member'], {
    async onAdd() {
      inFlight += 1;
      peakConcurrency = Math.max(peakConcurrency, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (id === '3') throw new Error('Discord rate limit for member 3');
    },
  }));
  const { db, statements } = recordingDatabase();

  let error;
  try {
    await reconcileExistingMembers({
      guild: guildFrom(members),
      rolesByName: roleMap(),
      plan,
      db,
      resources,
      discordConcurrency: 2,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error);
  assert.equal(error.name, 'AggregateError');
  assert.equal(peakConcurrency, 2);
  assert.deepEqual(
    error.reconciliation.roleResults.map(({ discordUserId, status }) => ({ discordUserId, status })),
    [
      { discordUserId: '1', status: 'applied' },
      { discordUserId: '2', status: 'applied' },
      { discordUserId: '3', status: 'failed' },
      { discordUserId: '4', status: 'applied' },
      { discordUserId: '5', status: 'applied' },
    ],
  );
  const memberInsert = statements.find((statement) => statement.sql.startsWith('INSERT INTO members'));
  assert.equal(memberInsert.params.filter((value) => value === 'researcher').length, 4);
});
