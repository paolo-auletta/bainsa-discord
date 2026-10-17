import { UserFacingError } from '../errors.js';

export const BAINSA_EMAIL_DOMAIN = 'bainsa.ai';

/** The person members see as the sender of the account messages. */
export const BAINSA_EMAIL_CONTACT_NAME = 'Alberto';

export const BAINSA_EMAIL_STATUSES = Object.freeze({
  HAS_ACCOUNT: 'has_account',
  REQUESTED: 'requested',
  CREATED: 'created',
});

export const BAINSA_EMAIL_LIMITS = Object.freeze({
  name: Object.freeze({ max: 60 }),
  email: Object.freeze({ max: 254 }),
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeName(value: unknown, label: string): string {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > BAINSA_EMAIL_LIMITS.name.max) {
    throw new UserFacingError(`Enter your ${label} using 1 to ${BAINSA_EMAIL_LIMITS.name.max} characters.`);
  }
  return name;
}

export function normalizeContactEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > BAINSA_EMAIL_LIMITS.email.max || !EMAIL_PATTERN.test(email)) {
    throw new UserFacingError('Enter a valid email address, for example name@gmail.com.');
  }
  if (email.endsWith(`@${BAINSA_EMAIL_DOMAIN}`)) {
    throw new UserFacingError(
      `Use the email address you already check, not an @${BAINSA_EMAIL_DOMAIN} address. Your credentials are sent there.`,
    );
  }
  return email;
}

export function normalizeBainsaEmailRequest({ firstName, lastName, contactEmail }) {
  return {
    firstName: normalizeName(firstName, 'first name'),
    lastName: normalizeName(lastName, 'last name'),
    contactEmail: normalizeContactEmail(contactEmail),
  };
}

/** Splits an onboarding full name into modal defaults; members can correct both fields. */
export function splitFullName(fullName: unknown) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
