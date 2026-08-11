import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  MESSAGE_COLORS,
  normalizeUserReference,
  renderBotMessage,
  renderEventCard,
  renderHandoffMessage,
  renderInteractionPanel,
  renderWorkspaceDocument,
  userReference,
} from '../src/messages/index.js';

function componentJson(payload) {
  return payload.components.map((component) => component.toJSON?.() ?? component);
}

function componentText(payload) {
  const queue = [...componentJson(payload)];
  const values = [];
  while (queue.length > 0) {
    const component = queue.shift();
    if (component.type === ComponentType.TextDisplay) values.push(component.content);
    if (component.components) queue.push(...component.components);
  }
  return values.join('\n');
}

function allComponents(payload) {
  const queue = [...componentJson(payload)];
  const values = [];
  while (queue.length > 0) {
    const component = queue.shift();
    values.push(component);
    if (component.components) queue.push(...component.components);
  }
  return values;
}

function containerChildren(payload) {
  const root = componentJson(payload)[0];
  assert.equal(root.type, ComponentType.Container);
  return root.components;
}

test('event cards enforce semantic color, title marker, field order, and embed limits', () => {
  const payload = renderEventCard({
    kind: 'event-card',
    tone: 'danger',
    title: 'Board role removed',
    subject: { label: 'Member', value: '<@member>' },
    scope: 'Bocconi › Projects',
    details: [{ label: 'Role', value: 'Head of Projects' }],
    result: { label: 'Result', value: 'Role access removed' },
    discordState: 'Discord roles reconciled',
    actor: '<@actor>',
    description: 'x'.repeat(5_000),
    footer: 'Board activity',
  });

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const embed = JSON.parse(JSON.stringify(payload.embeds[0]));
  assert.equal(embed.color, MESSAGE_COLORS.danger);
  assert.equal(embed.title, '🔴 Board role removed');
  assert.deepEqual(embed.fields.map((field) => field.name), [
    'Member',
    'Scope',
    'Role',
    'Result',
    'Discord state',
    'Performed by',
  ]);
  const characterCount = embed.title.length
    + embed.description.length
    + embed.footer.text.length
    + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert.ok(characterCount <= 6_000);
});

test('user references normalize direct users and fall back without stringifying unresolved objects', () => {
  const directUser = { id: '100', globalName: 'Ada Lovelace', username: 'ada' };
  assert.deepEqual(normalizeUserReference(directUser), {
    id: '100',
    displayName: 'Ada Lovelace',
  });
  assert.equal(userReference(directUser), 'Ada Lovelace (<@100>)');

  const unresolvedUser = { displayName: 'Grace Hopper' };
  assert.deepEqual(normalizeUserReference(unresolvedUser), {
    id: null,
    displayName: 'Grace Hopper',
  });
  assert.equal(userReference(unresolvedUser), 'Grace Hopper');
  assert.equal(userReference({ id: {} }, 'Readable fallback'), 'Readable fallback');
  assert.doesNotMatch(userReference({}), /\[object Object\]/);
});

