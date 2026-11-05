import {
  isView,
  planReads,
  platformRegistry,
  VIEWS,
  type CompositionDocument,
  type View,
  type SelectedContext,
  type PageContinuation,
} from '@rezics/composition';
import { accountOf, viewIsPublic, type AccountProfile } from './account-read';
import { countFromLinks, sumCounts, type Count } from '../count';
import { bestRank, isRecord, type Stmt } from './shared';
import { relationPreviewCount } from './subject-relations-preview';
import type { SubjectCommunity } from './subject-community';
import type { ProfileBound } from '../catalogue/music-reader';
import { m } from '../../paraglide/messages.js';

/** A finite reading vocabulary, independent of the number of properties, kinds or populations. */
export function readerViewLabel(view: string, locale: string): string {
  const options = { locale: locale as never };
  const names: Record<string, () => string> = {
    editions: () => m.subject_editions({}, options),
    contents: () => m.subject_contents({}, options),
    characters: () => m.subject_characters({}, options),
    appearances: () => m.subject_appearances({}, options),
    credits: () => m.subject_credits({}, options),
    works: () => m.subject_works({}, options),
    relations: () => m.subject_relations({}, options),
    lists: () => m.subject_lists({}, options),
  };
  return names[view]?.() ?? '';
}

/** One tab of a subject page: a view, and how many items its data has when that is known. */
export type ViewTab = { view: View; count?: Count };

type Node = { type: string; props: Record<string, unknown> };
type Read = { status: number; body: unknown };

/** One finite relation page already included in the ordinary composed read. */
export type ProfileRelationPage = {
  property: string;
  direction: 'forward' | 'inverse';
  rows: readonly unknown[];
  next?: string;
  complete: boolean;
};

/** A relation node in the current composition, including its failed or withheld read state. */
export type ProfileRelationWindow = ProfileRelationPage & {
  node: string;
  /** The exact native composition read bound, before any reader projection. */
  limit?: number;
  caughtUp?: boolean;
  status?: number;
  valid: boolean;
  count?: Count;
};

/** The view a `SubjectList` previews, by the property it lists. A list of any other property belongs to no view. */
const LIST_VIEWS: Readonly<Record<string, View>> = {
  'schema:exampleOfWork': 'editions',
  'schema:workExample': 'editions',
  'rezics:representativeEdition': 'editions',
  'schema:isPartOf': 'contents',
  'wdt:P179': 'contents',
  'schema:author': 'works',
  'schema:illustrator': 'works',
  'schema:director': 'works',
  'schema:musicBy': 'works',
  'schema:publisher': 'works',
  'schema:productionCompany': 'works',
  'wdt:P178': 'works',
  'schema:genre': 'works',
  'schema:contributor': 'credits',
  'wdt:P725': 'characters',
  'schema:character': 'appearances',
};

/** The view a list property previews, when it previews one. */
export function listView(property: unknown): View | undefined {
  return typeof property === 'string' && Object.hasOwn(LIST_VIEWS, property) ? LIST_VIEWS[property] : undefined;
}

