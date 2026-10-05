import { type AgentSummary, type ChapterSummary, failureOf, iriOf, type Loaded, type MainClient, type ModerationKind,
  type PersonRecord, uuidOf, type WorkFacts, type WorkSummary } from './types.ts';

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
  /** A report reason code; Main then lists only reports one of whose reporters gave it. */
  reason?: string | null;
  cursor?: string | null;
}

export function readQueue(main: MainClient, realm: string, query: QueueQuery) {
  return settle(() => main.v1.realms({ realm }).moderation.get({ query: { actingSubject: query.actingSubject,
    state: query.state, ...query.type ? { type: query.type } : {}, ...query.reason ? { reason: query.reason } : {},
    ...query.cursor ? { cursor: query.cursor } : {} } }),
  { management: true, cursor: query.cursor });
}

/**
 * Who the queue's submitters and reporters are here, and what its Works are
 * beyond their headers, in one management read (at most twenty of each).
 */
export function readModerationContext(main: MainClient, realm: string, query: { actingSubject: string;
  agents: readonly string[]; works: readonly string[] }) {
  const agents = [...new Set(query.agents)].slice(0, CONTEXT_BUDGET);
  const works = [...new Set(query.works)].slice(0, CONTEXT_BUDGET);
  return settle(() => main.v1.realms({ realm }).moderation.context.get({ query: { actingSubject: query.actingSubject,
    ...agents.length ? { agents: agents.join(',') } : {}, ...works.length ? { works: works.join(',') } : {} } }),
  { management: true });
}

/** Main's limit for one moderation context read (`MODERATION_CONTEXT_COST`). */
const CONTEXT_BUDGET = 20;

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

/**
 * The Works queue items point at, read as the acting moderator so restricted
 * Works still show. Posts have no Work header; moderation context names their
 * placing Books separately. Works already `known` are not read again.
 */
export async function readWorks(main: MainClient, iris: readonly string[], query: { language: string;
  actingSubject: string }, known: Record<string, WorkSummary> = {}): Promise<Record<string, WorkSummary>> {
  const read = async (wanted: readonly string[]) => {
    const unique = [...new Set(wanted)].filter(iri => !known[iri]).slice(0, NAME_BUDGET);
    const works = await bounded(unique, 8, async iri => {
      const header = await settle(() => main.v1.works({ id: uuidOf(iri) }).get({ query }));
      if (!header.ok) return null;
      const work = header.data;
      return { iri, title: work.title, cover: work.cover, types: work.types, originalTitle: work.originalTitle?.value ?? null,
        tagline: work.tagline, completionStatus: work.completionStatus,
        chapterCount: work.chapterCount } satisfies WorkSummary;
    });
    return Object.fromEntries(works.filter(work => work !== null).map(work => [work.iri, work]));
  };
  return read(iris);
}

/** About a screenful of a chapter: enough to judge it without reading it all. */
export const CHAPTER_EXCERPT = 1_200;

/** A chapter's opening, without the heading its text repeats, cut at the paragraph nearest `limit`. */
export function chapterExcerpt(body: string, label: string | null, limit = CHAPTER_EXCERPT):
  { excerpt: string | null; truncated: boolean } {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const text = (label && lines[0]?.normalize('NFKC') === label.trim().normalize('NFKC') ? lines.slice(1) : lines)
    .join('\n');
  if (!text) return { excerpt: null, truncated: false };
  const characters = Array.from(text);
  if (characters.length <= limit) return { excerpt: text, truncated: false };
  const cut = characters.slice(0, limit).join('');
  const paragraph = cut.lastIndexOf('\n');
  return { excerpt: (paragraph > limit / 2 ? cut.slice(0, paragraph) : cut).trimEnd(), truncated: true };
}

/** Where each chapter Post is placed in its Book, from Main's moderation context. */
export type Placements = Record<string, { work: string; occurrence: string | null }>;

/**
 * The chapters `placements` name as their Books list them: the label a
 * chapter has in the Book's contents, and the opening of its text. One
 * chapter read each (Main has no batched one); a chapter placed nowhere now
 * is left out.
 */
export async function readChapters(main: MainClient, placements: Placements, actingSubject: string,
  known: Record<string, ChapterSummary> = {}): Promise<Record<string, ChapterSummary>> {
  const chapters = Object.entries(placements).flatMap(([work, place]) => place.occurrence && !known[work]
    ? [{ work, occurrence: place.occurrence }] : []).slice(0, NAME_BUDGET);
  const read = await bounded(chapters, 4, async ({ work, occurrence }) => {
    const chapter = await settle(() => main.v1.chapters({ id: uuidOf(occurrence) }).get({ query: { actingSubject } }));
    if (!chapter.ok) return null;
    const body: unknown = (chapter.data.content as { body?: { body?: unknown } }).body?.body;
    const label = chapter.data.label ? { value: chapter.data.label.value, language: chapter.data.label.language } : null;
    const direction = chapter.data.content.reference.direction;
    return [work, { label, language: chapter.data.language, direction: direction === 'none' ? undefined : direction,
      ...typeof body === 'string' ? chapterExcerpt(body, label?.value ?? null) : { excerpt: null, truncated: false } }
    ] as const;
  });
  return Object.fromEntries(read.filter(entry => entry !== null));
}

/** What the queue and the log know of the Works they name. */
export interface SubjectNames { works: Record<string, WorkSummary>; chapters: Record<string, ChapterSummary>;
  facts: Record<string, WorkFacts> }

/**
 * The Works a page names as a moderator sees them: their headers, Main's
 * moderation context (authors, a mod's or prompt's facts, and a chapter's
 * place even when the chapter itself is not public), then each chapter's
 * Book and its label and opening. `people` asks the context for their
 * records too.
 */
export async function readSubjects(main: MainClient, realm: string, iris: readonly string[], query: { language: string;
  actingSubject: string }, known: SubjectNames = { works: {}, chapters: {}, facts: {} }, people: readonly string[] = []):
  Promise<SubjectNames & { records: Record<string, PersonRecord> }> {
  const wanted = [...new Set(iris)].filter(iri => !known.facts[iri]);
  const [works, context] = await Promise.all([readWorks(main, iris, query, known.works),
    wanted.length || people.length ? readModerationContext(main, realm, { actingSubject: query.actingSubject,
      agents: people, works: wanted }) : null]);
  const facts: Record<string, WorkFacts> = context?.ok
    ? Object.fromEntries(context.data.works.map(work => [work.work, work])) : {};
  const all = { ...known.works, ...works };
  const placements: Placements = {};
  for (const iri of iris) {
    const place = facts[iri]?.partOf ?? known.facts[iri]?.partOf;
    if (place) placements[iri] = place;
  }
  const [books, chapters] = await Promise.all([
    readWorks(main, Object.values(placements).map(place => place.work), query, all),
    readChapters(main, placements, query.actingSubject, known.chapters)]);
  return { works: { ...works, ...books }, chapters, facts,
    records: context?.ok ? Object.fromEntries(context.data.people.map(person => [person.agent, person])) : {} };
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
