import { UserFacingError } from './errors.mjs';

export function parseIsoDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new UserFacingError(`${fieldName} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new UserFacingError(`${fieldName} is not a valid date.`);
  }
  return value;
}

export function assertDateOrder(startDate, expectedEnd) {
  if (expectedEnd < startDate) {
    throw new UserFacingError('expected_end cannot be before start_date.');
  }
}
