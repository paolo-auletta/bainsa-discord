#!/usr/bin/env node

import { Client, GatewayIntentBits } from 'discord.js';

import { bainsaEmailPromptPayload } from '../src/bainsa-email/components.js';
import {
  getActiveMembership,
  getBainsaEmailRequest,
  listUnansweredActiveMemberIds,
} from '../src/bainsa-email/repository.js';
import { config } from '../src/config.js';
import { closeDatabase, query } from '../src/db.js';

// Discord rate-limits DM creation; a short pause keeps a backfill well below it.
const SEND_INTERVAL_MS = 1_000;

function valuesFor(option) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === option && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'Sends the @bainsa.ai email question by DM to active members who have not answered it yet.',
    '',
    'Usage:',
    '  npm run bainsa-email:prompt -- --user-id USER_ID [--user-id USER_ID ...] [--dry-run]',
    '  npm run bainsa-email:prompt -- --all-unanswered [--dry-run]',
  ].join('\n'));
  process.exit(0);
}

const dryRun = process.argv.includes('--dry-run');
const allUnanswered = process.argv.includes('--all-unanswered');
const requestedIds = [...new Set(valuesFor('--user-id').map((id) => id.trim()).filter(Boolean))];

if (allUnanswered === (requestedIds.length > 0)) {
  console.error('Pass either --all-unanswered or at least one --user-id.');
  process.exit(1);
}

const db = { query };

async function eligibleTargets() {
  if (allUnanswered) return listUnansweredActiveMemberIds(db);
  const targets = [];
  for (const userId of requestedIds) {
    if (!await getActiveMembership(db, userId)) {
      console.log(`skip ${userId}: not an active member`);
    } else if (await getBainsaEmailRequest(db, userId)) {
      console.log(`skip ${userId}: already answered`);
    } else {
      targets.push(userId);
    }
  }
  return targets;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const summary = { sent: 0, failed: 0 };

try {
  const targets = await eligibleTargets();
  console.log(`${targets.length} member(s) to ask${dryRun ? ' (dry run, nothing sent)' : ''}.`);
  if (!dryRun && targets.length > 0) {
    await client.login(config.discordToken);
    for (const [index, userId] of targets.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
      try {
        const user = await client.users.fetch(userId);
        const { content, components, allowedMentions } = bainsaEmailPromptPayload();
        await user.send({ content, components, allowedMentions });
        summary.sent += 1;
        console.log(`sent ${userId} (${user.username})`);
      } catch (error) {
        summary.failed += 1;
        console.log(`failed ${userId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`Done: ${summary.sent} sent, ${summary.failed} failed.`);
  } else {
    for (const userId of targets) console.log(`would ask ${userId}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.destroy();
  await closeDatabase();
}
