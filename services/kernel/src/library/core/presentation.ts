import type { GrantedAccount, LibraryAccountActor } from '../contract/index.ts';

/** The same current account fence applies to every logical built-in read. */
export function currentLibraryAccount(actor: LibraryAccountActor, current: GrantedAccount | null): boolean {
  return (
    current !== null &&
    current.kind === 'actor' &&
    current.state === 'active' &&
    !current.fenced &&
    Number.isSafeInteger(actor.authnEpoch) &&
    actor.authnEpoch > 0 &&
    current.minimumAuthnEpoch <= BigInt(actor.authnEpoch)
  );
}
