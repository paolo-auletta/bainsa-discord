import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOARD_ACTIVITY_COMMANDS,
  formatBoardActivity,
} from '../src/activity/formatters.js';

function embedJson(payload) {
  return payload.embeds[0].toJSON();
}

function fieldValue(embed, name) {
  return embed.fields.find((field) => field.name === name)?.value;
}

const actorId = '900';
const target = { id: '100' };
const university = { name: 'Bocconi' };
const division = { name: 'Culture' };

test('activity policy contains every state-changing command and no lookup command', () => {
  assert.deepEqual([...BOARD_ACTIVITY_COMMANDS].sort(), [
    'board-assign',
    'board-remove',
    'division-add-member',
    'division-create',
    'division-remove-member',
    'division-update',
    'member-remove',
    'member-update',
    'project-add-member',
    'project-close',
    'project-create',
    'project-remove-member',
    'project-update',
  ]);
  for (const command of ['guide', 'member-info', 'board-info', 'project-info']) {
    assert.equal(formatBoardActivity(command, { actorId, result: {} }), null);
  }
});

test('member update shows only visible before-and-after changes', () => {
  const payload = formatBoardActivity('member-update', {
    actorId,
    result: {
      target,
      university,
      memberType: 'alumni',
      divisions: [],
      previousRecord: { member_type: 'researcher', university_name: 'Bocconi' },
      previousDivisions: [division],
    },
  });
  const changes = fieldValue(embedJson(payload), 'Changes');
  assert.match(changes, /Researcher → Alumni/);
  assert.match(changes, /Culture → None/);
});

test('notes-only member updates do not create board activity', () => {
  assert.equal(
    formatBoardActivity('member-update', {
      actorId,
      result: {
        target,
        university,
        memberType: 'researcher',
        divisions: [division],
        previousRecord: { member_type: 'researcher', university_name: 'Bocconi' },
        previousDivisions: [division],
        notes: 'PRIVATE NOTE',
      },
    }),
    null,
  );
});

