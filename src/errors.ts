export type UserFacingRecoveryKind =
  | 'validation'
  | 'forbidden'
  | 'stale'
  | 'reconciliation'
  | 'unexpected';

export interface UserFacingRecovery {
  kind?: UserFacingRecoveryKind;
  title?: string;
  preservedState?: string;
  correction?: string;
  continueWith?: string;
}

export class UserFacingError extends Error {
  recovery: UserFacingRecovery | null;

  constructor(message: string, options: ErrorOptions & { recovery?: UserFacingRecovery } = {}) {
    super(message, options);
    this.name = 'UserFacingError';
    this.recovery = options.recovery ?? null;
  }
}

export function assertUser(
  condition: unknown,
  message: string,
  options: ErrorOptions & { recovery?: UserFacingRecovery } = {},
) {
  if (!condition) throw new UserFacingError(message, options);
}
