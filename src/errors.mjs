export class UserFacingError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'UserFacingError';
  }
}

export function assertUser(condition, message) {
  if (!condition) throw new UserFacingError(message);
}
