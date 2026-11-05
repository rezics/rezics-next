import type { VerificationConfig } from '../../../report/turnstile';
import type { AuthorContributionActionsWire, ContributionActionsResponse } from './receiver';

export type ContributionActionsRead = { response: ContributionActionsResponse; verification: VerificationConfig };

/** Read credentials are captured by the current host, separately from native operation leases. */
export function installedContributionActionsWire(credential: string | null): AuthorContributionActionsWire<ContributionActionsRead> {
  return {
    async read(input, signal) {
      const { readContributionActions } = await import('./transport');
      signal.throwIfAborted();
      return readContributionActions({ data: input, signal, headers: credential ? { 'X-CSRF-Token': credential } : {} });
    },
  };
}
