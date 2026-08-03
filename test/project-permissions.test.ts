import test from 'node:test';
import assert from 'node:assert/strict';

import { OverwriteType, PermissionFlagsBits } from 'discord.js';

import {
  buildProjectPermissionOverwrites,
  projectPersonIdsByRole,
} from '../src/services/projects/permissions.js';
import { PROJECT_PERSON_ROLES } from '../src/constants.js';

function overwriteFor(overwrites, id) {
  return overwrites.find((overwrite) => overwrite.id === id);
}

test('project overwrites deny everyone and grant scoped people plus board roles', () => {
  const overwrites = buildProjectPermissionOverwrites({
    guildId: 'guild',
    memberIds: ['member'],
    supervisorIds: ['supervisor'],
    boardLiaisonIds: ['liaison'],
    boardRoleIds: ['head-role', 'president-role'],
    globalPresidentRoleId: 'global-role',
    botRoleId: 'bot-role',
  });

  assert.deepEqual(overwriteFor(overwrites, 'guild').deny, [PermissionFlagsBits.ViewChannel]);
  assert.equal(overwriteFor(overwrites, 'guild').type, OverwriteType.Role);
  assert.equal(overwriteFor(overwrites, 'member').type, OverwriteType.Member);
  assert.equal(overwriteFor(overwrites, 'supervisor').type, OverwriteType.Member);
  assert.equal(overwriteFor(overwrites, 'liaison').type, OverwriteType.Member);
  assert.equal(overwriteFor(overwrites, 'head-role').type, OverwriteType.Role);
  assert.equal(overwriteFor(overwrites, 'president-role').type, OverwriteType.Role);
  assert.equal(overwriteFor(overwrites, 'global-role').type, OverwriteType.Role);
  assert.equal(overwriteFor(overwrites, 'bot-role').type, OverwriteType.Role);
  assert.ok(overwriteFor(overwrites, 'member').allow.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'member').allow.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(overwriteFor(overwrites, 'member').allow.includes(PermissionFlagsBits.EmbedLinks));
  assert.ok(overwriteFor(overwrites, 'member').allow.includes(PermissionFlagsBits.CreatePublicThreads));
  assert.ok(overwriteFor(overwrites, 'supervisor').allow.includes(PermissionFlagsBits.SendMessages));
  assert.ok(!overwriteFor(overwrites, 'head-role').allow.includes(PermissionFlagsBits.ManageMessages));
  assert.ok(!overwriteFor(overwrites, 'head-role').allow.includes(PermissionFlagsBits.CreatePrivateThreads));
  assert.ok(overwriteFor(overwrites, 'head-role').allow.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(overwriteFor(overwrites, 'global-role').allow.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(overwriteFor(overwrites, 'bot-role').allow.includes(PermissionFlagsBits.SendMessages));
});

test('every project overwrite declares its target type so reconciliation never depends on Discord caches', () => {
  const overwrites = buildProjectPermissionOverwrites({
    guildId: 'guild',
    memberIds: ['member'],
    supervisorIds: ['supervisor'],
    boardLiaisonIds: ['liaison'],
    boardRoleIds: ['head-role', 'president-role'],
    globalPresidentRoleId: 'global-role',
    botRoleId: 'bot-role',
  });

  assert.ok(overwrites.length > 0);
  assert.ok(overwrites.every((overwrite) => overwrite.type === OverwriteType.Role || overwrite.type === OverwriteType.Member));
});

test('locked projects block normal members from sending while supervisors can write', () => {
  const overwrites = buildProjectPermissionOverwrites({
    guildId: 'guild',
    memberIds: ['member'],
    supervisorIds: ['supervisor'],
    locked: true,
  });

  assert.ok(overwriteFor(overwrites, 'member').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(!overwriteFor(overwrites, 'member').allow.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'supervisor').allow.includes(PermissionFlagsBits.SendMessages));
});

test('archived projects block all project people from sending', () => {
  const overwrites = buildProjectPermissionOverwrites({
    guildId: 'guild',
    memberIds: ['member'],
    supervisorIds: ['supervisor'],
    boardLiaisonIds: ['liaison'],
    boardRoleIds: ['head-role'],
    botRoleId: 'bot-role',
    archived: true,
  });

  assert.ok(overwriteFor(overwrites, 'guild').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'guild').deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(overwriteFor(overwrites, 'member').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'member').deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(overwriteFor(overwrites, 'supervisor').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'liaison').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'head-role').deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'head-role').deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  assert.ok(overwriteFor(overwrites, 'bot-role').allow.includes(PermissionFlagsBits.SendMessages));
  assert.ok(overwriteFor(overwrites, 'bot-role').allow.includes(PermissionFlagsBits.SendMessagesInThreads));
});

test('projectPersonIdsByRole groups DB people by project role', () => {
  assert.deepEqual(
    projectPersonIdsByRole([
      { discord_user_id: '1', role: PROJECT_PERSON_ROLES.MEMBER },
      { discord_user_id: '2', role: PROJECT_PERSON_ROLES.SUPERVISOR },
      { discord_user_id: '3', role: PROJECT_PERSON_ROLES.BOARD_LIAISON },
    ]),
    { memberIds: ['1'], supervisorIds: ['2'], boardLiaisonIds: ['3'] },
  );
});
