import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { governanceCommands } from '../src/commands/governance/index.js';
import { projectCommands } from '../src/commands/projects/index.js';
import * as governanceService from '../src/services/governance/service.js';
import * as projectService from '../src/services/projects/index.js';

const GOVERNANCE_PUBLIC_API = [
  'addDivisionMember',
  'addMember',
  'assignBoardRole',
  'createDivision',
  'divisionChannelName',
  'divisionChannelOverwrites',
  'findDivisions',
  'findUniversities',
  'formatBoardInfo',
  'formatMemberInfo',
  'getBoardInfo',
  'getMemberInfo',
  'invalidateGovernanceAutocompleteCache',
  'memberRemovalCleanupPlan',
  'projectChannelCleanupTargets',
  'removeBoardRole',
  'removeDivisionMember',
  'removeMember',
  'resolveDivisionTextForMemberUpdate',
  'roleNamesForDivisionHead',
  'updateDivision',
  'updateMember',
  'warmGovernanceAutocompleteCache',
];

const PROJECT_PUBLIC_API = [
  'addProjectMember',
  'assertActiveDivisionResearchers',
  'assertActiveUniversityMembers',
  'assertGuildMembers',
  'canViewProject',
  'closeProject',
  'createProject',
  'findProjectDivisions',
  'findProjectParentId',
  'findProjectPeople',
  'findProjectUniversities',
  'getProjectInfo',
  'parseDiscordUserIds',
  'projectIdFromOption',
  'projectInfoMessage',
  'projectSuccessMessage',
  'readProjectCreateOptions',
  'removeProjectMember',
  'searchVisibleProjects',
  'updateProject',
  'validateProjectDates',
  'warmProjectAutocompleteCache',
];

test('service entrypoints preserve their exact public import contracts', () => {
  assert.deepEqual(Object.keys(governanceService).sort(), GOVERNANCE_PUBLIC_API);
  assert.deepEqual(Object.keys(projectService).sort(), PROJECT_PUBLIC_API);
});

test('command modules resolve every workflow and autocomplete handler through the service entrypoints', () => {
  for (const command of [...governanceCommands, ...projectCommands]) {
    assert.equal(typeof command.execute, 'function', `${command.data.name} execute`);
    const hasAutocomplete = command.data.toJSON().options?.some((option) => option.autocomplete);
    if (hasAutocomplete) assert.equal(typeof command.autocomplete, 'function', `${command.data.name} autocomplete`);
  }
});

test('repository modules stay free of Discord runtime objects and imports', async () => {
  for (const path of [
    '../src/services/governance/repository.js',
    '../src/services/projects/repository.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]discord\.js['"]/);
    assert.doesNotMatch(source, /\b(?:guild|interaction)\b/);
  }
});

test('Discord gateway modules stay free of SQL and database clients', async () => {
  for (const path of [
    '../src/services/governance/gateway.js',
    '../src/services/projects/gateway.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\.query\s*\(/);
    assert.doesNotMatch(source, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
  }
});
