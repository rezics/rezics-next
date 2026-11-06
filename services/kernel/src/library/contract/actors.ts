/** Structural actor and account shapes. Access rows satisfy these without a reverse import. */

export type LibraryAccountActor = Readonly<{
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: string | null;
  authnEpoch: number;
}>;

export type LibraryAnonymousActor = Readonly<{ kind: 'anonymous' }>;
export type LibraryActor = LibraryAccountActor | LibraryAnonymousActor;

export type GrantedAccount = Readonly<{
  route: number;
  accountId: string;
  kind: string;
  state: string;
  fenced: boolean;
  minimumAuthnEpoch: bigint;
}>;

/** Structural conversion from Access actors; missing account fields become anonymous. */
export function libraryActorOf(actor: {
  kind: string;
  accountId?: string;
  clientId?: string;
  scopes?: readonly string[];
  requestedBy?: string | null;
  authnEpoch?: number;
}): LibraryActor {
  if (actor.kind !== 'account' || typeof actor.accountId !== 'string') return { kind: 'anonymous' };
  return {
    kind: 'account',
    accountId: actor.accountId,
    clientId: actor.clientId ?? '',
    scopes: actor.scopes ?? [],
    requestedBy: actor.requestedBy ?? null,
    authnEpoch: actor.authnEpoch ?? 0,
  };
}
