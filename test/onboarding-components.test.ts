import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmPayload,
  divisionPayload,
  memberTypePayload,
  reviewPayload,
  reviewedPayload,
  universityPayload,
} from '../src/onboarding/components.js';

const university = { id: '1', name: 'Bocconi' };
const reapplication = {
  id: '10',
  discord_user_id: '100',
  member_type: 'alumni',
  full_name: 'Ada Lovelace',
  previously_removed: true,
  status: 'pending',
};

function fields(payload) {
  return payload.embeds[0].data.fields;
}

test('onboarding review messages clearly flag reapplications from removed members', () => {
  const pending = reviewPayload(reapplication, university, []);
  const reviewed = reviewedPayload(
    { ...reapplication, status: 'approved' },
    university,
    [],
    '200',
  );

  for (const payload of [pending, reviewed]) {
    assert.deepEqual(
      fields(payload).find((field) => field.name === 'Member history'),
      {
        name: 'Member history',
        value: '⚠️ Previously removed from the server; this is a reapplication.',
        inline: false,
      },
    );
  }
});

test('onboarding review messages omit removal history for first-time applicants', () => {
  const payload = reviewPayload({ ...reapplication, previously_removed: false }, university, []);

  assert.equal(fields(payload).some((field) => field.name === 'Member history'), false);
});

test('onboarding embeds omit helper footers and review timestamps', () => {
  const embeds = [
    memberTypePayload('10').embeds[0],
    universityPayload('10', [university]).embeds[0],
    divisionPayload('10', [{ id: '2', name: 'Analysis', color: 'orange' }]).embeds[0],
    confirmPayload('10', { full_name: 'Ada Lovelace', member_type: 'alumni' }, university, []).embeds[0],
    reviewPayload(reapplication, university, []).embeds[0],
    reviewedPayload({ ...reapplication, status: 'approved' }, university, [], '200').embeds[0],
  ];

  for (const embed of embeds) {
    assert.equal(embed.data.footer, undefined);
    assert.equal(embed.data.timestamp, undefined);
  }
});
