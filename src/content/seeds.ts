const MARKER_PREFIX = '<!-- bainsa:seed:';

export function seedMarker(key) {
  return `${MARKER_PREFIX}${key} -->`;
}

export function withSeedMarker(key, body) {
  return `${seedMarker(key)}\n${body.trim()}`;
}

export function buildSeedContent({ key, title, body, fields = [] }) {
  void key;
  const fieldText = fields
    .filter((field) => field?.name && field?.value)
    .map((field) => `\n**${field.name}**\n${field.value.trim()}`)
    .join('\n');

  return `# ${title}\n\n${body.trim()}${fieldText}`;
}

export function startHereSeeds() {
  return {
    welcome: buildSeedContent({
      key: 'start:welcome',
      title: 'Welcome to BAINSA',
      body: [
        'BAINSA Discord connects university chapters for research, ideas, and collaboration.',
        '',
        '**Start here**',
        '1. Complete #onboarding to request access.',
        '2. Once approved, use **Find my spaces** to reopen your personal channel guide.',
        '3. Cannot see a channel? Ask in your university general channel.',
        '',
        '**Find the right space**',
        '• **Global BAINSA** — cross-university conversation and shared knowledge.',
        '• **Your university** — local coordination, announcements, and updates.',
        '• **Division rooms** — focused Researcher work. Alumni use university-level spaces.',
        '• **Project channels** — private workspaces for assigned teams.',
        '',
        '**Share and discover**',
        '• **Resources** — papers, datasets, tools, and templates for everyone.',
        '• **People database** — opt-in member profiles for finding collaborators by interests, current work, and goals.',
        '• **Projects showcase** — browse work; active projects stay in their private channels.',
        '',
        '**Keep the community useful**',
        '• Keep work in the narrowest relevant space: global, university, division, or project.',
        '• Do not share private research, member data, credentials, or internal discussions outside the right space.',
      ].join('\n'),
    }),
    onboarding: buildSeedContent({
      key: 'start:onboarding',
      title: 'Onboarding',
      body: [
        'Welcome — this short application gives you the right BAINSA access from day one.',
        '',
        '**What you will need**',
        '• Your full name',
        '• Your member path: Researcher or Alumni',
        '• Your university — and, for Researchers, one division',
        '',
        '**What happens next**',
        'Your university board reviews the request and assigns access once the details are confirmed. BAINSA will try to send the decision by DM.',
        'Already applied? Use **Check application status** below to see whether your application is in progress, pending, approved, or declined.',
        '',
        'Ready? Use the button below to begin.',
      ].join('\n'),
    }),
  };
}

export function startHereTopics() {
  return {
    welcome: 'START HERE · Learn how BAINSA is organised, then use Find my spaces to reopen your personal arrival card after approval.',
    onboarding: 'START HERE · Submit or check a BAINSA membership application. Your university board reviews access requests.',
  };
}

export function globalSeeds() {
  return {
    general: buildSeedContent({
      key: 'global:general',
      title: 'BAINSA General',
      body: 'Use this channel for cross-community discussion that is relevant to all BAINSA members. University-specific operations should stay in the university category.',
    }),
    announcements: buildSeedContent({
      key: 'global:announcements',
      title: 'Global Announcements',
      body: 'Global Presidents and University Presidents can publish network-wide announcements here. Use native Discord announcement tools and calendar events.',
    }),
    board: buildSeedContent({
      key: 'global:board',
      title: 'Global Board',
      body: 'Shared board space for Global Presidents and University Presidents. Keep operational decisions, escalation notes, and cross-university coordination here.',
    }),
    botLog: buildSeedContent({
      key: 'global:bot-log',
      title: 'Global Bot Log',
      body: [
        'Use this channel for BAINSA bot commands that operate across university scope. Only Global Presidents should use this command channel.',
        '',
        'Successful shared-state changes are recorded here. Guides, lookups, and errors stay private.',
        'Need help? Run `/guide` here. You will only see commands available to you.',
      ].join('\n'),
    }),
    showcase: buildSeedContent({
      key: 'global:showcase',
      title: 'Projects Showcase',
      body: 'Bot-managed project showcase. Normal members can read showcased work, while project creation and updates should come from the project workflow.',
    }),
    resources: buildSeedContent({
      key: 'global:resources',
      title: 'Resources',
      body: 'Post useful datasets, papers, tools, and templates for the whole BAINSA community. Use tags to keep resources searchable.',
    }),
    peopleDirectory: buildSeedContent({
      key: 'global:people-directory',
      title: 'People Database',
      body: [
        'An opt-in people database for approved BAINSA members. Search profiles and forum tags to discover people by interests, current work, and what they want to explore next.',
        '',
        '**How it works**',
        '• Create or update your own profile with the button below. Publishing is optional and your post is managed by the bot.',
        '• Choose one to four field or environment tags. Your BAINSA university tag is added automatically.',
        '• Email and professional links are optional. Discord is the default way to contact a member.',
        '• Update or unpublish your profile at any time with these buttons. Unpublishing removes the people database post while keeping your details ready if you choose to return.',
        '',
        'Please contact one another respectfully and keep the people database focused on genuine research, professional interests, and collaboration.',
      ].join('\n'),
    }),
    channelProposals: buildSeedContent({
      key: 'global:channel-proposals',
      title: 'Channel Proposals',
      body: 'Suggest a new shared channel for research, events, or discussion. Include its purpose, intended audience, and what help you need.',
    }),
  };
}

