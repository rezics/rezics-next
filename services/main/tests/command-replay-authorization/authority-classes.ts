export type Loss = 'expired' | 'revoked';
// For principal entries, expiry/revocation ends the credential, not an Agent grant.
export type PrincipalLoss = Loss | 'principal-inactive';
export type CapabilityLoss = Loss | 'consumed';
export type RealmMembershipLoss = 'realm-membership-lost';
export type StatementAcceptanceLoss = 'statement-not-accepted';
export type AuthorityLoss = PrincipalLoss | CapabilityLoss | RealmMembershipLoss | StatementAcceptanceLoss;
export type ErrorClass = new (...args: never[]) => Error;

export interface Scenario<L extends AuthorityLoss = Loss> {
  // fresh selects another request key, never another principal, credential or resource.
  command: (fresh?: boolean, changed?: boolean) => Promise<unknown>;
  lose: (loss: L) => Promise<void>;
  snapshot: () => Promise<unknown>;
  advance?: () => Promise<void>;
  restore?: () => Promise<void>;
}

export interface ResourceScenario extends Omit<Scenario, 'command'> {
  requestKeys: [string, string];
  commandWithKey: (key: string, changed?: boolean) => Promise<unknown>;
}

interface ReplayMetadata {
  operation: string;
  scope: string;
  action: string;
  family: string;
  owners: string[];
  subcases: string[];
  denied: ErrorClass;
  conflict: ErrorClass;
  registration: 'turned' | 'registered-failing';
  // A recovery capability can mint a new credential while returning the same receipt.
  resultIdentity?: (result: unknown) => unknown;
  denials?: Partial<Record<AuthorityLoss, ErrorClass>>;
}

// Existing factories use this indexed class type and rely on one contextual
// request-builder signature. The driver validates each class before execution.
export interface ReplayEntry extends ReplayMetadata {
  authorityClass: 'controller' | 'domain-grant' | 'principal' | 'capability' | 'resource-identity';
  losses?: Loss[];
  requestBuilder: (subcase: string, loss: Loss) => Promise<Scenario>;
}

export interface PrincipalReplayEntry extends ReplayMetadata {
  authorityClass: 'principal';
  losses?: PrincipalLoss[];
  requestBuilder: (subcase: string, loss: PrincipalLoss) => Promise<Scenario<PrincipalLoss>>;
}

// These authorities have no credential expiry or grant-revocation variants.
export interface RealmMembershipReplayEntry extends ReplayMetadata {
  authorityClass: 'realm-membership';
  losses?: RealmMembershipLoss[];
  requestBuilder: (subcase: string, loss: RealmMembershipLoss) => Promise<Scenario<RealmMembershipLoss>>;
}

export interface StatementAcceptanceReplayEntry extends ReplayMetadata {
  authorityClass: 'statement-acceptance';
  losses?: StatementAcceptanceLoss[];
  requestBuilder: (subcase: string, loss: StatementAcceptanceLoss) => Promise<Scenario<StatementAcceptanceLoss>>;
}

export interface CapabilityReplayEntry extends ReplayMetadata {
  authorityClass: 'capability';
  losses?: CapabilityLoss[];
  singleUse: boolean;
  credential: (subcase: string, loss: CapabilityLoss) => Promise<string>;
  requestBuilder: (subcase: string, loss: CapabilityLoss, credential: string) => Promise<Scenario<CapabilityLoss>>;
}

export interface ResourceIdentityReplayEntry extends ReplayMetadata {
  authorityClass: 'resource-identity';
  losses?: Loss[];
  resourceIdentity: string;
  changedBody: 'saved-result' | { refusal: ErrorClass } | { result: unknown };
  requestBuilder: (subcase: string, loss: Loss) => Promise<ResourceScenario>;
}

export type AnyReplayEntry = ReplayEntry | PrincipalReplayEntry | CapabilityReplayEntry | ResourceIdentityReplayEntry
  | RealmMembershipReplayEntry | StatementAcceptanceReplayEntry;

