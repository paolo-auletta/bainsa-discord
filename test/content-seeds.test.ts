import assert from 'node:assert/strict';
import test from 'node:test';

import {
  divisionTopic,
  globalSeeds,
  globalTopics,
  startHereSeeds,
  startHereTopics,
  universityTopics,
} from '../src/content/seeds.js';

test('member-facing seed content matches division and directory taxonomy rules', () => {
  assert.match(startHereSeeds().welcome, /Onboarding starts you in one division/);
  assert.match(startHereSeeds().welcome, /board can add further division access/);
  assert.match(startHereSeeds().welcome, /People database.*opt-in member profiles/i);
  assert.match(globalSeeds().peopleDirectory, /^# People Database\n/);
  assert.match(globalSeeds().peopleDirectory, /BAINSA university tag is added automatically/);
  assert.doesNotMatch(globalSeeds().peopleDirectory, /Researcher or Alumni tag is added automatically/);
});

test('space topics make the active scope and posting boundary durable', () => {
  assert.match(startHereTopics().welcome, /Find my spaces/i);
  assert.match(globalTopics().general, /^GLOBAL BAINSA/);
  assert.match(globalTopics().general, /university category/i);
  assert.match(universityTopics('Bocconi').general, /^BAINSA BOCCONI/);
  assert.match(universityTopics('Bocconi').botLog, /scoped only to Bocconi/i);
  assert.match(divisionTopic('Bocconi', 'Analysis'), /BAINSA BOCCONI.*Analysis division/s);
});
