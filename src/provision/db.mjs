const RESOURCE_COLUMNS = Object.freeze({
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
});

export async function upsertProvisionedResources(db, resources, { dryRun = false } = {}) {
  if (!db || dryRun) return { skipped: true, reason: dryRun ? 'dry_run' : 'no_db' };
  const result = { universities: 0, divisions: 0, skipped: false };

  for (const university of resources.universities) {
    const universityRecord = await upsertFlexible(db, 'universities', {
      name: university.name,
      slug: university.slug,
      discord_role_id: university.roleId,
      category_id: university.categoryId,
      announcements_channel_id: university.announcementsChannelId,
      board_channel_id: university.boardChannelId,
      showcase_channel_id: university.showcaseChannelId,
      onboarding_review_channel_id: university.onboardingReviewChannelId,
    });
    university.id = universityRecord?.id ?? university.id;
    result.universities += 1;

    for (const division of university.divisions) {
      const divisionRecord = await upsertFlexible(db, 'divisions', {
        university_id: universityRecord?.id,
        university_slug: university.slug,
        name: division.name,
        slug: division.slug,
        color: division.color,
        member_role_id: division.roleId,
        head_role_id: division.headRoleId,
        text_channel_id: division.textChannelId,
        voice_channel_id: division.voiceChannelId,
      });
      division.id = divisionRecord?.id ?? division.id;
      result.divisions += 1;
    }
  }

  return result;
}

async function upsertFlexible(db, tableName, values) {
  const columns = await existingColumns(db, tableName);
  if (columns.length === 0) return null;

  const usableEntries = Object.entries(values).filter(
    ([column, value]) => columns.includes(column) && value !== undefined,
  );
  if (usableEntries.length === 0) return null;

  const selector = buildSelector(tableName, values, columns);
  const existing = await selectExisting(db, tableName, selector, columns);
  if (existing) {
    await updateExisting(db, tableName, usableEntries, selector);
    return { ...existing, ...Object.fromEntries(usableEntries) };
  }

  const columnNames = usableEntries.map(([column]) => column);
  const params = usableEntries.map(([, value]) => value);
  const placeholders = params.map((_, index) => `$${index + 1}`).join(', ');
  const returning = columns.includes('id') ? ' RETURNING id' : '';
  const inserted = await db.query(
    `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders})${returning}`,
    params,
  );
  return inserted.rows?.[0] ?? Object.fromEntries(usableEntries);
}

async function existingColumns(db, tableName) {
  const result = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1`,
    [tableName],
  );
  const actual = new Set(result.rows.map((row) => row.column_name));
  return (RESOURCE_COLUMNS[tableName] ?? []).filter((column) => actual.has(column));
}

function buildSelector(tableName, values, columns) {
  if (tableName === 'divisions' && columns.includes('university_id') && columns.includes('slug') && values.university_id && values.slug) {
    return { university_id: values.university_id, slug: values.slug };
  }
  if (columns.includes('slug') && values.slug) return { slug: values.slug };
  return { name: values.name };
}

async function selectExisting(db, tableName, selector, columns) {
  const entries = Object.entries(selector).filter(
    ([column, value]) => value !== undefined && columns.includes(column),
  );
  if (entries.length === 0) return null;
  const clauses = entries.map(([column], index) => `${column} = $${index + 1}`).join(' AND ');
  const result = await db.query(`SELECT * FROM ${tableName} WHERE ${clauses} LIMIT 1`, entries.map(([, value]) => value));
  return result.rows?.[0] ?? null;
}

async function updateExisting(db, tableName, entries, selector) {
  const selectorEntries = Object.entries(selector);
  const selectorColumns = new Set(selectorEntries.map(([column]) => column));
  const updates = entries.filter(([column]) => !selectorColumns.has(column));
  if (selectorEntries.length === 0 || updates.length === 0) return;
  const assignments = updates.map(([column], index) => `${column} = $${index + 1}`).join(', ');
  const params = updates.map(([, value]) => value);
  const where = selectorEntries
    .map(([column], index) => `${column} = $${updates.length + index + 1}`)
    .join(' AND ');
  params.push(...selectorEntries.map(([, value]) => value));
  await db.query(
    `UPDATE ${tableName} SET ${assignments} WHERE ${where}`,
    params,
  );
}
