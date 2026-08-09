import assert from 'node:assert/strict';
import test from 'node:test';

import { globalSeeds, startHereSeeds } from '../src/content/seeds.js';

test('member-facing seed content matches division and directory taxonomy rules', () => {
  assert.match(startHereSeeds().welcome, /Onboarding starts you in one division/);
  assert.match(startHereSeeds().welcome, /board can add further division access/);
  assert.match(globalSeeds().peopleDirectory, /BAINSA university tag is added automatically/);
  assert.doesNotMatch(globalSeeds().peopleDirectory, /Researcher or Alumni tag is added automatically/);
});
