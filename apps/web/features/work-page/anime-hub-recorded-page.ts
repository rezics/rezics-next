import type { MainClient } from '../discover/types.ts';
import { readerEntry, type ReaderSeed } from '../catalogue/reader-store.ts';
import { followHref } from '../entity-page/href.ts';
import type { EntityProjection, StatementPage } from '../entity-page/types.ts';
import type { AgentCreditPage, CreditPage } from './types.ts';
import { booksEditionReads, settle, type BooksRead } from './books-edition-page.read.ts';
import { iriOf } from './route.ts';

// Client-supplied reads for the Anime hub. The server page calls these with the
// request-cached host client; a recorded story calls them with the replaying client.
// The requests match the production readers, including problem bodies.

export function readResourcePage(main: MainClient, actingSubject: string | undefined, id: string, position?: string):
  Promise<BooksRead<EntityProjection>> {
  return settle(() => main.v1.resources({ resource: id }).page.get({ query: { actingSubject, position } }));
}

/** Statements at the link a projection section names. `frame` is Main's continuity, never a browser filter. */
export function readLinkedStatements(main: MainClient, actingSubject: string | undefined, href: string,
  query: { cursor?: string; position?: string; frame?: readonly string[] } = {}): Promise<BooksRead<StatementPage>> {
  return settle(followHref<StatementPage>(main, href, {
    actingSubject, cursor: query.cursor, position: query.position,
    ...query.frame?.length ? { frame: [...query.frame] } : {},
  }), query.cursor);
}

/** Literal publication values as Main recorded them. An empty page is an honest missing date. */
export function publicationLexicals(page: StatementPage): readonly string[] {
  const lexicals: string[] = [];
  for (const group of page.groups) for (const item of group.items) {
    if (item.kind === 'statement' && item.value.kind === 'literal') lexicals.push(item.value.lexical);
  }
  return lexicals;
}

export function readAnimeAgentCredits(main: MainClient, actingSubject: string | undefined, id: string):
  Promise<BooksRead<AgentCreditPage>> {
  return settle(() => main.v1.works({ id })['agent-credits'].get({ query: { actingSubject } }));
}

export function readAnimeWorkCredits(main: Pick<MainClient, 'v1'>, actingSubject: string | undefined, id: string):
  Promise<BooksRead<CreditPage>> {
  return settle(async () => {
    const result = await main.v1.query.post({ profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits',
      revision: 1, parameters: { roots: [iriOf(id)] }, presentation: { actingSubject } });
    return { ...result, problem: result.data, error: result.error, data: result.data?.result?.profile === 'template-result-v1'
      && result.data.result.query === 'https://rezics.com/query/work-credits' ? result.data.result : null };
  });
}

/** The reader's shelf seed. No acting person means no request; a denied library draws no private controls. */
export async function readAnimeReaderState(main: MainClient, actingSubject: string | undefined, id: string):
  Promise<ReaderSeed | null> {
  if (!actingSubject) return null;
  const state = await settle(() => main.v1.works({ id })['reader-state'].get({ query: { actingSubject } }));
  if (state.ok) return { [state.data.work]: readerEntry(state.data) };
  return state.failure === 'sign-in' ? null : {};
}

export function readWorkRealizations(main: MainClient, actingSubject: string | undefined, id: string, after?: string) {
  return settle(() => main.v1.works({ id }).realizations.get({
    query: { actingSubject, limit: 20, cursor: after } }), after);
}

export function readWorkParts(main: MainClient, actingSubject: string | undefined, id: string,
  query: { parent?: string; after?: string; limit?: number }) {
  return settle(() => main.v1.resources({ resource: id }).parts.get({ query: {
    actingSubject, parent: query.parent ? iriOf(query.parent) : undefined, after: query.after, limit: query.limit,
  } }), query.after);
}

const noInventory = (read: { ok: true; data: { items?: readonly unknown[]; parts?: readonly unknown[] } }
  | { ok: false; failure: string }) => read.ok ? !(read.data.items ?? read.data.parts)?.length
  : read.failure === 'missing' || read.failure === 'sign-in' || read.failure === 'identity';

/** The availability section is omitted only when realizations, releases and parts are all absent. */
export function availabilityShown(reads: {
  realizations: { ok: true; data: { items?: readonly unknown[] } } | { ok: false; failure: string };
  releases: { ok: true; data: { items?: readonly unknown[] } } | { ok: false; failure: string };
  parts: { ok: true; data: { items?: readonly unknown[]; parts?: readonly unknown[] } } | { ok: false; failure: string };
}): boolean {
  return !(noInventory(reads.realizations) && noInventory(reads.releases) && noInventory(reads.parts));
}

export async function readDatedAnimeHub(main: MainClient, actingSubject: string | undefined, id: string) {
  const reads = booksEditionReads({ main, actingSubject });
  const header = await reads.readWorkHeader(id);
  if (!header.ok) return { header };
  const [projection, releases, realizations, parts, agentCredits, credits, seed] = await Promise.all([
    readResourcePage(main, actingSubject, id), reads.readReleases(id), readWorkRealizations(main, actingSubject, id),
    readWorkParts(main, actingSubject, id, { limit: 1 }), readAnimeAgentCredits(main, actingSubject, id),
    readAnimeWorkCredits(main, actingSubject, id), readAnimeReaderState(main, actingSubject, id),
  ]);
  const href = projection.ok ? projection.data.sections.find(section => section.id === 'statements')?.href : undefined;
  const statements = href ? await readLinkedStatements(main, actingSubject, href, {}) : null;
  return { header, projection, releases, realizations, parts, agentCredits, credits, seed, statements,
    shown: availabilityShown({ realizations, releases, parts }) };
}

/** Header, the recorded statements link, and the release page. Undated has no recorded projection or chooser inventory. */
export async function readUndatedAnimeHub(main: MainClient, actingSubject: string | undefined, id: string,
  statementsHref: string) {
  const reads = booksEditionReads({ main, actingSubject });
  const header = await reads.readWorkHeader(id);
  if (!header.ok) return { header };
  const [statements, releases] = await Promise.all([
    readLinkedStatements(main, actingSubject, statementsHref, {}), reads.readReleases(id),
  ]);
  return { header, statements, releases };
}

/** The sourced publication's public credit page keeps author and transcriber roles supplied by Main. */
export function readSelectedWorkCredits(main: Pick<MainClient, 'v1'>, actingSubject: string | undefined, id: string, sourced: boolean):
  Promise<BooksRead<CreditPage>> {
  return sourced ? settle(async () => {
    const result = await main.v1.works({ id }).credits.get({ query: { actingSubject } });
    return { ...result, problem: result.data,
      data: result.data?.query === 'https://rezics.com/query/work-credits' ? result.data : null };
  })
    : readAnimeWorkCredits(main, actingSubject, id);
}

export function readWorkWholes(main: MainClient, actingSubject: string | undefined, id: string,
  query: { after?: string; limit?: number } = {}) {
  return settle(() => main.v1.resources({ resource: id }).wholes.get({ query: {
    actingSubject, after: query.after, limit: query.limit ?? 20,
  } }), query.after);
}

export function readWorkRelations(main: MainClient, actingSubject: string | undefined, id: string,
  query: { after?: string; limit?: number }) {
  return settle(() => main.v1.resources({ resource: id }).relations.get({ query: {
    actingSubject, after: query.after, limit: query.limit,
  } }), query.after);
}