/** Relation rows already disclosed by this composed read. No target hydration or follow-up read is implied. */
export function profileRelationWindows(page: {
  subject: string | null;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
}, options: { includeAliases?: boolean } = {}): ProfileRelationWindow[] {
  const document = page.document as CompositionDocument;
  const plan = planReads(platformRegistry, document, {
    subject: page.subject,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  const pages: ProfileRelationWindow[] = [];
  const seenNodes = new Set<string>();
  const seenReads = new Set<string>();
  const continuationRead = page.continuation ? plan.nodes[page.continuation.node] : undefined;
  for (const node of walk(document.content)) {
    const property = typeof node.props.property === 'string' ? node.props.property : undefined;
    if (!property) continue;
    const nodeId = typeof node.props.id === 'string' ? node.props.id : undefined;
    if (nodeId === undefined || seenNodes.has(nodeId)) continue;
    seenNodes.add(nodeId);
    const key = plan.nodes[nodeId];
    if (key === undefined || (!options.includeAliases && seenReads.has(key))) continue;
    seenReads.add(key);
    const planned = plan.reads[key];
    const result = page.reads[key];
    if (!planned || (planned.kind !== 'links' && planned.kind !== 'relations')) continue;
    // Identical native reads may share a plan key. A cursor supplied for one node belongs only to that node.
    const borrowedContinuation = page.continuation !== undefined && nodeId !== page.continuation.node && key === continuationRead;
    const body = !borrowedContinuation && result?.status === 200 && isRecord(result.body) ? result.body : undefined;
    const direction = planned.kind === 'links' ? 'inverse' : planned.kind === 'relations' ? 'forward' : undefined;
    const rows = body ? (planned.kind === 'links' ? body.links : body.relations) : undefined;
    const valid = Array.isArray(rows);
    const admittedRows = valid ? rows : [];
    if (!direction) continue;
    const next = body && typeof body.next === 'string' ? body.next : undefined;
    const nativeCount =
      body && isRecord(body.count) && typeof body.count.value === 'number'
        ? countFromLinks({ value: body.count.value, exact: body.count.exact === true }, admittedRows.length)
        : undefined;
    pages.push({
      node: nodeId,
      limit: planned.limit,
      ...(body && isRecord(body.freshness) && typeof body.freshness.caught_up === 'boolean'
        ? { caughtUp: body.freshness.caught_up }
        : {}),
      property,
      direction,
      rows: admittedRows,
      ...(borrowedContinuation ? { status: 409 } : result?.status !== undefined ? { status: result.status } : {}),
      valid,
      ...(next ? { next } : {}),
      complete: !!body && valid && body.next === null,
      ...(nativeCount ? { count: nativeCount } : {}),
    });
  }
  return pages;
}

/** Successfully admitted relation pages; existing readers retain their previous failure handling. */
export function profileRelationPages(page: {
  subject: string | null;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
}): ProfileRelationPage[] {
  return profileRelationWindows(page)
    .filter((window) => window.status === 200 && window.valid)
    .map(({ node: _node, status: _status, valid: _valid, count: _count, ...window }) => window);
}

/** Loaded relation pages on this composed read. A following page never implies a complete list. */
export function boundedProfileRelations(page: {
  subject: string | null;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
}): ProfileBound[] {
  const seen = new Set<string>();
  return profileRelationPages(page).flatMap(({ property, rows, next, complete }) => {
    const identity = property;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [
      {
        property,
        loaded: rows.length,
        ...(next ? { next } : {}),
        complete,
      },
    ];
  });
}

/** The view a data component previews. Components that preview no view return nothing. */
export function previewedView(node: Node): View | undefined {
  switch (node.type) {
    case 'OutgoingRelations':
    case 'RelationGroups':
      return 'relations';
    case 'Appearances':
      return node.props.direction === 'forward' ? 'characters' : 'appearances';
    case 'Credits':
      return node.props.direction === 'forward' ? 'credits' : 'works';
    case 'CollectionList':
      return 'lists';
    case 'AccountPosts':
      return 'posts';
    case 'AccountThreads':
      return node.props.threadKind === 'review' ? 'reviews' : 'discussion';
    case 'RatingSummary':
    case 'ReviewList':
      return 'reviews';
    case 'ThreadList':
      return 'discussion';
    case 'AccountCollections':
      return 'collections';
    case 'SubjectList':
      return listView(node.props.property);
    default:
      return undefined;
  }
}

/** The account's public profile when the page's account read succeeded. */
function accountProfile(page: {
  subject: string | null;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
}): AccountProfile | undefined {
  if (!page.account) return;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    account: page.account,
    ...(page.context ? { context: page.context } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  const key = Object.entries(plan.reads).find(([, read]) => read.kind === 'account')?.[0];
  const result = key === undefined ? undefined : page.reads[key];
  return result?.status === 200 ? accountOf(result.body) : undefined;
}

/** Views that are always offered when a template defines them. */
const ALWAYS: ReadonlySet<View> = new Set(['overview', 'details']);
const OPEN_READ_VIEWS: ReadonlySet<View> = new Set(['reviews', 'discussion']);

function* walk(nodes: readonly unknown[]): Generator<Node> {
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.type !== 'string' || !isRecord(node.props)) continue;
    yield node as Node;
    for (const value of Object.values(node.props)) if (Array.isArray(value)) yield* walk(value);
  }
}

function previewLimit(node: Node, read: { limit?: number } | undefined): number {
  if (typeof node.props.limit === 'number' && node.props.limit >= 1) return Math.min(node.props.limit, 12);
  return Math.min(read?.limit ?? 12, 12);
}

/** A window size does not distinguish lists; every other planned constraint still does. */
function previewListKey(read: object | undefined): string | undefined {
  if (!read) return;
  return JSON.stringify(
    Object.entries(read)
      .filter(([name]) => name !== 'limit')
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** Repeated windows supply one list's strongest count. An unknown window cannot establish a total. */
function navigationCount(lists: Iterable<readonly (Count | undefined)[]>): Count | undefined {
  return sumCounts(
    Array.from(lists, (counts) => {
      let best: Count | undefined;
      for (const count of counts) {
        if (!count) return;
        if (!best || (best.relation !== 'exact' && (count.relation === 'exact' || count.value > best.value)))
          best = count;
      }
      return best;
    }),
  );
}

/** The items and total a preview read returned for one node. Nothing when the read did not succeed. */
function previewCount(
  node: Node,
  read: { kind: string; id?: string; limit?: number } | undefined,
  result: Read | undefined,
): { items: number; count?: Count; more?: boolean } | undefined {
  if (!read || result?.status !== 200 || !isRecord(result.body)) return;
  const body = result.body;
  if (read.kind === 'links' && Array.isArray(body.links)) {
    const count =
      isRecord(body.count) && typeof body.count.value === 'number'
        ? { value: body.count.value, exact: body.count.exact === true }
        : undefined;
    const mappedCount = countFromLinks(count, body.links.length);
    return {
      items: Math.min(body.links.length, previewLimit(node, read)),
      more: typeof body.next === 'string' || body.links.length > previewLimit(node, read),
      ...(mappedCount ? { count: mappedCount } : {}),
    };
  }
  if (read.kind === 'subjectThreads' && Array.isArray(body.threads)) return { items: body.threads.length };
  if (read.kind === 'relations' && Array.isArray(body.relations)) {
    const count =
      isRecord(body.count) && typeof body.count.value === 'number'
        ? countFromLinks({ value: body.count.value, exact: body.count.exact === true }, body.relations.length)
        : undefined;
    return {
      items: Math.min(body.relations.length, previewLimit(node, read)),
      more: typeof body.next === 'string' || body.relations.length > previewLimit(node, read),
      ...(count ? { count } : {}),
    };
  }
  if (read.kind === 'search' && Array.isArray(body.subjects)) {
    return { items: body.subjects.length };
  }
  const listed =
    read.kind === 'accountPosts'
      ? body.posts
      : read.kind === 'accountThreads'
        ? body.threads
        : read.kind === 'accountCollections'
          ? body.collections
          : undefined;
  if (read.kind.startsWith('account') && Array.isArray(listed)) {
    // A list has no total, only a continuation: a shown count is exact when nothing follows.
    const items = Math.min(listed.length, previewLimit(node, read));
    return {
      items,
      more: body.next != null || listed.length > items,
      count: { value: listed.length, relation: body.next == null ? 'exact' : 'lower_bound' },
    };
  }
  if (read.kind === 'collections' && Array.isArray(body.collections)) {
    const count = isRecord(body.count) ? body.count : undefined;
    const items = Math.min(body.collections.length, previewLimit(node, read));
    return {
      items,
      more: typeof body.next === 'string' || body.collections.length > items,
      ...(typeof count?.value === 'number'
        ? {
            count: {
              value: count.value,
              relation: count.exact === true ? ('exact' as const) : ('lower_bound' as const),
            },
          }
        : {}),
    };
  }
  if (read.kind === 'subject' && isRecord(body.subject) && isRecord(body.subject.statements)) {
    const property = node.props.property;
    const held =
      typeof property === 'string' && Object.hasOwn(body.subject.statements, property)
        ? body.subject.statements[property]
        : undefined;
    const candidates = (Array.isArray(held) ? held : []) as Stmt[];
    const statements = (isRecord(body.subject.relationCounts) ? candidates : bestRank(candidates)).filter(
      (statement) =>
        statement.rank !== 'deprecated' &&
        statement.value.type === 'value' &&
        statement.property.data_type === 'wikibase-item' &&
        typeof statement.value.content === 'string',
    );
    const items = Math.min(statements.length, previewLimit(node, read));
    const count = typeof property === 'string' ? relationPreviewCount(body.subject, property) : undefined;
    return { items, ...(count ? { count } : {}) };
  }
  return;
}

/**
 * The tabs a subject page offers in the documented order. Overview and Details are offered whenever a template
 * defines them. Reviews and Discussion require an open read, including when that read is empty. A list view is omitted
 * when every preview that feeds it was read and every item in those lists fits in the overview.
 */
export function subjectTabs(page: {
  subject: string | null;
  context?: SelectedContext | undefined;
  continuation?: PageContinuation | undefined;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
  views?: readonly string[] | undefined;
  community?: SubjectCommunity;
}): ViewTab[] {
  const defined = new Set((page.views ?? ['overview', 'discussion', 'details']).filter(isView));
  const document = page.document as CompositionDocument;
  const plan = planReads(platformRegistry, document, {
    subject: page.subject,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  });
  const profile = accountProfile(page);
  // A view the overview previews from an account's data has data only when the preview returned some.
  const driven = new Set<View>();
  for (const node of walk(document.content)) {
    const view = node.type.startsWith('Account') ? previewedView(node) : undefined;
    if (view) driven.add(view);
  }
  const sums = new Map<
    View,
    {
      items: number;
      lists: Map<string | undefined, (Count | undefined)[]>;
      fits: boolean;
      more: boolean;
      unavailable: boolean;
    }
  >();
  const openReads = new Set<View>();
  for (const node of walk(document.content)) {
    const view = previewedView(node);
    if (!view || !defined.has(view)) continue;
    const sum = sums.get(view) ?? {
      items: 0,
      lists: new Map<string | undefined, (Count | undefined)[]>(),
      fits: true,
      more: false,
      unavailable: false,
    };
    const key = Object.hasOwn(plan.nodes, node.props.id as string) ? plan.nodes[node.props.id as string] : undefined;
    const planned = key === undefined ? undefined : plan.reads[key];
    if (planned && (planned.kind !== 'subjectThreads' || (key !== undefined && page.reads[key]?.status === 200)))
      openReads.add(view);
    const counted = previewCount(node, planned, key === undefined ? undefined : page.reads[key]);
    const list = previewListKey(planned);
    const counts = sum.lists.get(list) ?? [];
    counts.push(counted?.count);
    sum.lists.set(list, counts);
    if (counted) {
      sum.items += counted.items;
      sum.more ||= counted.more === true || !!counted.count?.value;
      sum.fits =
        sum.fits &&
        !counted.more &&
        !!counted.count &&
        counted.count.relation === 'exact' &&
        counted.count.value === counted.items;
    } else {
      sum.fits = false;
      const status = key === undefined ? undefined : page.reads[key]?.status;
      // Only an explicit dependency failure establishes an unavailable read; absent and concealed reads stay closed.
      sum.unavailable ||= status !== undefined && status >= 500;
    }
    sums.set(view, sum);
  }
  return VIEWS.flatMap((view): ViewTab[] => {
    if (!defined.has(view) || !viewIsPublic(profile, view)) return [];
    if (OPEN_READ_VIEWS.has(view)) {
      if (!openReads.has(view)) return [];
      const sum = sums.get(view);
      const count = sum ? navigationCount(sum.lists.values()) : undefined;
      return [{ view, ...(sum && sum.items > 0 && count ? { count } : {}) }];
    }
    if (ALWAYS.has(view) && !driven.has(view)) return [{ view }];
    const sum = sums.get(view);
    if (!sum || (sum.items === 0 && !sum.more && !sum.unavailable)) return [];
    if (!ALWAYS.has(view) && sum.fits) return [];
    const count = navigationCount(sum.lists.values());
    return [{ view, ...(count ? { count } : {}) }];
  });
}