export function globalTopics() {
  return {
    general: 'GLOBAL BAINSA · Cross-university questions, discussion, and updates. Keep university-specific work in the relevant university category.',
    announcements: 'GLOBAL BAINSA · Official network-wide updates from BAINSA leadership.',
    board: 'GLOBAL BAINSA · Private cross-university governance and coordination.',
    showcase: 'GLOBAL BAINSA · Read-only overview of BAINSA project work. Active work stays in private project channels.',
    resources: 'GLOBAL BAINSA · Searchable resources, tools, papers, datasets, and templates for the whole community.',
    peopleDirectory: 'GLOBAL BAINSA · Opt-in people database for research and collaboration discovery.',
    channelProposals: 'GLOBAL BAINSA · Propose a shared space for a clear cross-university need.',
    botLog: 'GLOBAL BAINSA · Commands and activity that operate across university scope. Global Presidents only.',
  };
}

export function universitySeeds(universityName) {
  return {
    general: buildSeedContent({
      key: `university:${universityName}:general`,
      title: `${universityName} General`,
      body: `Use this channel for ${universityName} member coordination, questions, and lightweight updates.`,
    }),
    announcements: buildSeedContent({
      key: `university:${universityName}:announcements`,
      title: `${universityName} Announcements`,
      body: `${universityName} board members can publish university announcements and native calendar events here. Keep posts scoped to ${universityName}.`,
    }),
    board: buildSeedContent({
      key: `university:${universityName}:board`,
      title: `${universityName} Board`,
      body: `Private operating channel for the ${universityName} board. Use it for member review, division planning, project supervision, and escalations.`,
    }),
    botLog: buildSeedContent({
      key: `university:${universityName}:bot-log`,
      title: `${universityName} Bot Log`,
      body: [
        `Use this channel for BAINSA bot commands scoped to ${universityName}. University board members can use the commands here; ordinary discussion belongs in the other university channels.`,
        '',
        'Successful shared-state changes are recorded here. Guides, lookups, and errors stay private.',
        'Need help? Run `/guide` here. You will only see commands available to you.',
      ].join('\n'),
    }),
    showcase: buildSeedContent({
      key: `university:${universityName}:showcase`,
      title: `${universityName} Projects Showcase`,
      body: [
        'This is the durable, shareable record of university projects. The bot creates and maintains one post per project; members cannot create showcase posts themselves.',
        '',
        '**Inside a project post**',
        '• Project members can share progress, supporting details, links, and files that are appropriate for the university community.',
        '• Other university members can ask a relevant question or express a concrete interest in contributing.',
        '• Drafts, private decisions, internal notes, and handover details stay in the private project channel.',
        '',
        'Use division and status tags to browse active, paused, and completed work. The starter message is the current project record; replies are the chronological discussion and materials.',
      ].join('\n'),
    }),
    onboardingReview: buildSeedContent({
      key: `university:${universityName}:onboarding-review`,
      title: `${universityName} Onboarding Review`,
      body: [
        `This is the review queue for ${universityName} membership applications.`,
        '',
        '**Before approving**',
        '• Confirm the applicant’s name and member path',
        `• Confirm their connection to ${universityName}`,
        '• For Researchers, confirm the requested division',
        '',
        'Use the action buttons on each request to approve access or decline it with an optional reason. Approved roles are applied automatically.',
      ].join('\n'),
    }),
  };
}

export function universityTopics(universityName) {
  const scope = `BAINSA ${universityName.toUpperCase()}`;
  return {
    general: `${scope} · Local member coordination, questions, and lightweight updates. Division-specific work belongs in its division room.`,
    announcements: `${scope} · Official university announcements and calendar events from the local board.`,
    board: `${scope} · Private board operations: members, divisions, projects, and escalations.`,
    botLog: `${scope} · Commands and activity scoped only to ${universityName}.`,
    showcase: `${scope} · Read-only university project showcase. Active work remains in private project channels.`,
    onboardingReview: `${scope} · Private review queue for ${universityName} membership applications.`,
  };
}

export function divisionSeed(universityName, divisionName, divisionIcon = '') {
  const label = `${divisionIcon ? `${divisionIcon} ` : ''}${divisionName}`;
  return buildSeedContent({
    key: `division:${universityName}:${divisionName}`,
    title: label,
    body: `${label} working room for ${universityName}. Use this for division-specific work, planning, and handoffs.`,
  });
}

export function divisionTopic(universityName, divisionName) {
  return `BAINSA ${universityName.toUpperCase()} · ${divisionName} division working room for planning, research, and handoffs. University-wide updates belong in #general.`;
}

export const FORUM_GUIDE_THREAD_NAME = 'Start here';
