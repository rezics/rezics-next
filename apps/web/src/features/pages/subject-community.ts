import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { KernelClient } from '@rezics/client';
import { documentText } from '@rezics/document';
import { readPageAuthors, type PageAuthors } from '../../identity/read';
import { isPlatformClosedError, isPlatformClosedProblem } from '../../kernel/platform-closed';
import { GLOBAL } from './subject-ratings';
import { pageContext, type SubjectPageData, type SubjectPageLoad } from './subject';
import { isRecord } from './shared';

export type CommunityKind = 'review' | 'discussion';
type NativePage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['subjects']>['threads']['get']>>['data']>;
export type NativeCommunityThread = NativePage['threads'][number];
export type CommunityThread = Pick<NativeCommunityThread, 'id' | 'title' | 'authorId' | 'boardId' | 'createdAt'> & {
  summary: string;
};
export type CommunityRegion = (
  | { state: 'loading' | 'unavailable' | 'closed' }
  | { state: 'ready'; threads: CommunityThread[]; next: string | null }
) & { contributionScope?: 'global' | 'realm' };
export type SubjectCommunity = {
  regions: Partial<Record<CommunityKind, CommunityRegion>>;
  nodes?: Record<string, CommunityRegion>;
  authors: PageAuthors;
  now: string;
};

export const COMMUNITY_PREVIEW_LIMIT = 5;
export const COMMUNITY_PAGE_LIMIT = 20;

/** Template placement opens a region; no Semantic Context or publication pointer selects a Content place. */
export function communityKinds(nodes: readonly unknown[]): CommunityKind[] {
  const kinds = new Set<CommunityKind>();
  function walk(content: readonly unknown[]) {
    for (const node of content) {
      if (!isRecord(node)) continue;
      if (node.type === 'ReviewList') kinds.add('review');
      if (node.type === 'ThreadList') kinds.add('discussion');
      if (isRecord(node.props)) for (const value of Object.values(node.props)) if (Array.isArray(value)) walk(value);
    }
  }
  walk(nodes);
  return [...kinds];
}

/** Public list DTO only: document bodies, revisions, reactions and moderation fields never cross the page boundary. */
function project(thread: NativeCommunityThread): CommunityThread {
  return {
    id: thread.id,
    title: thread.title,
    authorId: thread.authorId,
    boardId: thread.boardId,
    createdAt: thread.createdAt,
    summary: thread.firstPost.body ? documentText(thread.firstPost.body).replace(/\s+/g, ' ').trim().slice(0, 280) : '',
  };
}

/** One native page per placed region and one shared public identity batch; continuations are never drained. */
export async function readSubjectCommunity(
  client: KernelClient,
  subjectId: string,
  kinds: readonly CommunityKind[],
  paged = false,
  cursor?: string,
): Promise<SubjectCommunity> {
  const limit = paged ? COMMUNITY_PAGE_LIMIT : COMMUNITY_PREVIEW_LIMIT;
  const entries = await Promise.all(
    [...new Set(kinds)].map(async (kind): Promise<[CommunityKind, CommunityRegion]> => {
      if (cursor !== undefined && (!paged || cursor.length > 2048)) return [kind, { state: 'unavailable' }];
      try {
        const result = await client.subjects({ id: subjectId }).threads.get({
          query: { place: GLOBAL, kind, limit, ...(cursor !== undefined ? { cursor } : {}) },
        });
        if (isPlatformClosedProblem(result.status, result.error?.value)) return [kind, { state: 'closed' }];
        if (result.status !== 200 || result.error || !result.data) return [kind, { state: 'unavailable' }];
        const threads = result.data.threads
          .slice(0, limit)
          .filter(
            (thread) =>
              thread.kind === kind &&
              thread.subjectIds.includes(subjectId) &&
              thread.visibility === 'published' &&
              thread.availability === 'available' &&
              thread.firstPost.availability === 'available' &&
              thread.firstPost.visibility === 'published',
          );
        return [
          kind,
          { state: 'ready', threads: threads.map(project), next: result.data.next, contributionScope: 'global' },
        ];
      } catch (error) {
        return [kind, { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' }];
      }
    }),
  );
  const authorIds = entries.flatMap(([, region]) =>
    region.state === 'ready' ? region.threads.map((thread) => thread.authorId) : [],
  );
  return {
    regions: Object.fromEntries(entries),
    authors: await readPageAuthors(client, authorIds),
    now: new Date().toISOString(),
  };
}

/** Decode only the existing native DTO. A failed/unrequested read cannot become an empty invitation. */
export function composedCommunityRegion(read: { status: number; body: unknown } | undefined): CommunityRegion {
  if (!read) return { state: 'unavailable' };
  if (isPlatformClosedProblem(read.status, read.body)) return { state: 'closed' };
  if (
    read.status !== 200 ||
    !isRecord(read.body) ||
    !Array.isArray(read.body.threads) ||
    (read.body.next !== null && typeof read.body.next !== 'string')
  )
    return { state: 'unavailable' };
  const body = read.body as NativePage;
  return { state: 'ready', threads: body.threads.map(project), next: body.next };
}

/** Use the guarded composition leaves and their exact cursor, with one shared public identity batch. */
export async function withComposedCommunity(client: KernelClient, loaded: SubjectPageLoad): Promise<SubjectPageLoad> {
  if (loaded.kind !== 'page' || !loaded.page.subject || loaded.page.account) return loaded;
  const plan = planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page));
  const nodes: Record<string, CommunityRegion> = {};
  const regions: SubjectCommunity['regions'] = {};
  for (const [node, key] of Object.entries(plan.nodes)) {
    const descriptor = plan.reads[key];
    if (descriptor?.kind !== 'subjectThreads') continue;
    const region = composedCommunityRegion(loaded.page.reads[key]);
    // An omitted Context is the native ordinary Global page. A Realm selector, including a native
    // publication fallback, must never turn into an invitation to a Global destination.
    const population = loaded.page.context?.population;
    if (!loaded.page.requestedRealm && descriptor.id === loaded.page.subject) {
      if ((!loaded.page.context || population?.kind === 'global') && descriptor.place === GLOBAL)
        region.contributionScope = 'global';
      else if (population?.kind === 'realm' && descriptor.place === population.id) region.contributionScope = 'realm';
    }
    nodes[node] = region;
    regions[descriptor.threadKind] ??= region;
  }
  const authorIds = Object.values(nodes).flatMap((region) =>
    region.state === 'ready' ? region.threads.map((thread) => thread.authorId) : [],
  );
  return {
    ...loaded,
    page: {
      ...loaded.page,
      community: { nodes, regions, authors: await readPageAuthors(client, authorIds), now: new Date().toISOString() },
    },
  };
}

/** Tab availability comes exclusively from the native composition status. */
export function communityOverview(overview: SubjectPageData): SubjectPageData {
  return overview;
}

/** Standalone compatibility loader. The actual page query consumes composition leaves through withComposedCommunity. */
export async function withSubjectCommunity(
  client: KernelClient,
  loaded: SubjectPageLoad,
  view?: string,
  cursor?: string,
): Promise<SubjectPageLoad> {
  if (loaded.kind !== 'page' || !loaded.page.subject || loaded.page.account) return loaded;
  if (loaded.page.requestedRealm || (loaded.page.context && loaded.page.context.population.kind !== 'global'))
    return loaded;
  const kinds = communityKinds(loaded.page.document.content);
  if (!kinds.length) return loaded;
  const community = await readSubjectCommunity(client, loaded.page.subject, kinds, view !== undefined, cursor);
  return { ...loaded, page: { ...loaded.page, community } };
}
