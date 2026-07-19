import { MEMBER_TYPES } from '../constants.mjs';

export const ONBOARDING_STATUSES = Object.freeze({
  DRAFT: 'draft',
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

export function normalizeSelectedDivisionIds(values = []) {
  return [...new Set(values.filter((value) => value != null && value !== '').map(String))].sort();
}

export function pageItems(items, page = 0, pageSize = 25) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);
  return {
    items: items.slice(safePage * pageSize, safePage * pageSize + pageSize),
    page: safePage,
    totalPages,
    hasPrevious: safePage > 0,
    hasNext: safePage < totalPages - 1,
  };
}

export function nextDraftState(draft, patch) {
  const next = { ...draft, ...patch };
  if (next.member_type === MEMBER_TYPES.ALUMNI) {
    next.division_ids = [];
  }
  if (next.division_ids) {
    next.division_ids = normalizeSelectedDivisionIds(next.division_ids);
  }
  return next;
}

export function canSubmitOnboardingRequest(draft) {
  if (!draft?.member_type || !draft?.university_id || !hasValidFullName(draft.full_name)) return false;
  if (draft.member_type === MEMBER_TYPES.RESEARCHER) {
    return normalizeSelectedDivisionIds(draft.division_ids).length === 1;
  }
  return draft.member_type === MEMBER_TYPES.ALUMNI;
}

export function normalizeFullName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function hasValidFullName(value) {
  const name = normalizeFullName(value);
  return name.length >= 2 && name.length <= 120;
}
