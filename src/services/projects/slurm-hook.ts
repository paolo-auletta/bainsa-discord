import { assertUser } from '../../errors.js';
import { interactionOutcome, renderInteractionPanel } from '../../messages/index.js';
import { query, transaction } from '../../db.js';
import { canManageProject } from './policy.js';
import { getProject, getProjectPeople } from './repository.js';
import { assertProjectIsOpen } from './validation.js';
import { projectIdFromOption } from './index.js';

export const SLURM_WEBHOOK_NAME = 'BAINSA Slurm';

const DEFAULT_DB = { query, transaction };

// Reuses the bot-owned webhook in the project channel so rerunning the command keeps the same URL.
// `reset` deletes it first, which immediately invalidates any leaked URL.
export async function ensureSlurmWebhook(channel, botUserId, { reset = false } = {}) {
  const existing = (await channel.fetchWebhooks())
    .filter((webhook) => webhook.name === SLURM_WEBHOOK_NAME && webhook.owner?.id === botUserId);
  const reusable = reset ? null : existing.find((webhook) => webhook.token);
  if (reusable) return reusable;
  for (const webhook of existing.values()) await webhook.delete('Slurm notification webhook reset');
  return channel.createWebhook({ name: SLURM_WEBHOOK_NAME, reason: 'Slurm job notifications' });
}

export function slurmSnippet(url: string, pingUserId: string | null = null) {
  const ping = pingUserId ? `<@${pingUserId}>` : '';
  return `# ===== BAINSA Discord notification: paste from here =====
BAINSA_HOOK='${url}'  # REQUIRED, keep private
BAINSA_PING='${ping}'  # OPTIONAL '<@DISCORD_ID>' to ping, '' = no ping
BAINSA_NOTE=''  # OPTIONAL short note, e.g. 'lr=3e-4 seed=2'
BAINSA_ON='all'  # OPTIONAL 'all' or 'fail' (only failures)
bainsa_esc() { printf '%s' "$1" | tr -d '\\000-\\037' | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
bainsa_notify() {
  local rc=$? s c f
  case $rc in
    0) s='✅ COMPLETED'; c=3066993 ;;
    143) s='⏱️ TIMEOUT / CANCELLED'; c=15105570 ;;
    *) s="❌ FAILED (exit $rc)"; c=15158332 ;;
  esac
  [ "$BAINSA_ON" = fail ] && [ $rc -eq 0 ] && return
  f="{\\"name\\":\\"Job ID\\",\\"value\\":\\"\${SLURM_JOB_ID:-local}\\",\\"inline\\":true}"
  f="$f,{\\"name\\":\\"User\\",\\"value\\":\\"$(bainsa_esc "\${SLURM_JOB_USER:-$USER}")\\",\\"inline\\":true}"
  f="$f,{\\"name\\":\\"Runtime\\",\\"value\\":\\"$((SECONDS/3600))h $((SECONDS%3600/60))m $((SECONDS%60))s\\",\\"inline\\":true}"
  f="$f,{\\"name\\":\\"Partition\\",\\"value\\":\\"$(bainsa_esc "\${SLURM_JOB_PARTITION:--}")\\",\\"inline\\":true}"
  f="$f,{\\"name\\":\\"Node\\",\\"value\\":\\"$(bainsa_esc "$(hostname)")\\",\\"inline\\":true}"
  [ -n "$BAINSA_NOTE" ] && f="$f,{\\"name\\":\\"Note\\",\\"value\\":\\"$(bainsa_esc "$BAINSA_NOTE")\\"}"
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\\"username\\":\\"${SLURM_WEBHOOK_NAME}\\",\\"content\\":\\"$(bainsa_esc "$BAINSA_PING")\\",\\"allowed_mentions\\":{\\"parse\\":[\\"users\\"]},\\"embeds\\":[{\\"title\\":\\"$s: $(bainsa_esc "\${SLURM_JOB_NAME:-job}")\\",\\"color\\":$c,\\"fields\\":[$f]}]}" "$BAINSA_HOOK" >/dev/null 2>&1 || true
}
trap bainsa_notify EXIT
trap 'exit 143' TERM
# ===== to here =====`;
}

export function slurmHookMessage(project, url: string, pingUserId: string | null, reset: boolean) {
  return renderInteractionPanel({
    ...interactionOutcome({
      outcome: 'success',
      title: reset ? 'New Slurm webhook created; the old URL no longer works' : 'Slurm job notifications',
      description: [
        `When a Slurm job ends, a message is posted in <#${project.discord_channel_id}>.`,
        '**How to use it**',
        '1. Copy the whole block below.',
        '2. Paste it into your `.sbatch` script **after the `#SBATCH` lines** and **before your real commands** (e.g. `python train.py`). The script must use `#!/bin/bash`.',
        '3. Submit with `sbatch job.sbatch` as usual. Nothing else changes.',
        '4. When the job ends you get ✅ completed, ❌ failed, or ⏱️ timeout/cancelled with the job ID, name, user, runtime, partition, and node.',
        '5. Keep the URL private: anyone who has it can post here. If it leaks, run `/project-slurm-hook reset:True` for a new one.',
      ].join('\n'),
    }),
    sections: [
      { heading: 'Paste this into your Slurm script', body: `\`\`\`bash\n${slurmSnippet(url, pingUserId)}\n\`\`\`` },
      {
        heading: 'Optional settings',
        body: [
          '• `#SBATCH --job-name=my-run`: name shown in Discord (default: the script name).',
          '• `#SBATCH --signal=B:TERM@60`: makes timeouts report reliably.',
          `• \`BAINSA_PING\`: who gets pinged. ${pingUserId ? 'Already set from the `ping` option.' : 'Run the command with `ping:` to fill it in.'}`,
          '• `BAINSA_NOTE`: short text shown with the result, e.g. the hyperparameters.',
          '• `BAINSA_ON=\'fail\'`: only notify when the job fails.',
          '• Filled in automatically: job ID, user, runtime, partition, node, status.',
        ].join('\n'),
      },
      {
        heading: 'Test it now (optional)',
        body: `\`\`\`bash\ncurl -H 'Content-Type: application/json' -d '{"content":"Slurm hook works"}' '${url}'\n\`\`\``,
      },
    ],
  });
}

export async function createSlurmHook(input, deps: { db?: typeof DEFAULT_DB } = {}) {
  const db = deps.db ?? DEFAULT_DB;
  const project = await getProject(db, projectIdFromOption(input.project, input.interaction));
  const people = await getProjectPeople(db, project.id);
  assertUser(
    canManageProject(input.interaction.member, project, people),
    `Only this project's supervisors and scoped board can manage ${project.name}.`,
  );
  assertProjectIsOpen(project.status);
  const channel = project.discord_channel_id
    ? await input.interaction.guild.channels.fetch(project.discord_channel_id).catch(() => null)
    : null;
  assertUser(channel?.fetchWebhooks, 'The project channel is not available yet. Try again shortly.');
  const webhook = await ensureSlurmWebhook(channel, input.interaction.client.user.id, { reset: input.reset });
  return slurmHookMessage(project, webhook.url, input.pingUserId ?? null, Boolean(input.reset));
}
