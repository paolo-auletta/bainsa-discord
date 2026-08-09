import assert from 'node:assert/strict';
import test from 'node:test';
import { ButtonStyle, ComponentType } from 'discord.js';

import {
  applicationStatusPayload,
  confirmPayload,
  divisionPayload,
  memberSpacesPayload,
  memberTypePayload,
  onboardingStartPayload,
  onboardingSubmittingPayload,
  reviewPayload,
  reviewedPayload,
  universityPayload,
} from '../src/onboarding/components.js';
import { PROFILE_CUSTOM_IDS } from '../src/profiles/custom-ids.js';

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

test('onboarding confirmation presents a clear stacked application summary', () => {
  const payload = confirmPayload(
    '10',
    { full_name: 'Ada *Lovelace*', member_type: 'researcher' },
    university,
    [{ id: '2', name: 'Analysis', color: 'orange' }],
  );
  const embed = payload.embeds[0].toJSON();
  const actions = payload.components[0].toJSON();

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.flags, undefined);
  assert.equal(embed.title, 'Review your application');
  assert.equal(
    embed.description,
    [
      'Please check these details before sending your request to the university board.',
      '',
      '**Applicant**',
      'Ada \\*Lovelace\\*',
      '',
      '**Path**',
      '🔬 Researcher',
      '',
      '**University**',
      'Bocconi',
      '',
      '**Division**',
      '🟧 Analysis',
    ].join('\n'),
  );
  assert.equal(embed.fields, undefined);
  assert.deepEqual(actions.components.map((button) => button.label), [
    'Submit application',
    'Back to division',
    'Cancel',
  ]);
  assert.equal(actions.components[0].style, ButtonStyle.Success);
});

test('every editable onboarding screen provides next, back, and cancel actions', () => {
  const payloads = [
    memberTypePayload('10', 'researcher'),
    universityPayload('10', [university], 0, '1', 'researcher'),
    divisionPayload('10', [{ id: '2', name: 'Analysis', color: 'orange' }], ['2']),
    confirmPayload(
      '10',
      { full_name: 'Ada Lovelace', member_type: 'researcher' },
      university,
      [{ id: '2', name: 'Analysis', color: 'orange' }],
    ),
  ];

  for (const payload of payloads) {
    const buttons = payload.components.at(-1).toJSON().components as Array<{
      label?: string;
      style?: number;
    }>;
    assert.equal(buttons.length, 3);
    assert.match(buttons[0].label, /^(Continue|Submit)/);
    assert.match(buttons[1].label, /^Back to/);
    assert.equal(buttons[2].label, 'Cancel');
    assert.equal(buttons[2].style, ButtonStyle.Danger);
  }
});

test('member path uses one native select with concise role descriptions instead of color-coded buttons', () => {
  const payload = memberTypePayload('10', 'researcher');
  const embed = payload.embeds[0].toJSON();
  const menu = payload.components[0].toJSON().components[0];

  assert.doesNotMatch(embed.description, /Selected:/);
  assert.match(embed.description, /Researcher.*active BAINSA member/i);
  assert.match(embed.description, /Alumni.*former BAINSA member/i);
  assert.equal(embed.fields, undefined);
  assert.equal(menu.type, ComponentType.StringSelect);
  assert.equal(menu.placeholder, 'Choose your path');
  assert.deepEqual(
    menu.options.map((option) => option.label),
    [
      'Researcher',
      'Alumni',
    ],
  );
  assert.equal(menu.options[0].default, true);
  assert.equal(menu.options[1].default, false);
});

test('university choice keeps its instruction stable after a selection', () => {
  const payload = universityPayload('10', [university], 0, '1', 'researcher');

  assert.equal(
    payload.embeds[0].data.description,
    'Select the university you currently belong to, or the one you were part of as an Alumni.',
  );
  assert.doesNotMatch(payload.embeds[0].data.description, /Selected:/);
});

test('onboarding start makes application recovery visible below the primary action', () => {
  const payload = onboardingStartPayload();

  assert.equal(payload.components.length, 2);
  assert.equal(payload.components[0].toJSON().components[0].label, 'Begin onboarding');
  assert.equal(payload.components[1].toJSON().components[0].label, 'Check application status');
  assert.match(payload.content, /Already applied/i);
});

test('waiting and decided application states clearly explain what happens next', () => {
  const waiting = onboardingSubmittingPayload();
  assert.match(waiting.embeds[0].data.title, /Submitting/);
  assert.match(waiting.embeds[0].data.description, /message will update/i);
  assert.deepEqual(waiting.components, []);

  const pending = applicationStatusPayload({
    request: { ...reapplication, status: 'pending', university_id: '1', division_ids: [] },
    university,
    divisions: [],
  });
  assert.match(pending.embeds[0].data.description, /Check application status/);
  assert.deepEqual(pending.components, []);

  const rejected = applicationStatusPayload({
    request: { ...reapplication, status: 'rejected', review_reason: 'Please clarify your university.' },
    university,
    divisions: [],
  });
  assert.match(rejected.embeds[0].data.description, /Please clarify your university/);
  assert.equal(rejected.components[0].toJSON().components[0].label, 'Start a new application');
});

test('member-space guide explains channels without restating application details', () => {
  const payload = memberSpacesPayload({
    university,
    divisions: [{ id: '2', name: 'Analysis', color: 'orange', text_channel_id: 'division' }],
    channels: {
      globalGeneral: { id: 'global-general' },
      universityGeneral: { id: 'university-general' },
      division: { id: 'division' },
      resources: { id: 'resources' },
      projectShowcase: { id: 'showcase' },
      peopleDirectory: { id: 'directory' },
    },
  });
  const embed = payload.embeds[0].toJSON();

  assert.equal(embed.author.name, 'BAINSA');
  assert.equal(embed.title, 'Your BAINSA spaces');
  assert.match(embed.description, /Resources.*<#resources>/s);
  assert.match(embed.description, /Projects showcase.*<#showcase>/s);
  assert.match(embed.description, /People directory.*<#directory>/s);
  assert.match(embed.description, /Create a profile in <#directory>/);
  assert.doesNotMatch(embed.description, /application approved|access is active|Applicant|Path/i);
  assert.equal(embed.fields, undefined);
  assert.equal(payload.components[0].toJSON().components[0].custom_id, PROFILE_CUSTOM_IDS.START);

  const published = memberSpacesPayload({ university, profilePublished: true });
  assert.equal(published.components.length, 0);
  assert.doesNotMatch(published.embeds[0].data.description, /Make yourself discoverable/);
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
