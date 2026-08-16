import assert from 'node:assert/strict';
import test from 'node:test';

import { formatProfilePost, formatProfileReview, profileThreadName } from '../src/profiles/formatters.js';

const member = Object.freeze({
  discord_user_id: '123456789012345678',
  full_name: 'Ada Lovelace',
  member_type: 'researcher',
  university_name: 'Bocconi',
  division_name: 'Analysis',
});

const profile = Object.freeze({
  headline: 'Researcher building practical AI systems',
  about: 'I enjoy turning difficult research questions into useful tools for people.',
  current_role: 'MSc student',
  goals: 'Explore applied machine learning research collaborations.',
  selected_tags: ['ai_data', 'academia'],
});

test('public profile formatter leads with canonical BAINSA identity in a reader-first hierarchy', () => {
  const formatted = formatProfilePost({ ...profile, member, updated_at: '2026-08-08T10:30:00.000Z' });
  assert.equal(formatted.threadName, 'Ada Lovelace — Researcher building practical AI systems');
  assert.equal(formatted.sections.length, 4);
  assert.equal(formatted.content, formatted.sections.join('\n\n'));
  assert.match(formatted.sections[0], /^## Ada Lovelace/);
  assert.match(formatted.sections[0], /\*\*BAINSA identity\*\*/);
  assert.match(formatted.sections[0], /\*\*Member path\*\* · Researcher/);
  assert.match(formatted.sections[0], /\*\*University\*\* · Bocconi/);
  assert.match(formatted.sections[0], /\*\*Division\*\* · Analysis/);
  assert.match(formatted.content, /\*\*Discord\*\* · <@123456789012345678>/);
  assert.match(formatted.sections[1], /^### Current focus/);
  assert.match(formatted.sections[2], /^### Looking to explore/);
  assert.match(formatted.sections[3], /^### Areas & contact/);
  assert.match(formatted.content, /\*\*Areas\*\* · AI & Data, Academia$/);
  assert.doesNotMatch(formatted.content, /Your BAINSA|Not added|🪪|🧭|💬/u);
  assert.ok(formatted.content.indexOf('**BAINSA identity**') < formatted.content.indexOf('### Current focus'));
  assert.deepEqual(formatted.appliedTagKeys, ['bocconi', 'ai_data', 'academia']);
  assert.deepEqual(formatted.appliedTagLabels, ['Bocconi', 'AI & Data', 'Academia']);
  assert.deepEqual(formatted.allowedMentions, { parse: [] });
});

test('private review stays owner-facing and complete without leaking into the public card', () => {
  const review = formatProfileReview(profile, { discordUserId: member.discord_user_id });
  assert.match(review, /^## Your BAINSA profile/);
  assert.match(review, /🪪 \*\*Where you are now\*\*/);
  assert.match(review, /🧭 \*\*Where you want to go\*\*/);
  assert.match(review, /💬 \*\*How members can reach you\*\*/);
  assert.match(review, /\*\*Email\*\* · Not added/);
});

test('alumni cards omit division instead of rendering an empty canonical fact', () => {
  const formatted = formatProfilePost({
    ...profile,
    member: { ...member, member_type: 'alumni', division_name: null },
  });
  assert.match(formatted.sections[0], /\*\*Member path\*\* · Alumni/);
  assert.match(formatted.sections[0], /\*\*University\*\* · Bocconi/);
  assert.doesNotMatch(formatted.content, /Division|None|Not added/);
});

test('profile formatter escapes authored markdown, keeps mentions inert, and renders optional contact cleanly', () => {
  const formatted = formatProfilePost({
    ...profile,
    headline: '# @everyone [Click](https://malicious.test) *now*',
    about: 'This is long enough to include `code`, > quotes, and @here safely.',
    current_organization: 'Research *Lab*',
    location: 'Milan',
    email: 'ada@example.com',
    linkedin_url: 'https://www.linkedin.com/in/ada',
    research_profile_url: 'https://orcid.org/0000-0001',
    member: { ...member, full_name: 'Ada [Lovelace]' },
  });
  assert.ok(formatted.content.includes('\\# @everyone \\[Click\\]\\(https://malicious.test\\) \\*now\\*'));
  assert.ok(formatted.content.includes('Research \\*Lab\\*'));
  assert.ok(formatted.content.includes('`code`'.replace(/`/g, '\\`')));
  assert.match(formatted.content, /ada@example\.com/);
  assert.match(formatted.content, /https:\/\/www\.linkedin\.com\/in\/ada/);
  assert.match(formatted.content, /https:\/\/orcid\.org\/0000-0001/);
  assert.ok(formatted.sections.every((section) => section.length <= 4_000));
});

test('thread names and maximum legal profiles remain within Discord limits', () => {
  assert.equal(profileThreadName('A'.repeat(80), 'B'.repeat(80)).length, 100);
  const formatted = formatProfilePost({
    headline: 'h'.repeat(80),
    about: 'a'.repeat(300),
    current_role: 'r'.repeat(80),
    goals: 'g'.repeat(250),
    current_organization: 'o'.repeat(100),
    location: 'l'.repeat(60),
    selected_tags: ['ai_data', 'econ_finance', 'neuroscience', 'entrepreneurship'],
    member: { ...member, full_name: 'N'.repeat(120) },
  });
  assert.ok(formatted.threadName.length <= 100);
  assert.ok(formatted.content.length <= 4_000);
  assert.match(formatted.content, /<@123456789012345678>/);
});
