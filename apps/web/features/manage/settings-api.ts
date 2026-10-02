import { browserMainApi } from '../api/browser.ts';
import { newKey, send, type Outcome } from './commands.ts';
import { readAgents } from './read.ts';
import { type AgentSummary, type MainClient, uuidOf } from './types.ts';

// These types come from the served Main contract. A changed command or receipt
// must break this adapter instead of silently passing through an old boundary.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Body<Call> = Call extends (body: infer Input, ...rest: never[]) => unknown ? Input : never;
type Space = ReturnType<MainClient['v1']['spaces']>;
type Realm = ReturnType<MainClient['v1']['realms']>;
type Requests = Realm['join-requests'];
type Request = ReturnType<Requests>;
export type SpaceSettingsView = Ok<Space['settings']['get']>;
export type SpaceSettings = SpaceSettingsView['settings'];
export type SettingsCommand = Body<Space['settings']['put']>;
export type ListingState = Ok<ReturnType<MainClient['v1']['agents']>['listing']['get']>;
export type JoinBasis = Ok<Requests['basis']['get']>;
export type RequestPage = Ok<Requests['get']>;
export type JoinRequest = RequestPage['items'][number];
export type OwnRequestPage = Ok<Requests['mine']['get']>;
export type OwnJoinRequest = OwnRequestPage['items'][number];
export type JoinCommand = Body<Requests['post']>;
export type JoinReceipt = Ok<Requests['post']>;
export type JoinDecision = Body<Request['decisions']['post']>;
export type JoinWithdraw = Body<Request['withdraw']['post']>;
export type JoinDecisionReceipt = Ok<Request['decisions']['post']>;
export type JoinPage = Ok<Realm['join-page']['get']>;
export type Discovery = JoinPage['discovery'];
const keyed = (key: string) => ({ headers: { 'idempotency-key': key } });

export interface SpaceAccessApi {
  settings(): Promise<Outcome<SpaceSettingsView>>;
  save(command: SettingsCommand, key: string): Promise<Outcome<SpaceSettingsView>>;
  requests(cursor: string | null, q?: string): Promise<Outcome<RequestPage>>;
  mine(cursor: string | null): Promise<Outcome<OwnRequestPage>>;
  names(iris: readonly string[]): Promise<Record<string, AgentSummary>>;
  decide(request: string, command: JoinDecision, key: string): Promise<Outcome<JoinDecisionReceipt>>;
  withdraw(request: string, command: JoinWithdraw, key: string): Promise<Outcome<JoinDecisionReceipt>>;
  basis(): Promise<Outcome<JoinBasis>>;
  request(command: JoinCommand, key: string): Promise<Outcome<JoinReceipt>>;
}
export function spaceAccessApi(main: () => MainClient, space: string, realm: string, actingSubject: string): SpaceAccessApi {
  return {
    settings: () => send(() => main().v1.spaces({ space: uuidOf(space) }).settings.get({ query: { actingSubject } })),
    save: (command, key) => send(() => main().v1.spaces({ space: uuidOf(space) }).settings.put(command, keyed(key))),
    requests: (cursor, q = '') => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests'].get({
      query: { actingSubject, limit: 50, q, ...cursor ? { cursor } : {} } })),
    mine: cursor => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests'].mine.get({
      query: { actingSubject, limit: 50, ...cursor ? { cursor } : {} } })),
    names: iris => readAgents(main(), iris, actingSubject),
    decide: (request, command, key) => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests']({ request })
      .decisions.post(command, keyed(key))),
    withdraw: (request, command, key) => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests']({ request })
      .withdraw.post(command, keyed(key))),
    basis: () => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests'].basis.get({ query: { actingSubject } })),
    request: (command, key) => send(() => main().v1.realms({ realm: uuidOf(realm) })['join-requests'].post(command, keyed(key))),
  };
}
export const browserSpaceAccessApi = (space: string, realm: string, actor: string) =>
  spaceAccessApi(() => browserMainApi(), space, realm, actor);

/** G-943's outsider route reads this purpose-built page after a denied Realm
 * header. Main decides whether requests and this limited disclosure are allowed. */
export function readPrivateSpaceJoinPage(main: MainClient, realm: string) {
  return send(() => main.v1.realms({ realm: uuidOf(realm) })['join-page'].get({
    query: {} }));
}

/** Accept the canonical Space address and legacy Realm addresses while the
 * management router transitions. Never use a Realm UUID as a Space UUID. */
export async function readManagementAccess(main: MainClient, candidate: string, actingSubject: string) {
  const direct = await spaceAccessApi(() => main, candidate, candidate, actingSubject).settings();
  if (direct.ok || direct.failure !== 'denied' && direct.failure !== 'missing') return direct;
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
  if (publicSpace.ok || page.failure !== 'denied' && page.failure !== 'missing') return page;
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
  return { read: () => send(() => main().v1.agents({ id: uuidOf(agent) }).listing.get()),
    save: (listing, expectedVersion, key) => send(() => main().v1.agents({ id: uuidOf(agent) }).listing.put(
      { listing, expectedVersion }, keyed(key))) };
}
export const browserListingApi = (agent: string) => listingApi(() => browserMainApi(), agent);

/** An unchanged draft may be retried; any concurrent change to these four choices needs review. */
export const sameSpaceSettings = (a: SpaceSettings, b: SpaceSettings) =>
  a.visibility === b.visibility && a.listing === b.listing && a.history === b.history && a.admission === b.admission;
export { newKey };
