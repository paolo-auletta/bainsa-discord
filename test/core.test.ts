import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDivisionAuthority,
  assertNoBotCommandTarget,
  assertNotBotUser,
  assertUniversityAuthority,
  isGlobalPresident,
} from '../src/authorization.js';
import { BOARD_ROLES, ROLE_COLORS, ROLE_NAMES } from '../src/constants.js';
import { buildSeedContent } from '../src/content/seeds.js';
import { UserFacingError } from '../src/errors.js';
import {
  divisionHeadRoleName,
  divisionRoleName,
  projectChannelName,
  slugify,
  universityCategoryName,
} from '../src/naming.js';
import { assertDateOrder, parseIsoDate } from '../src/validation.js';

function memberWithRoles(...names) {
  return {
    roles: {
      cache: {
        some: (predicate) => names.some((name) => predicate({ name })),
      },
    },
  };
}

test('role and channel naming follows the approved model', () => {
  assert.equal(divisionRoleName('Sapienza', 'Robotics'), 'Sapienza - Robotics');
  assert.equal(divisionHeadRoleName('Sapienza', 'Robotics'), 'Sapienza - Head of Robotics');
  assert.equal(universityCategoryName('Bocconi'), 'BAINSA BOCCONI');
  assert.equal(slugify('AI Safety & Governance'), 'ai-safety-governance');
  assert.equal(projectChannelName(42, 'AI Safety & Governance'), 'project-42-ai-safety-governance');
});

test('global president bypasses university and division scope', () => {
  const member = memberWithRoles('Global President');
  assert.equal(isGlobalPresident(member), true);
  assert.doesNotThrow(() => assertUniversityAuthority(member, 'Bocconi', []));
  assert.doesNotThrow(() => assertDivisionAuthority(member, 'Bocconi', 'Analysis', []));
});

test('university and division authority stays scoped', () => {
  const president = memberWithRoles('Bocconi - President');
  assert.doesNotThrow(() =>
    assertUniversityAuthority(president, 'Bocconi', [BOARD_ROLES.PRESIDENT]),
  );
  assert.throws(
    () => assertUniversityAuthority(president, 'Sapienza', [BOARD_ROLES.PRESIDENT]),
    UserFacingError,
  );

  const head = memberWithRoles('Bocconi - Head of Analysis');
  assert.doesNotThrow(() =>
    assertUniversityAuthority(head, 'Bocconi', [BOARD_ROLES.HEAD]),
  );
  assert.throws(
    () => assertUniversityAuthority(head, 'Sapienza', [BOARD_ROLES.HEAD]),
    UserFacingError,
  );
  assert.doesNotThrow(() =>
    assertDivisionAuthority(head, 'Bocconi', 'Analysis', [BOARD_ROLES.HEAD]),
  );
  assert.throws(
    () => assertDivisionAuthority(head, 'Bocconi', 'Projects', [BOARD_ROLES.HEAD]),
    UserFacingError,
  );
});

test('commands cannot target the bot account directly or in project participant lists', () => {
  const interaction = {
    client: { user: { id: '99999999999999999' } },
    options: {
      data: [{ type: 6, name: 'user', value: '99999999999999999' }],
    },
  };

  assert.throws(() => assertNoBotCommandTarget(interaction), UserFacingError);
  assert.throws(
    () => assertNoBotCommandTarget({
      ...interaction,
      options: { data: [{ type: 3, name: 'members', value: '<@99999999999999999>' }] },
    }),
    /cannot be managed or assigned/,
  );
  assert.throws(
    () => assertNotBotUser(interaction, '99999999999999999'),
    /cannot be managed or assigned/,
  );
  assert.doesNotThrow(() => assertNotBotUser(interaction, '88888888888888888'));
});

test('seed content is human-readable without an internal marker', () => {
  const content = buildSeedContent({ key: 'start:welcome', title: 'Welcome', body: 'Hello.' });
  assert.equal(content, '# Welcome\n\nHello.');
  assert.equal(content.includes('bainsa:seed'), false);
});

test('role color contract matches the university and membership model', () => {
  assert.equal(ROLE_COLORS.BOCCONI, '#D7263D');
  assert.equal(ROLE_COLORS.SAPIENZA, '#F2C94C');
  assert.equal(ROLE_COLORS.POLIMI, '#2F80ED');
  assert.equal(ROLE_COLORS.GLOBAL_PRESIDENT, '#F2994A');
  assert.equal(ROLE_COLORS.RESEARCHER, '#7A7A7A');
  assert.equal(ROLE_COLORS.ALUMNI, '#27AE60');
  assert.equal(ROLE_NAMES.BOT, 'Bot');
});

test('ISO dates are strict and ordered', () => {
  assert.equal(parseIsoDate('2026-09-01', 'start_date'), '2026-09-01');
  assert.throws(() => parseIsoDate('2026-02-30', 'start_date'), UserFacingError);
  assert.doesNotThrow(() => assertDateOrder('2026-09-01', '2026-12-15'));
  assert.throws(() => assertDateOrder('2026-12-15', '2026-09-01'), UserFacingError);
});
