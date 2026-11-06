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
