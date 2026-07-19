export const MEMBER_TYPES = Object.freeze({
  RESEARCHER: 'researcher',
  ALUMNI: 'alumni',
});

export const BOARD_ROLES = Object.freeze({
  HEAD: 'head',
  VICE_PRESIDENT: 'vice_president',
  PRESIDENT: 'president',
  GLOBAL_PRESIDENT: 'global_president',
});

export const PROJECT_PERSON_ROLES = Object.freeze({
  MEMBER: 'member',
  SUPERVISOR: 'supervisor',
  BOARD_LIAISON: 'board_liaison',
});

export const PROJECT_STATUSES = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  ARCHIVED: 'archived',
});

// Discord's official API error-code documentation defines error 30060 as
// "Maximum number of channel permission overwrites reached (1000)":
// https://discord.com/developers/topics/opcodes-and-status-codes
export const DISCORD_CHANNEL_PERMISSION_OVERWRITE_LIMIT = 1_000;

// Every project channel reserves one overwrite each for @everyone, the Bot,
// Global President, and the scoped Head, Vice President, and President roles.
export const PROJECT_RESERVED_PERMISSION_OVERWRITES = 6;
export const MAX_PROJECT_PARTICIPANTS =
  DISCORD_CHANNEL_PERMISSION_OVERWRITE_LIMIT - PROJECT_RESERVED_PERMISSION_OVERWRITES;
export const PROJECT_MEMBER_FETCH_CONCURRENCY = 5;

export const ROLE_NAMES = Object.freeze({
  RESEARCHER: 'Researcher',
  ALUMNI: 'Alumni',
  GLOBAL_PRESIDENT: 'Global President',
  BOT: 'Bot',
});

export const ROLE_COLORS = Object.freeze({
  BOCCONI: '#D7263D',
  SAPIENZA: '#F2C94C',
  POLIMI: '#2F80ED',
  GLOBAL_PRESIDENT: '#F2994A',
  RESEARCHER: '#7A7A7A',
  ALUMNI: '#27AE60',
});

export const DIVISION_COLORS = Object.freeze({
  RED: Object.freeze({ key: 'red', label: 'Red', icon: '🟥', hex: '#D7263D' }),
  ORANGE: Object.freeze({ key: 'orange', label: 'Orange', icon: '🟧', hex: '#F2994A' }),
  YELLOW: Object.freeze({ key: 'yellow', label: 'Yellow', icon: '🟨', hex: '#F2C94C' }),
  GREEN: Object.freeze({ key: 'green', label: 'Green', icon: '🟩', hex: '#27AE60' }),
  BLUE: Object.freeze({ key: 'blue', label: 'Blue', icon: '🟦', hex: '#2F80ED' }),
  PINK: Object.freeze({ key: 'pink', label: 'Pink', icon: '🟪', hex: '#E76F9A' }),
  BROWN: Object.freeze({ key: 'brown', label: 'Brown', icon: '🟫', hex: '#8D6E63' }),
  BLACK: Object.freeze({ key: 'black', label: 'Black', icon: '⬛', hex: '#2F2F2F' }),
});

export const DIVISION_COLOR_CHOICES = Object.freeze(
  Object.values(DIVISION_COLORS).map(({ key, label, icon }) => ({
    name: `${label} ${icon}`,
    value: key,
  })),
);

const divisionColorsByKey = new Map(Object.values(DIVISION_COLORS).map((color) => [color.key, color]));

export function divisionColorDetails(value) {
  const key = typeof value === 'object' ? value?.key : value;
  const normalized = String(key ?? '').trim().toLowerCase();
  const direct = divisionColorsByKey.get(normalized);
  if (direct) return direct;

  return (
    [...divisionColorsByKey.values()].find((color) =>
      [color.label, color.icon, `${color.label} ${color.icon}`, `${color.icon} ${color.label}`]
        .some((candidate) => candidate.toLowerCase() === normalized),
    ) ?? null
  );
}

export function defaultDivisionColorKey(divisionName) {
  const key = String(divisionName ?? '').trim().toLowerCase();
  if (key === 'analysis') return DIVISION_COLORS.ORANGE.key;
  if (key === 'culture') return DIVISION_COLORS.PINK.key;
  return DIVISION_COLORS.BLUE.key;
}

export function divisionLabel(divisionName, color) {
  const details = divisionColorDetails(color) ?? divisionColorDetails(defaultDivisionColorKey(divisionName));
  return `${details.icon} ${divisionName}`;
}

export function universityRoleColor(universityName) {
  const key = String(universityName ?? '').trim().toLowerCase();
  if (key === 'bocconi') return ROLE_COLORS.BOCCONI;
  if (key === 'sapienza') return ROLE_COLORS.SAPIENZA;
  if (key === 'polimi') return ROLE_COLORS.POLIMI;
  return null;
}

export const INITIAL_SERVER_PLAN = Object.freeze({
  universities: [
    {
      name: 'Bocconi',
      divisions: [
        { name: 'Projects', color: 'blue' },
        { name: 'Analysis', color: 'orange' },
        { name: 'Culture', color: 'pink' },
      ],
    },
    {
      name: 'Sapienza',
      divisions: [{ name: 'Projects', color: 'blue' }],
    },
    {
      name: 'Polimi',
      divisions: [{ name: 'Projects', color: 'blue' }],
    },
  ],
});
