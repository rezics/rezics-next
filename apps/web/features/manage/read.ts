import { type AgentSummary, failureOf, iriOf, type Loaded, type MainClient, type ModerationKind, uuidOf,
  type WorkSummary } from './types.ts';

// Reads shared by the server render and the browser (load more, refresh after
// a decision). Each takes the Eden client for its side and returns `Loaded`
// instead of throwing, so one region's failure never takes down the page.

type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };

/**
 * One Main read as a `Loaded` result. A first page whose basis moved (409) is
 * read again once, as Main asks; a moved cursor is the reader's to restart.
 */
export async function settle<T>(call: () => Promise<Answer<T>>, options: { management?: boolean; cursor?: string | null } = {}):
  Promise<Loaded<T>> {
  try {
    let { data, error } = await call();
    if (error?.status === 409 && !options.cursor) ({ data, error } = await call());
    if (error) return { ok: false, failure: failureOf(error.status, options.management) };
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}

export interface QueueQuery {
  actingSubject: string;
  state: 'open' | 'closed';
  type: ModerationKind | null;
  cursor?: string | null;
}

export function readQueue(main: MainClient, realm: string, query: QueueQuery) {
  return settle(() => main.v1.realms({ realm }).moderation.get({ query: { actingSubject: query.actingSubject,
    state: query.state, ...query.type ? { type: query.type } : {}, ...query.cursor ? { cursor: query.cursor } : {} } }),
  { management: true, cursor: query.cursor });
}

export function readAudit(main: MainClient, realm: string, query: { actingSubject: string;
  kind: 'content_moderation' | 'rights_disposition' | 'organization_publication_rejection' | 'realm_management' | null;
  cursor?: string | null }) {
  return settle(() => main.v1.realms({ realm }).audit.get({ query: { actingSubject: query.actingSubject,
    ...query.kind ? { kind: query.kind } : {}, ...query.cursor ? { cursor: query.cursor } : {} } }),
  { management: true, cursor: query.cursor });
}

export function readPublicDecisions(main: MainClient, realm: string, cursor?: string | null) {
  return settle(() => main.v1.realms({ realm }).decisions.get({ query: cursor ? { cursor } : {} }), { cursor });
}

export function readMembers(main: MainClient, realm: string, query: { actingSubject: string; search?: string;
  after?: string | null }) {
  const search = query.search?.trim();
  return settle(() => main.v1.realms({ realm }).members.get({ query: { actingSubject: query.actingSubject,
    ...search ? { search } : {}, ...query.after ? { after: query.after } : {} } }), { management: true });
}

export function readOutgoingInvitations(main: MainClient, realm: string, actingSubject: string, after?: string | null) {
  return settle(() => main.v1.realms({ realm }).invitations.get({ query: { actingSubject,
    ...after ? { after } : {} } }), { management: true });
}

export function readRoles(main: MainClient, realm: string, actingSubject: string) {
  return settle(() => main.v1.realms({ realm }).roles.get({ query: { actingSubject } }), { management: true });
}

export function readSettings(main: MainClient, realm: string, actingSubject: string) {
  return settle(() => main.v1.realms({ realm }).settings.get({ query: { actingSubject } }), { management: true });
}

/** One page of the Realms the acting Agent manages, from its role assignments (G-314). */
export function readManagedRealms(main: MainClient, actingSubject: string, after?: string | null) {
  return settle(() => main.v1.me['managed-realms'].get({ query: { actingSubject, ...after ? { after } : {} } }),
    { management: true });
}

/**
 * What a report's decision must cite, read as a moderator: its retained
 * reports with their private statements and evidence, the target's current
 * heads and the Realm's published rules (null until rules are published).
 */
export function readDecisionBasis(main: MainClient, realm: string, caseId: string, actingSubject: string) {
  return settle(() => main.v1.realms({ realm }).moderation({ caseId }).get({ query: { actingSubject } }),
    { management: true });
}

export function readRealmHeader(main: MainClient, realm: string, language: string) {
  return settle(() => main.v1.realms({ realm }).get({ query: { language } }));
}

export function searchRealms(main: MainClient, q: string, language: string) {
  return settle(() => main.v1.realms.get({ query: { q, language, limit: 10 } }));
}

/** Runs `task` over `values` with at most `width` in flight. */
async function bounded<T, R>(values: readonly T[], width: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]!);
    }
  }));
  return results;
}

