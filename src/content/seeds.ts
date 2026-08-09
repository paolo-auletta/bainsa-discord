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
        'BAINSA Discord connects our university community for research, ideas, and collaboration. This guide shows where each conversation belongs.',
        '',
        '**Start here**',
        '1. Complete #onboarding to request access.',
        '2. Once approved, use the global and university spaces available to you.',
        '3. Cannot see a channel? It is not in your access—ask in university general if unsure.',
        '',
        '**How the server is organised**',
        '• **Global BAINSA** connects every university: conversations, resources, and ideas for the whole community.',
        '• **Your university category** is for local coordination, announcements, and university-specific work.',
        '• **Division spaces** are focused working areas for Researchers. Onboarding starts you in one division; your board can add further division access when needed. Alumni do not need one.',
        '• **Project channels** are private spaces for assigned teams: discussion, files, and handoffs.',
        '',
        '**Where to post**',
        '• **Global general** — cross-university questions, discussion, and updates.',
        '• **Resources** — useful papers, datasets, tools, and templates for everyone.',
        '• **Channel proposals** — requests for a new shared channel that could help the wider community.',
        '• **University general** — questions and updates that concern your university only.',
        '• **Division channel** — planning and work for your division.',
        '• **Project channel** — work for a specific project and its assigned team.',
        '',
        '**Announcements and showcases**',
        'Global and university announcement channels are for official updates. Project showcase channels let you browse completed or featured work; use the appropriate project workspace for active work instead.',
        '',
        '**Keep the community useful**',
        '• Use your real name or a recognizable name.',
        '• Keep work in the narrowest relevant space: global, university, division, or project.',
        '• Do not share private research, member data, credentials, or internal discussions outside the appropriate channel.',
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
        'Your university board reviews the request and assigns access once the details are confirmed.',
        '',
        'Ready? Use the button below to begin.',
      ].join('\n'),
    }),
  };
}

export function globalSeeds({ anonymousFeedbackUrl }: { anonymousFeedbackUrl?: string | null } = {}) {
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
      title: 'People Directory',
      body: [
        'An opt-in directory for approved BAINSA members. Search the post text and forum tags to discover people by interests, current work, and what they want to explore next.',
        '',
        '**How it works**',
        '• Create or update your own profile with the button below. Publishing is optional and your post is managed by the bot.',
        '• Choose one to four field or environment tags. Your BAINSA university tag is added automatically.',
        '• Email and professional links are optional. Discord is the default way to contact a member.',
        '• Update or unpublish your profile at any time with these buttons. Unpublishing removes the directory post while keeping your details ready if you choose to return.',
        '',
        'Please contact one another respectfully and keep the directory focused on genuine research, professional interests, and collaboration.',
      ].join('\n'),
    }),
    channelProposals: buildSeedContent({
      key: 'global:channel-proposals',
      title: 'Channel Proposals',
      body: 'Suggest a new shared channel for research, events, or discussion. Include its purpose, intended audience, and what help you need.',
    }),
    anonymousFeedback: buildSeedContent({
      key: 'global:anonymous-feedback',
      title: 'Anonymous Feedback',
      body: anonymousFeedbackUrl
        ? `Use this form when you want feedback routed privately to the right reviewers:\n${anonymousFeedbackUrl}`
        : 'Anonymous feedback is enabled by configuration. Ask a board member for the current feedback form if it is not displayed here yet.',
    }),
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
      body: 'Bot-managed university project showcase. Members can read showcased work; project channels remain private to assigned members, supervisors, and scoped board roles.',
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

export function divisionSeed(universityName, divisionName, divisionIcon = '') {
  const label = `${divisionIcon ? `${divisionIcon} ` : ''}${divisionName}`;
  return buildSeedContent({
    key: `division:${universityName}:${divisionName}`,
    title: label,
    body: `${label} working room for ${universityName}. Use this for division-specific work, planning, and handoffs.`,
  });
}

export const FORUM_GUIDE_THREAD_NAME = 'Start here';