export function principalReplayEntry(entry: AnyReplayEntry): entry is PrincipalReplayEntry {
  return entry.authorityClass === 'principal';
}
export function capabilityReplayEntry(entry: AnyReplayEntry): entry is CapabilityReplayEntry {
  return entry.authorityClass === 'capability' && 'credential' in entry && 'singleUse' in entry;
}
export function resourceIdentityReplayEntry(entry: AnyReplayEntry): entry is ResourceIdentityReplayEntry {
  return entry.authorityClass === 'resource-identity' && 'resourceIdentity' in entry && 'changedBody' in entry;
}

export interface NonReplayEntry {
  operation: string;
  family: string;
  owners: string[];
  reason: string;
  subcases: string[];
  requestBuilder: (subcase: string) => Promise<{
    command: () => Promise<unknown>;
    snapshot: () => Promise<unknown>;
    repeatResult: unknown;
    afterRepeat: unknown;
  }>;
}

export function authorityLosses(entry: AnyReplayEntry): AuthorityLoss[] {
  if (entry.losses) return entry.losses;
  if (entry.authorityClass === 'realm-membership') return ['realm-membership-lost'];
  if (entry.authorityClass === 'statement-acceptance') return ['statement-not-accepted'];
  if (entry.authorityClass === 'principal') return ['expired', 'revoked', 'principal-inactive'];
  if (capabilityReplayEntry(entry) && entry.singleUse) return ['expired', 'revoked', 'consumed'];
  return ['expired', 'revoked'];
}

export async function buildReplayScenario(entry: AnyReplayEntry, subcase: string, loss: AuthorityLoss) {
  const bind = <L extends AuthorityLoss>(scenario: Scenario<L>, reduction: L) =>
    ({ ...scenario, lose: () => scenario.lose(reduction) });
  if (!authorityLosses(entry).includes(loss)) throw new Error(`Unregistered authority loss: ${loss}`);
  if (entry.authorityClass === 'realm-membership') {
    if (loss !== 'realm-membership-lost') throw new Error(`Invalid Realm membership loss: ${loss}`);
    return bind(await entry.requestBuilder(subcase, loss), loss);
  }
  if (entry.authorityClass === 'statement-acceptance') {
    if (loss !== 'statement-not-accepted') throw new Error(`Invalid Statement acceptance loss: ${loss}`);
    return bind(await entry.requestBuilder(subcase, loss), loss);
  }
  if (principalReplayEntry(entry)) {
    if (loss !== 'expired' && loss !== 'revoked' && loss !== 'principal-inactive') throw new Error(`Invalid principal loss: ${loss}`);
    return bind(await entry.requestBuilder(subcase, loss), loss);
  }
  if (entry.authorityClass === 'capability') {
    if (!capabilityReplayEntry(entry)) throw new Error('Capability replay requires a credential and single-use declaration');
    if (loss !== 'expired' && loss !== 'revoked' && loss !== 'consumed') throw new Error(`Invalid capability loss: ${loss}`);
    const credential = await entry.credential(subcase, loss);
    if (!credential) throw new Error('Capability entries must supply a credential');
    return bind(await entry.requestBuilder(subcase, loss, credential), loss);
  }
  if (loss !== 'expired' && loss !== 'revoked') throw new Error(`Invalid authority loss: ${loss}`);
  if (entry.authorityClass === 'resource-identity') {
    if (!resourceIdentityReplayEntry(entry)) throw new Error('Resource replay requires an identity and changed-body declaration');
    const fixture = await entry.requestBuilder(subcase, loss);
    const [original, alternate] = fixture.requestKeys;
    if (!original || !alternate || original === alternate) throw new Error('Resource replay requires two distinct request keys');
    return bind({ ...fixture, command: (fresh?: boolean, changed?: boolean) =>
      fixture.commandWithKey(fresh ? alternate : original, changed) }, loss);
  }
  return bind(await entry.requestBuilder(subcase, loss), loss);
}
