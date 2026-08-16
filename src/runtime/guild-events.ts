/** Returns whether a guild lifecycle event belongs to this BAINSA deployment. */
export function isConfiguredGuildEvent(member, configuredGuildId) {
  return Boolean(
    member?.guild?.id
      && configuredGuildId
      && String(member.guild.id) === String(configuredGuildId),
  );
}
