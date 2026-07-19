import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMBER_TYPES, ROLE_NAMES } from '../src/constants.mjs';
import { UserFacingError } from '../src/errors.mjs';
import { updateMember } from '../src/services/governance/service.mjs';

function cacheFrom(items) {
  const values = new Map(items.map((item) => [String(item.id), item]));
  return {
    find: (predicate) => [...values.values()].find(predicate),
    get: (id) => values.get(String(id)),
    has: (id) => values.has(String(id)),
    set: (id, item) => values.set(String(id), item),
    delete: (id) => values.delete(String(id)),
    some: (predicate) => [...values.values()].some(predicate),
  };
}

function role(id, name) {
  return { id, name, editable: true };
}

function member(id, initialRoles = []) {
  const cache = cacheFrom(initialRoles);
  let adds = 0;
  let removes = 0;
  return {
    id,
    roles: {
      cache,
      async add(entries) {
        adds += 1;
        for (const entry of entries) cache.set(entry.id, entry);
      },
      async remove(entries) {
        removes += 1;
        for (const entry of entries) cache.delete(entry.id);
      },
    },
    mutationCount() {
      return adds + removes;
    },
  };
}

function memberUpdateHarness({
  assignments = [],
  previous = {
    discord_user_id: 'target',
    member_type: MEMBER_TYPES.RESEARCHER,
    university_id: 'bocconi-id',
    university_name: 'Bocconi',
    status: 'active',
    notes: null,
  },
  previousDivisions = [{ id: 'analysis-id', name: 'Analysis', university_id: 'bocconi-id', university_name: 'Bocconi' }],
} = {}) {
  const universities = {
    Bocconi: { id: 'bocconi-id', name: 'Bocconi' },
    Sapienza: { id: 'sapienza-id', name: 'Sapienza' },
  };
  const divisions = {
    'Bocconi:Analysis': { id: 'analysis-id', name: 'Analysis', university_id: 'bocconi-id' },
    'Bocconi:Culture': { id: 'culture-id', name: 'Culture', university_id: 'bocconi-id' },
    'Sapienza:Analysis': { id: 'sapienza-analysis-id', name: 'Analysis', university_id: 'sapienza-id' },
  };
  let transactionCount = 0;
  let roleCreates = 0;
  let projectStatusFilter = null;
  const guildRoles = [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('alumni-role', ROLE_NAMES.ALUMNI),
    role('bocconi-role', 'Bocconi'),
    role('sapienza-role', 'Sapienza'),
    role('analysis-role', 'Bocconi - Analysis'),
    role('culture-role', 'Bocconi - Culture'),
    role('sapienza-analysis-role', 'Sapienza - Analysis'),
    role('global-role', ROLE_NAMES.GLOBAL_PRESIDENT),
  ];
  const target = member('target', guildRoles.filter((entry) => [
    'researcher-role', 'bocconi-role', 'analysis-role', 'culture-role',
  ].includes(entry.id)));
  const actor = member('actor', [role('global-role', ROLE_NAMES.GLOBAL_PRESIDENT)]);
  const guild = {
    roles: {
      cache: cacheFrom(guildRoles),
      async create() {
        roleCreates += 1;
        throw new Error('Discord role creation must not be reached for this test.');
      },
    },
    members: {
      async fetch(id) {
        if (String(id) === target.id) return target;
        throw new Error('Unknown mocked member');
      },
    },
  };
  const db = {
    async query(text, values) {
      if (text.includes('FROM members m')) return { rows: [previous] };
      if (text.includes('FROM member_divisions md')) return { rows: previousDivisions };
      if (text.includes('FROM universities')) {
        const university = universities[values[0]];
        return { rowCount: university ? 1 : 0, rows: university ? [university] : [] };
      }
      if (text.includes('FROM board_assignments')) return { rows: [] };
      if (text.includes('FROM divisions')) {
        const university = Object.values(universities).find((entry) => String(entry.id) === String(values[0]));
        const division = divisions[`${university.name}:${values[1]}`];
        return { rowCount: division ? 1 : 0, rows: division ? [division] : [] };
      }
      if (text.includes('FROM project_people pp')) {
        projectStatusFilter = values[1];
        return { rows: assignments };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(work) {
      transactionCount += 1;
      return work({ query: async () => ({ rows: [] }) });
    },
  };

  return {
    deps: { db },
    interaction: { guild, user: { id: actor.id }, member: actor },
    target,
    roleCreates: () => roleCreates,
    transactionCount: () => transactionCount,
    projectStatusFilter: () => projectStatusFilter,
  };
}

async function expectRejectedUpdate(harness, options, projectIds) {
  await assert.rejects(
    updateMember(harness.interaction, { user: { id: 'target' }, ...options }, harness.deps),
    (error) => {
      assert.ok(error instanceof UserFacingError);
      for (const projectId of projectIds) assert.match(error.message, new RegExp(`#${projectId} `));
      assert.match(error.message, /Remove or reassign their project participation first\./);
      return true;
    },
  );
  assert.equal(harness.target.mutationCount(), 0);
  assert.equal(harness.roleCreates(), 0);
  assert.equal(harness.transactionCount(), 0);
}

test('member-update rejects a Researcher to Alumni change for an active project member before side effects', async () => {
  const harness = memberUpdateHarness({
    assignments: [{ id: 42, name: 'Signals', university_id: 'bocconi-id', division_id: 'analysis-id', role: 'member' }],
  });

  await expectRejectedUpdate(harness, { memberType: MEMBER_TYPES.ALUMNI }, [42]);
});

test('member-update rejects a university move for every active project role before side effects', async () => {
  for (const roleName of ['member', 'supervisor', 'board_liaison']) {
    const harness = memberUpdateHarness({
      assignments: [{ id: 43, name: `Project ${roleName}`, university_id: 'bocconi-id', division_id: 'analysis-id', role: roleName }],
    });

    await expectRejectedUpdate(harness, {
      university: 'Sapienza',
      divisionsText: 'Analysis',
    }, [43]);
  }
});

test('member-update rejects removing an active project member division before side effects', async () => {
  const harness = memberUpdateHarness({
    assignments: [{ id: 44, name: 'Analysis Project', university_id: 'bocconi-id', division_id: 'analysis-id', role: 'member' }],
  });

  await expectRejectedUpdate(harness, { divisionsText: 'Culture' }, [44]);
});

test('member-update permits Alumni supervisors and board liaisons in their active project university', async () => {
  for (const roleName of ['supervisor', 'board_liaison']) {
    const harness = memberUpdateHarness({
      assignments: [{ id: 45, name: `Project ${roleName}`, university_id: 'bocconi-id', division_id: 'analysis-id', role: roleName }],
    });

    await updateMember(
      harness.interaction,
      { user: { id: 'target' }, memberType: MEMBER_TYPES.ALUMNI },
      harness.deps,
    );
    assert.equal(harness.transactionCount(), 1);
  }
});

test('member-update names every incompatible active project', async () => {
  const harness = memberUpdateHarness({
    assignments: [
      { id: 46, name: 'Signals', university_id: 'bocconi-id', division_id: 'analysis-id', role: 'member' },
      { id: 47, name: 'Models', university_id: 'bocconi-id', division_id: 'culture-id', role: 'member' },
    ],
  });

  await expectRejectedUpdate(harness, { memberType: MEMBER_TYPES.ALUMNI }, [46, 47]);
});

test('member-update permits compatible division sets and no-op notes-only updates', async () => {
  const assignments = [{ id: 48, name: 'Signals', university_id: 'bocconi-id', division_id: 'analysis-id', role: 'member' }];
  const compatible = memberUpdateHarness({ assignments });
  await updateMember(
    compatible.interaction,
    { user: { id: 'target' }, divisionsText: 'Analysis, Culture' },
    compatible.deps,
  );
  assert.equal(compatible.transactionCount(), 1);

  const noOp = memberUpdateHarness({ assignments });
  await updateMember(
    noOp.interaction,
    { user: { id: 'target' }, notes: 'Clarified profile note' },
    noOp.deps,
  );
  assert.equal(noOp.transactionCount(), 1);
  assert.equal(noOp.target.mutationCount(), 0);
});

test('member-update checks only active and paused project assignments', async () => {
  const harness = memberUpdateHarness();

  await updateMember(
    harness.interaction,
    { user: { id: 'target' }, notes: 'Completed projects do not block this update' },
    harness.deps,
  );

  assert.deepEqual(harness.projectStatusFilter(), ['active', 'paused']);
});