test('workspace documents render one bounded durable record with provenance', () => {
  const payload = renderWorkspaceDocument({
    kind: 'workspace-document',
    title: 'Signals',
    metadata: [
      { label: 'Status', value: 'Active' },
      { label: 'Workspace', value: '<#workspace>' },
    ],
    sections: [
      { heading: 'Summary', body: 'A durable canonical record.' },
      { heading: 'Notes', body: 'x'.repeat(3_000) },
    ],
    provenance: 'Project #42 · Pinned project record · Updates automatically',
  });

  assert.equal(payload.embeds, undefined);
  assert.equal(payload.components, undefined);
  assert.ok(payload.content.length <= 2_000);
  assert.match(payload.content, /^## Signals/);
  assert.match(payload.content, /\*\*Status:\*\* Active/);
  assert.match(payload.content, /Pinned project record · Updates automatically$/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('interaction panels share a bounded Components V2 structure for controls and outcomes', () => {
  const payload = renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'warning',
    title: 'Remove board role?',
    description: 'Confirm this consequential access change.',
    facts: [
      { label: 'Member', value: '<@member>' },
      { label: 'Scope', value: 'Bocconi' },
    ],
    controls: [{
      kind: 'string-select',
      id: 'role-select',
      placeholder: 'Choose a role',
      options: [{ label: 'President', value: 'president' }],
    }],
    actions: [
      { id: 'confirm', label: 'Remove role', style: 'danger' },
      { id: 'cancel', label: 'Keep role', style: 'secondary' },
    ],
    status: 'Nothing changes until you confirm.',
    audience: 'actor',
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  const container = componentJson(payload)[0];
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.accent_color, MESSAGE_COLORS.warning);
  assert.ok(container.components.length <= 10);
  assert.match(componentText(payload), /^\*\*Remove board role\?\*\*/);
  assert.match(componentText(payload), /Nothing changes until you confirm/);
  assert.ok(allComponents(payload).some((component) => component.custom_id === 'role-select'));
  assert.ok(allComponents(payload).some((component) => component.custom_id === 'confirm'));
});

test('interaction panel loading actions are relabeled and disabled by the shared renderer', () => {
  const payload = renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Choose a record',
    actions: [{ id: 'continue', label: 'Continue', style: 'primary', loading: true }],
    audience: 'actor',
  });

  const button = allComponents(payload).find((component) => component.custom_id === 'continue');
  assert.equal(button.label, 'Loading…');
  assert.equal(button.disabled, true);
});

test('interaction panels keep field guidance directly above reusable body controls', () => {
  const payload = renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Edit a division',
    facts: [
      { label: 'Current name', value: 'rsi → RSI' },
      { label: 'Current color', value: 'Red' },
    ],
    detailsDensity: 'compact',
    controls: [
      {
        kind: 'button',
        id: 'edit-name',
        label: 'New name · Research',
        fieldLabel: 'New name',
        description: 'Open the prefilled name field.',
        style: 'primary',
      },
      {
        kind: 'string-select',
        id: 'color',
        placeholder: 'Choose a color',
        label: 'New color',
        description: 'Applied to the managed role and channels.',
        options: [{ label: 'Blue', value: 'blue', selected: true }],
      },
    ],
    contentActionsLabel: {
      label: 'Private notes',
      description: 'Visible only in authorized governance workflows.',
    },
    contentActions: [{ id: 'notes', label: 'Edit private notes', style: 'primary' }],
    actions: [{ id: 'continue', label: 'Continue' }],
    audience: 'actor',
  });

  const children = containerChildren(payload);
  const rowFor = (id) => children.findIndex((child) =>
    child.components?.some((component) => component.custom_id === id));
  for (const [id, label] of [['edit-name', 'New name'], ['color', 'New color'], ['notes', 'Private notes']]) {
    const index = rowFor(id);
    assert.ok(index > 0);
    assert.equal(children[index - 1].type, ComponentType.TextDisplay);
    assert.match(children[index - 1].content, new RegExp(`^\\*\\*${label}\\*\\*`));
  }
  assert.match(componentText(payload), /\*\*Current name:\*\* rsi → RSI\n\*\*Current color:\*\* Red/);
  assert.match(componentText(payload), /Visible only in authorized governance workflows/);
  assert.ok(rowFor('notes') < rowFor('continue'));
  assert.ok(allComponents(payload).length <= 40);
});

test('handoff messages stay direct, no-ping, bounded, and limited to three next actions', () => {
  const payload = renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'success',
    title: 'You joined Signals',
    context: 'Bocconi · Projects',
    sections: [{ heading: 'Role', body: 'Supervisor' }],
    nextActions: ['Open the workspace.', 'Read the pinned record.', 'Welcome the team.', 'Hidden fourth step.'],
    links: [{ label: 'Open workspace', url: 'https://discord.com/channels/guild/workspace' }],
    provenance: 'Project #42 · Access handoff',
  });

  assert.ok(payload.content.length <= 2_000);
  assert.match(payload.content, /^\*\*You joined Signals\*\*/);
  assert.match(payload.content, /3\. Welcome the team\./);
  assert.doesNotMatch(payload.content, /Hidden fourth step/);
  assert.match(payload.content, /Project #42 · Access handoff$/);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('the polymorphic renderer selects each primitive from its kind contract', () => {
  const payload = renderBotMessage({
    kind: 'workspace-document',
    title: 'Guide',
    provenance: 'Pinned guide',
  });
  assert.match(payload.content, /^## Guide/);
});
