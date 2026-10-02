import { browserMainApi } from '../api/browser.ts';
import { changeMember, newKey, send, type Outcome } from './commands.ts';
import { readAgents } from './read.ts';
import { type AgentSummary, type MainClient, type MemberCommand, uuidOf } from './types.ts';

export interface SpaceSettings {
  visibility: 'public' | 'private'; listing: 'listed' | 'unlisted';
  history: 'everything' | 'from-admission'; admission: 'open' | 'request' | 'invitation';
}
export interface SpaceSettingsView { space: string; realm: string; generation: string; settings: SpaceSettings }
export interface ListingState { listing: SpaceSettings['listing']; version: number; changedAt: string | null }
export interface JoinBasis { policyRevision: string; termsRevision: string; membershipGeneration: string;
  state: 'absent' | 'joined' | 'left' }
export interface JoinRequest { id: string; member: string; consent: string; membershipGeneration: string;
  policyRevision: string; reason: string; createdAt: string }
export interface RequestPage { items: JoinRequest[]; nextCursor: string | null }
export interface JoinReceipt { requestId: string; state: 'pending'; expiresAt: string; replayed: boolean }
export interface JoinPage {
  profile: 'realm-join-page-v1'; id: string; space: string;
  name: { value: string; language: string }; description: { value: string; language: string } | null;
  rules: { id: string; title: { value: string; language: string }; body: { value: string; language: string } }[];
  listing: SpaceSettings['listing']; discovery: Discovery;
  action: { kind: 'request'; href: string; method: 'POST'; basis: string };
  sourcePosition: { dataEpoch: string; sequence: string };
}
export interface Discovery { indexable: boolean; robots: 'index' | 'noindex'; referrerPolicy: 'no-referrer' | null }
type Answer<T> = Promise<{ data: T | null; error: { status: number; value: unknown } | null }>;
type Query = { query: Record<string, string | number> };
type Key = { headers: { 'idempotency-key': string } };
export interface SettingsCommand { actingSubject: string; expectedGeneration: string; reason: string; settings: SpaceSettings }
export interface JoinCommand { actingSubject: string; expectedMembershipGeneration: string;
  expectedPolicyRevision: string; termsRevision: string; reason: string }

// Temporary G-946 boundary: its reviewed routes are not on this worktree's MainApp yet.
// Keep every pending route and shape here; replace this cast with MainApp inference after merge.
interface VisibilityClient { v1: {
  spaces(path: { space: string }): { settings: { get(options: Query): Answer<SpaceSettingsView>;
    put(body: SettingsCommand, options: Key): Answer<SpaceSettingsView> } };
  agents(path: { id: string }): { listing: { get(): Answer<ListingState>;
    put(body: { listing: SpaceSettings['listing']; expectedVersion: number }, options: Key): Answer<ListingState> } };
  realms(path: { realm: string }): { 'join-requests': { get(options: Query): Answer<RequestPage>;
    post(body: JoinCommand, options: Key): Answer<JoinReceipt>; basis: { get(options: Query): Answer<JoinBasis> } };
    'join-page': { get(options: Query): Answer<JoinPage> } };
} }
const pending = (main: MainClient) => main as unknown as VisibilityClient;
const keyed = (key: string): Key => ({ headers: { 'idempotency-key': key } });

