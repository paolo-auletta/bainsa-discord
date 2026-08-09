import assert from 'node:assert/strict';
import test from 'node:test';

import { formatProfilePost, formatProfileSummary, profileThreadName } from '../src/profiles/formatters.js';

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

test('profile formatter uses the exact review summary in one starter card', () => {
  const formatted = formatProfilePost({ ...profile, member, updated_at: '2026-08-08T10:30:00.000Z' });
  assert.equal(formatted.threadName, 'Ada Lovelace — Researcher building practical AI systems');
  assert.equal(
    formatted.content,
    formatProfileSummary(profile, { discordUserId: member.discord_user_id }),
  );
  assert.match(formatted.content, /🪪 \*\*Where you are now\*\*/);
  assert.match(formatted.content, /🧭 \*\*What you want to explore\*\*/);
  assert.match(formatted.content, /💬 \*\*How members can reach you\*\*/);
  assert.match(formatted.content, /\*\*Discord\*\* · <@123456789012345678>/);
  assert.match(formatted.content, /\*\*Tags\*\* · AI & Data, Academia$/);
  assert.equal((formatted.content.match(/🪪|🧭|💬/gu) ?? []).length, 3);
  assert.doesNotMatch(formatted.content, /Discoverability|💼|🏢|📍|💡|✉️|🔗|🔬|🏷️/u);
  assert.equal('sections' in formatted, false);
  assert.deepEqual(formatted.appliedTagKeys, ['bocconi', 'ai_data', 'academia']);
  assert.deepEqual(formatted.appliedTagLabels, ['Bocconi', 'AI & Data', 'Academia']);
  assert.deepEqual(formatted.allowedMentions, { parse: [] });
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