/** The most names one view resolves: a full members page. */
const NAME_BUDGET = 50;

/**
 * Public names for the Agents a view shows. Main's management reads return
 * Agent IDs only, so each name is one public profile read, bounded per view;
 * an Agent Main cannot describe keeps a null label and shows its short ID.
 * A client that sends a token (the BFF always does) must name its acting Agent.
 */
export async function readAgents(main: MainClient, iris: readonly string[], actingSubject?: string):
  Promise<Record<string, AgentSummary>> {
  const unique = [...new Set(iris)].slice(0, NAME_BUDGET);
  const agents = await bounded(unique, 8, async (iri): Promise<AgentSummary> => {
    const read = await settle(() => main.v1.agents({ id: uuidOf(iri) }).get({ query: actingSubject ? { actingSubject } : {} }));
    return read.ok ? { iri, label: read.data.displayName, handle: read.data.handle } : { iri, label: null, handle: null };
  });
  return Object.fromEntries(agents.map(agent => [agent.iri, agent]));
}

/** Newly read names over known ones, except that a read Main could not answer never erases a known name. */
export function mergeAgents(known: Record<string, AgentSummary>, found: Record<string, AgentSummary>) {
  const merged = { ...known };
  for (const [iri, agent] of Object.entries(found)) if (agent.label !== null || !merged[iri]) merged[iri] = agent;
  return merged;
}

/** The Works queue items point at, read as the acting moderator so restricted Works still show. */
export async function readWorks(main: MainClient, iris: readonly string[], query: { language: string;
  actingSubject: string }): Promise<Record<string, WorkSummary>> {
  const unique = [...new Set(iris)].slice(0, NAME_BUDGET);
  const works = await bounded(unique, 8, async iri => {
    const read = await settle(() => main.v1.works({ id: uuidOf(iri) }).get({ query }));
    return read.ok ? { iri, title: read.data.title, cover: read.data.cover,
      originalTitle: read.data.originalTitle?.value ?? null } satisfies WorkSummary : null;
  });
  return Object.fromEntries(works.filter(work => work !== null).map(work => [work.iri, work]));
}

/** A submission as its reviewer sees it, including the private note. */
export function readSubmission(main: MainClient, realm: string, submission: string, actingSubject: string) {
  return settle(() => main.v1.realms({ realm }).submissions({ submission }).get({ query: { actingSubject } }));
}

/** The exact submitted draft, for showing a contribution in context. */
export async function readDraftText(main: MainClient, contribution: string, revision: string,
  actingSubject: string): Promise<Loaded<{ text: string; language: string }>> {
  const read = await settle(() => main.v1.contributions({ contribution: uuidOf(contribution) })
    .drafts({ revision: uuidOf(revision) }).get({ query: { actingSubject } }));
  return read.ok ? { ok: true, data: { text: read.data.body, language: read.data.language } } : read;
}

/** A person by handle ("@lin_mei" or "lin_mei"), for acting on someone who is not in the member list. */
export async function readHandle(main: MainClient, handle: string, actingSubject?: string): Promise<Loaded<AgentSummary>> {
  const bare = handle.trim().replace(/^@/, '');
  if (/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(bare)) return { ok: true, data: { iri: bare, label: null, handle: null } };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bare)) {
    return { ok: true, data: { iri: iriOf(bare), label: null, handle: null } };
  }
  if (!bare || bare.length > 64) return { ok: false, failure: 'invalid' };
  const read = await settle(() => main.v1.handles({ handle: bare }).get({ query: actingSubject ? { actingSubject } : {} }));
  return read.ok ? { ok: true, data: { iri: read.data.id, label: read.data.displayName, handle: read.data.handle } } : read;
}
