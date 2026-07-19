export async function insertProjectPeople(db, projectId, people) {
  if (people.length === 0) return;

  await db.query(
    `INSERT INTO project_people (project_id, discord_user_id, role)
     SELECT $1, people.discord_user_id, people.role
     FROM unnest($2::text[], $3::text[]) AS people(discord_user_id, role)
     ON CONFLICT (project_id, discord_user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [
      projectId,
      people.map((person) => String(person.discord_user_id)),
      people.map((person) => person.role),
    ],
  );
}

export async function lockProjectAndCountPeople(db, projectId) {
  await db.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  const result = await db.query(
    'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1',
    [projectId],
  );
  return Number(result.rows[0].count);
}
