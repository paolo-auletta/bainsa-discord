export async function writeAudit(db, entry) {
  const {
    actorId,
    action,
    targetType,
    targetId = null,
    universityId = null,
    before = null,
    after = null,
    reason = null,
  } = entry;

  await db.query(
    `INSERT INTO audit_log
      (actor_discord_user_id, action, target_type, target_id, university_id, before_state, after_state, reason)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      actorId,
      action,
      targetType,
      targetId == null ? null : String(targetId),
      universityId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      reason,
    ],
  );
}
