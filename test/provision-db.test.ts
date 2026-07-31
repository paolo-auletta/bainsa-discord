import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertProvisionedResources } from '../src/provision/db.js';

test('upsertProvisionedResources writes canonical post-migration Discord ID columns', async () => {
  const statements = [];
  const tableColumns = {
    universities: [
      'id',
      'name',
      'slug',
      'discord_role_id',
      'category_id',
      'announcements_channel_id',
      'board_channel_id',
      'showcase_channel_id',
      'onboarding_review_channel_id',
    ],
    divisions: [
      'id',
      'university_id',
      'university_slug',
      'name',
      'slug',
      'color',
      'member_role_id',
      'head_role_id',
      'text_channel_id',
      'voice_channel_id',
    ],
  };
  const db = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (sql.includes('information_schema.columns')) {
        return { rows: tableColumns[params[0]].map((column_name) => ({ column_name })) };
      }
      if (sql.startsWith('SELECT * FROM universities')) return { rows: [{ id: 7, slug: params[0] }] };
      if (sql.startsWith('SELECT * FROM divisions')) return { rows: [{ id: 8, slug: params[0] }] };
      return { rows: [] };
    },
  };

  const resources = {
    universities: [
      {
        name: 'Bocconi',
        slug: 'bocconi',
        roleId: 'role',
        categoryId: 'category',
        announcementsChannelId: 'announcements',
        boardChannelId: 'board',
        showcaseChannelId: 'showcase',
        onboardingReviewChannelId: 'review',
        divisions: [
          {
            name: 'Projects',
            slug: 'projects',
            color: 'blue',
            roleId: 'member-role',
            headRoleId: 'head-role',
            textChannelId: 'text',
            voiceChannelId: 'voice',
          },
        ],
      },
    ],
  };

  await upsertProvisionedResources(db, resources);

  const combinedSql = statements.map((statement) => statement.sql).join('\n');
  assert.match(combinedSql, /category_id/);
  assert.match(combinedSql, /announcements_channel_id/);
  assert.match(combinedSql, /showcase_channel_id/);
  assert.match(combinedSql, /member_role_id/);
  assert.match(combinedSql, /head_role_id/);
  assert.match(combinedSql, /color/);
  assert.doesNotMatch(combinedSql, /discord_category_id/);
  assert.doesNotMatch(combinedSql, /discord_showcase_forum_id/);
  assert.doesNotMatch(combinedSql, /discord_access_role_id/);
  assert.equal(resources.universities[0].id, 7);
  assert.equal(resources.universities[0].divisions[0].id, 8);
});
