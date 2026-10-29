import { isView, planReads, platformRegistry, VIEWS, type CompositionDocument, type View } from '@rezics/composition';
import { accountOf, viewIsPublic, type AccountProfile } from './account-read';
import type { Count } from './overview';
import { bestRank, isRecord, type Stmt } from './shared';

/** One tab of a subject page: a view, and how many items its data has when that is known. */
export type ViewTab = { view: View; count?: Count };

type Node = { type: string; props: Record<string, unknown> };
type Read = { status: number; body: unknown };

/** The view a `SubjectList` previews, by the property it lists. A list of any other property belongs to no view. */
const LIST_VIEWS: Readonly<Record<string, View>> = {
  'schema:exampleOfWork': 'editions',
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
  'wdt:P725': 'characters',
  'schema:character': 'appearances',
};

/** The view a list property previews, when it previews one. */
export function listView(property: unknown): View | undefined {
  return typeof property === 'string' && Object.hasOwn(LIST_VIEWS, property) ? LIST_VIEWS[property] : undefined;
}

/** The view a data component previews. Components that preview no view return nothing. */
export function previewedView(node: Node): View | undefined {
  switch (node.type) {
    case 'RelationGroups':
      return 'relations';
    case 'Appearances':
      return 'characters';
    case 'Credits':
      return node.props.direction === 'forward' ? 'credits' : 'works';
    case 'CollectionList':
      return 'lists';
    case 'AccountPosts':
      return 'posts';
    case 'AccountThreads':
      return node.props.threadKind === 'review' ? 'reviews' : undefined;
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
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
}): AccountProfile | undefined {
  if (!page.account) return;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: page.subject,
    account: page.account,
  });
  const key = Object.entries(plan.reads).find(([, read]) => read.kind === 'account')?.[0];
  const result = key === undefined ? undefined : page.reads[key];
  return result?.status === 200 ? accountOf(result.body) : undefined;
}

/** Views that are always offered when a template defines them. */
const ALWAYS: ReadonlySet<View> = new Set(['overview', 'reviews', 'discussion', 'details']);

function* walk(nodes: readonly unknown[]): Generator<Node> {
  for (const node of nodes) {
    if (!isRecord(node) || typeof node.type !== 'string' || !isRecord(node.props)) continue;
    yield node as Node;
    for (const value of Object.values(node.props)) if (Array.isArray(value)) yield* walk(value);
  }
}

function previewLimit(node: Node, read: { limit?: number } | undefined): number {
  if (typeof node.props.limit === 'number' && node.props.limit >= 1) return node.props.limit;
  return read?.limit ?? 12;
}

/** The items and total a preview read returned for one node. Nothing when the read did not succeed. */
function previewCount(
  node: Node,
  read: { kind: string; id?: string; limit?: number } | undefined,
  result: Read | undefined,
): { items: number; count?: Count } | undefined {
  if (!read || result?.status !== 200 || !isRecord(result.body)) return;
  const body = result.body;
  if (read.kind === 'links' && Array.isArray(body.links)) {
    const count = isRecord(body.count) ? body.count : undefined;
    return {
      items: Math.min(body.links.length, previewLimit(node, read)),
      ...(typeof count?.value === 'number'
        ? { count: { value: Math.max(count.value, body.links.length), exact: count.exact === true } }
        : {}),
    };
  }
  if (read.kind === 'search' && Array.isArray(body.subjects)) {
    const total = isRecord(body.total) ? body.total : undefined;
    return {
      items: body.subjects.length,
      count: {
        value: typeof total?.value === 'number' ? Math.max(total.value, body.subjects.length) : body.subjects.length,
        exact: total ? total.relation !== 'lower_bound' : true,
      },
    };
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
    return { items, count: { value: listed.length, exact: body.next == null } };
  }
  if (read.kind === 'collections' && Array.isArray(body.collections)) {
    const count = isRecord(body.count) ? body.count : undefined;
    const items = Math.min(body.collections.length, previewLimit(node, read));
    return {
      items,
      count: {
        value:
          typeof count?.value === 'number' ? Math.max(count.value, body.collections.length) : body.collections.length,
        exact: true,
      },
    };
  }
  if (read.kind === 'subject' && isRecord(body.subject) && isRecord(body.subject.statements)) {
    const property = node.props.property;
    const held =
      typeof property === 'string' && Object.hasOwn(body.subject.statements, property)
        ? body.subject.statements[property]
        : undefined;
    const statements = bestRank((Array.isArray(held) ? held : []) as Stmt[]).filter(
      (statement) =>
        statement.value.type === 'value' &&
        statement.property.data_type === 'wikibase-item' &&
        typeof statement.value.content === 'string',
    );
    const items = Math.min(statements.length, previewLimit(node, read));
    return { items, count: { value: statements.length, exact: true } };
  }
  return;
}

/**
 * The tabs a subject page offers: the views its templates define, in the documented order, minus those without data.
 * Overview, Reviews, Discussion and Details are offered whenever a template defines them. A list view is omitted
 * when every preview that feeds it was read and every item in those lists fits in the overview.
 */
export function subjectTabs(page: {
  subject: string | null;
  account?: { id: string; handle: string } | undefined;
  document: unknown;
  reads: Record<string, Read>;
  views?: readonly string[] | undefined;
}): ViewTab[] {
  const defined = new Set((page.views ?? ['overview', 'discussion', 'details']).filter(isView));
  const document = page.document as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: page.subject, account: page.account ?? null });
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
      value: number;
      exact: boolean;
      previews: number;
      counted: number;
      fits: boolean;
      hasCount: boolean;
    }
  >();
  for (const node of walk(document.content)) {
    const view = previewedView(node);
    if (!view || !defined.has(view)) continue;
    const sum = sums.get(view) ?? {
      items: 0,
      value: 0,
      exact: true,
      previews: 0,
      counted: 0,
      fits: true,
      hasCount: true,
    };
    sum.previews += 1;
    const key = Object.hasOwn(plan.nodes, node.props.id as string) ? plan.nodes[node.props.id as string] : undefined;
    const planned = key === undefined ? undefined : plan.reads[key];
    const counted = previewCount(node, planned, key === undefined ? undefined : page.reads[key]);
    if (counted) {
      sum.counted += 1;
      sum.items += counted.items;
      if (counted.count) {
        sum.value += counted.count.value;
        sum.exact = sum.exact && counted.count.exact;
      } else {
        sum.hasCount = false;
      }
      sum.fits = sum.fits && !!counted.count && counted.count.exact && counted.count.value === counted.items;
    } else {
      sum.fits = false;
    }
    sums.set(view, sum);
  }
  return VIEWS.flatMap((view): ViewTab[] => {
    if (!defined.has(view) || !viewIsPublic(profile, view)) return [];
    if (ALWAYS.has(view) && !driven.has(view)) return [{ view }];
    const sum = sums.get(view);
    if (!sum || sum.items === 0) return [];
    if (!ALWAYS.has(view) && sum.fits && sum.previews === sum.counted) return [];
    return [{ view, ...(sum.hasCount ? { count: { value: sum.value, exact: sum.exact } } : {}) }];
  });
}