export interface SpaceAccessApi {
  settings(): Promise<Outcome<SpaceSettingsView>>;
  save(command: SettingsCommand, key: string): Promise<Outcome<SpaceSettingsView>>;
  requests(after: string | null): Promise<Outcome<RequestPage>>;
  names(iris: readonly string[]): Promise<Record<string, AgentSummary>>;
  approve(request: JoinRequest, reason: string, key: string): Promise<Outcome<unknown>>;
  basis(): Promise<Outcome<JoinBasis>>;
  request(command: JoinCommand, key: string): Promise<Outcome<JoinReceipt>>;
}
export function spaceAccessApi(main: () => MainClient, space: string, realm: string, actingSubject: string): SpaceAccessApi {
  const approvalIntents = new Map<string, MemberCommand>();
  return {
    settings: () => send(() => pending(main()).v1.spaces({ space: uuidOf(space) }).settings.get({ query: { actingSubject } })),
    save: (command, key) => send(() => pending(main()).v1.spaces({ space: uuidOf(space) }).settings.put(command, keyed(key))),
    requests: after => send(() => pending(main()).v1.realms({ realm: uuidOf(realm) })['join-requests'].get({
      query: { actingSubject, limit: 50, ...after ? { after } : {} } })),
    names: iris => readAgents(main(), iris, actingSubject),
    approve: async (request, reason, key) => {
      let command = approvalIntents.get(key);
      if (!command) {
        // The roster supplies the management generation using the same permission
        // as admitting a member; reading settings would require an unrelated grant.
        const current = await send(() => main().v1.realms({ realm: uuidOf(realm) }).members.get({ query: { actingSubject, limit: 1 } }));
        if (!current.ok) return current;
        command = { actingSubject, expectedGeneration: current.data.generation,
          member: request.member, expectedMembershipGeneration: request.membershipGeneration, action: 'add',
          consent: request.consent, durationSeconds: null, reason };
        approvalIntents.set(key, command);
      }
      const result = await changeMember(main(), uuidOf(realm), command, key);
      if (!result.ok && result.failure === 'stale') approvalIntents.delete(key);
      return result;
    },
    basis: () => send(() => pending(main()).v1.realms({ realm: uuidOf(realm) })['join-requests'].basis.get({ query: { actingSubject } })),
    request: (command, key) => send(() => pending(main()).v1.realms({ realm: uuidOf(realm) })['join-requests'].post(command, keyed(key))),
  };
}
export const browserSpaceAccessApi = (space: string, realm: string, actor: string) =>
  spaceAccessApi(() => browserMainApi(), space, realm, actor);

/** G-943's outsider route reads this purpose-built page after a denied Realm
 * header. Main decides whether requests and this limited disclosure are allowed. */
export function readPrivateSpaceJoinPage(main: MainClient, realm: string, actingSubject?: string) {
  return send(() => pending(main).v1.realms({ realm: uuidOf(realm) })['join-page'].get({
    query: actingSubject ? { actingSubject } : {} }));
}

/** Accept the canonical Space address and legacy Realm addresses while the
 * management router transitions. Never use a Realm UUID as a Space UUID. */
export async function readManagementAccess(main: MainClient, candidate: string, actingSubject: string) {
  const direct = await spaceAccessApi(() => main, candidate, candidate, actingSubject).settings();
  if (direct.ok || direct.failure !== 'denied') return direct;
  const header = await send(() => main.v1.realms({ realm: uuidOf(candidate) }).get({ query: { actingSubject } }));
  if (!header.ok) return header;
  return spaceAccessApi(() => main, header.data.space, candidate, actingSubject).settings();
}

/** Request managers need membership authority, not settings authority. Public
 * Space reads and legacy Realm inboxes can resolve without a settings grant. */
export async function readRequestsAtAddress(main: MainClient, candidate: string, actor: string):
  Promise<Outcome<{ space: string; realm: string; page: RequestPage }>> {
  const publicSpace = await send(() => main.v1.spaces({ space: uuidOf(candidate) }).get());
  const realm = publicSpace.ok ? publicSpace.data.realm : candidate;
  const page = await spaceAccessApi(() => main, candidate, realm, actor).requests(null);
  if (page.ok) return { ok: true, data: { space: candidate, realm, page: page.data } };
  if (publicSpace.ok || page.failure !== 'denied') return page;
  const access = await readManagementAccess(main, candidate, actor);
  if (!access.ok) return access;
  const resolved = await spaceAccessApi(() => main, access.data.space, access.data.realm, actor).requests(null);
  return resolved.ok ? { ok: true, data: { ...access.data, page: resolved.data } } : resolved;
}
export interface ListingApi {
  read(): Promise<Outcome<ListingState>>;
  save(listing: SpaceSettings['listing'], expectedVersion: number, key: string): Promise<Outcome<ListingState>>;
}
export function listingApi(main: () => MainClient, agent: string): ListingApi {
  return { read: () => send(() => pending(main()).v1.agents({ id: uuidOf(agent) }).listing.get()),
    save: (listing, expectedVersion, key) => send(() => pending(main()).v1.agents({ id: uuidOf(agent) }).listing.put(
      { listing, expectedVersion }, keyed(key))) };
}
export const browserListingApi = (agent: string) => listingApi(() => browserMainApi(), agent);

/** An unchanged draft may be retried; any concurrent change to these four choices needs review. */
export const sameSpaceSettings = (a: SpaceSettings, b: SpaceSettings) =>
  a.visibility === b.visibility && a.listing === b.listing && a.history === b.history && a.admission === b.admission;
export { newKey };
