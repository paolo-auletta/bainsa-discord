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
  assert.match(startHereSeeds().welcome, /Division rooms.*Researcher work/i);
  assert.match(startHereSeeds().welcome, /Alumni use university-level spaces/i);
  assert.match(startHereSeeds().welcome, /People database.*opt-in member profiles/i);
  assert.match(globalSeeds().peopleDirectory, /^# People Database\n/);
  assert.match(globalSeeds().peopleDirectory, /Browse the directory/);
  assert.match(globalSeeds().peopleDirectory, /member’s BAINSA path, university, and applicable division/);
  assert.match(globalSeeds().peopleDirectory, /one canonical post/);
  assert.match(globalSeeds().peopleDirectory, /BAINSA university tag is added automatically/);
  assert.doesNotMatch(globalSeeds().peopleDirectory, /Researcher or Alumni tag is added automatically/);
  assert.ok(startHereSeeds().welcome.length <= 2_000);
});

test('space topics make the active scope and posting boundary durable', () => {
  assert.match(startHereTopics().welcome, /Find my spaces/i);
  assert.match(globalTopics().general, /^GLOBAL BAINSA/);
  assert.match(globalTopics().general, /university category/i);
  assert.match(universityTopics('Bocconi').general, /^BAINSA BOCCONI/);
  assert.match(universityTopics('Bocconi').botLog, /scoped only to Bocconi/i);
  assert.match(divisionTopic('Bocconi', 'Analysis'), /BAINSA BOCCONI.*Analysis division/s);
});
