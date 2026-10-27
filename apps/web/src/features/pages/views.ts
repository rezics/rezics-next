import { isView, planReads, platformRegistry, VIEWS, type CompositionDocument, type View } from '@rezics/composition';
import { bestRank, isRecord, type Stmt } from './shared';

/** One tab of a subject page: a view, and how many items its data has when that is known. */
export type ViewTab = { view: View; count?: { value: number; exact: boolean } };

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
    case 'SubjectList':
      return listView(node.props.property);
    default:
      return undefined;
  }
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

/** The items and total a preview read returned for one node. Nothing when the read did not succeed. */
function previewCount(
  node: Node,
  read: { kind: string; id?: string } | undefined,
  result: Read | undefined,
): { items: number; count: { value: number; exact: boolean } } | undefined {
  if (!read || result?.status !== 200 || !isRecord(result.body)) return;
  const body = result.body;
  if (read.kind === 'links' && Array.isArray(body.links)) {
    const count = isRecord(body.count) ? body.count : undefined;
    return {
      items: body.links.length,
      count: {
        value: typeof count?.value === 'number' ? Math.max(count.value, body.links.length) : body.links.length,
        exact: count ? count.exact === true : true,
      },
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
  if (read.kind === 'collections' && Array.isArray(body.collections)) {
    const count = isRecord(body.count) ? body.count : undefined;
    return {
      items: body.collections.length,
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
      (statement) => statement.value.type === 'value' && statement.property.data_type === 'wikibase-item',
    );
    return { items: statements.length, count: { value: statements.length, exact: true } };
  }
  return;
}

/**
 * The tabs a subject page offers: the views its templates define, in the documented order, minus those without data.
 * A view has data when a preview of it in the overview returned at least one item; Overview, Reviews, Discussion and
 * Details are offered whenever a template defines them. The count of a view is the sum of its previews' counts.
 */
export function subjectTabs(page: {
  subject: string | null;
  document: unknown;
  reads: Record<string, Read>;
  views?: readonly string[] | undefined;
}): ViewTab[] {
  const defined = new Set((page.views ?? ['overview', 'discussion', 'details']).filter(isView));
  const document = page.document as CompositionDocument;
  const plan = planReads(platformRegistry, document, { subject: page.subject });
  const sums = new Map<View, { items: number; value: number; exact: boolean }>();
  for (const node of walk(document.content)) {
    const view = previewedView(node);
    if (!view || !defined.has(view)) continue;
    const key = Object.hasOwn(plan.nodes, node.props.id as string) ? plan.nodes[node.props.id as string] : undefined;
    const planned = key === undefined ? undefined : plan.reads[key];
    const counted = previewCount(node, planned, key === undefined ? undefined : page.reads[key]);
    if (!counted) continue;
    const sum = sums.get(view) ?? { items: 0, value: 0, exact: true };
    sums.set(view, {
      items: sum.items + counted.items,
      value: sum.value + counted.count.value,
      exact: sum.exact && counted.count.exact,
    });
  }
  return VIEWS.flatMap((view): ViewTab[] => {
    if (!defined.has(view)) return [];
    if (ALWAYS.has(view)) return [{ view }];
    const sum = sums.get(view);
    return sum && sum.items > 0 ? [{ view, count: { value: sum.value, exact: sum.exact } }] : [];
  });
}