test('division and board activity use consistent action, scope, and role fields', () => {
  const divisionPayload = formatBoardActivity('division-create', {
    actorId,
    result: {
      university,
      divisionName: 'Culture',
      head: target,
      textChannel: { id: '200' },
      voiceChannel: null,
    },
  });
  const divisionEmbed = embedJson(divisionPayload);
  assert.equal(divisionEmbed.title, '🟢 Division created');
  assert.equal(fieldValue(divisionEmbed, 'Division'), 'Culture');
  assert.match(fieldValue(divisionEmbed, 'Channels created'), /<#200>/);
  assert.match(fieldValue(divisionEmbed, 'Channels created'), /Voice: No/);

  const boardPayload = formatBoardActivity('board-assign', {
    actorId,
    result: { target, university, division, role: 'head' },
  });
  const boardEmbed = embedJson(boardPayload);
  assert.equal(boardEmbed.title, '🟢 Board role assigned');
  assert.equal(fieldValue(boardEmbed, 'Member'), '<@100>');
  assert.equal(fieldValue(boardEmbed, 'Scope'), 'Bocconi › Culture');
  assert.equal(fieldValue(boardEmbed, 'Role'), 'Head of Culture');
});

test('activity keeps a member display name when Discord cannot resolve their bot-log mention', () => {
  const nonBoardMember = {
    id: '100',
    displayName: 'Sellaceo',
    user: { username: 'sellaceo' },
  };

  for (const command of ['board-assign', 'board-remove']) {
    const payload = formatBoardActivity(command, {
      actorId,
      result: { target: nonBoardMember, university, division, role: 'head' },
    });

    assert.equal(
      fieldValue(embedJson(payload), 'Member'),
      'Sellaceo (<@100>)',
      `${command} should retain both the display name and native mention`,
    );
  }
});

test('division update activity reports a color-only change without inventing a name change', () => {
  const payload = formatBoardActivity('division-update', {
    actorId,
    result: {
      university,
      oldName: 'Culture',
      newName: 'Culture',
      oldColor: 'pink',
      newColor: 'green',
    },
  });
  const embed = embedJson(payload);

  assert.equal(embed.title, '🟠 Division updated');
  assert.equal(fieldValue(embed, 'Division'), 'Culture');
  assert.equal(fieldValue(embed, 'Color'), 'Pink → Green');
});

test('project creation lists the team and reports pending Discord reconciliation accurately', () => {
  const payload = formatBoardActivity('project-create', {
    actorId,
    result: {
      name: 'Spring Festival',
      university_name: 'Bocconi',
      division_name: 'Culture',
      start_date: '2026-09-01',
      expected_end: '2026-12-15',
      reconciliation_pending: true,
      notes: 'PRIVATE PROJECT NOTE',
      people: [
        { discord_user_id: '100', role: 'member', user: { username: 'Sellaceo' } },
        { discord_user_id: '101', role: 'supervisor' },
      ],
    },
  });
  const embed = embedJson(payload);
  assert.equal(fieldValue(embed, 'Members'), 'Sellaceo (<@100>)');
  assert.equal(fieldValue(embed, 'Supervisors'), '<@101>');
  assert.match(fieldValue(embed, 'Discord state'), /in progress/);
  assert.doesNotMatch(JSON.stringify(embed), /PRIVATE PROJECT NOTE/);
});

test('project participant role changes and project field changes use old-to-new values', () => {
  const participant = formatBoardActivity('project-add-member', {
    actorId,
    result: {
      project: {
        name: 'Spring Festival',
        university_name: 'Bocconi',
        division_name: 'Culture',
        reconciliation_pending: false,
      },
      participant: { userId: '100', user: { username: 'Sellaceo' }, role: 'supervisor', previousRole: 'member' },
    },
  });
  assert.equal(embedJson(participant).title, '🟠 Project participant updated');
  assert.match(fieldValue(embedJson(participant), 'Participant'), /Sellaceo \(<@100>\)/);
  assert.match(fieldValue(embedJson(participant), 'Participant'), /Member → Supervisor/);

  const updated = formatBoardActivity('project-update', {
    actorId,
    result: {
      before: {
        name: 'Spring Festival',
        expected_end: '2026-12-15',
        status: 'active',
      },
      project: {
        name: 'Spring Festival',
        university_name: 'Bocconi',
        division_name: 'Culture',
        expected_end: '2026-12-22',
        status: 'paused',
        reconciliation_pending: false,
      },
    },
  });
  const changes = fieldValue(embedJson(updated), 'Changes');
  assert.match(changes, /2026-12-15 → 2026-12-22/);
  assert.match(changes, /Active → Paused/);
});

test('reapplying the same project role does not create a board activity entry', () => {
  assert.equal(
    formatBoardActivity('project-add-member', {
      actorId,
      result: {
        project: {
          name: 'Spring Festival',
          university_name: 'Bocconi',
          division_name: 'Culture',
        },
        participant: { userId: '100', role: 'member', previousRole: 'member' },
      },
    }),
    null,
  );
});

test('notes-only project updates do not create activity and close messages omit final notes', () => {
  assert.equal(
    formatBoardActivity('project-update', {
      actorId,
      result: {
        before: { name: 'Project', expected_end: '2026-12-15', status: 'active' },
        project: {
          name: 'Project',
          university_name: 'Bocconi',
          division_name: 'Culture',
          expected_end: '2026-12-15',
          status: 'active',
        },
      },
    }),
    null,
  );

  const closed = formatBoardActivity('project-close', {
    actorId,
    result: {
      project: {
        name: 'Project',
        university_name: 'Bocconi',
        division_name: 'Culture',
        discord_channel_id: '300',
        reconciliation_pending: false,
        final_notes: 'PRIVATE FINAL NOTES',
      },
      outcome: 'Delivered successfully',
      finalNotes: 'PRIVATE FINAL NOTES',
    },
  });
  const serialized = JSON.stringify(embedJson(closed));
  assert.match(serialized, /Delivered successfully/);
  assert.match(serialized, /<#300>/);
  assert.doesNotMatch(serialized, /PRIVATE FINAL NOTES/);
});
