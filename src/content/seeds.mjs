const MARKER_PREFIX = '<!-- bainsa:seed:';

export function seedMarker(key) {
  return `${MARKER_PREFIX}${key} -->`;
}

export function withSeedMarker(key, body) {
  return `${seedMarker(key)}\n${body.trim()}`;
}

export function buildSeedContent({ key, title, body, fields = [] }) {
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
      body: 'This Discord is the operating home for BAINSA members. Start here, read the structure, then complete onboarding so the bot can assign the right university and division access.',
    }),
    rules: buildSeedContent({
      key: 'start:rules',
      title: 'Rules',
      body: [
        'Use real names or recognizable names.',
        'Keep project work inside the right university, division, and project channels.',
        'Do not share private research, member data, credentials, or internal board discussion outside the spaces where it belongs.',
        'Use announcements and calendar events only when your board role gives you scope to do so.',
      ].join('\n'),
    }),
    structure: buildSeedContent({
      key: 'start:structure',
      title: 'Discord Structure',
      body: 'Access is role-based. Everyone can read Start Here. Researchers and Alumni can access shared BAINSA spaces. University roles unlock that university. Division roles unlock division workrooms. Board roles unlock only the scoped board and announcement surfaces they manage.',
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

export function globalSeeds({ anonymousFeedbackUrl } = {}) {
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
      body: 'Use this channel for BAINSA bot commands that operate across university scope. Only Global Presidents should use this command channel.',
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
    topicProposals: buildSeedContent({
      key: 'global:topic-proposals',
      title: 'Topic Proposals',
      body: 'Suggest research, event, or discussion topics for the broader community. Include context, intended audience, and what help you need.',
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
      body: `Use this channel for BAINSA bot commands scoped to ${universityName}. University board members can use the commands here; ordinary discussion belongs in the other university channels.`,
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
