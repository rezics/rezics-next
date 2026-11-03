import { createFileRoute, notFound } from '@tanstack/react-router';
import { GraphBrowserSession } from '../../features/pages/graph-browser/session';
import { validatePageRealm } from '../../features/pages/view-cursor';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug/graph')({
  staticData: { publicCache: false },
  validateSearch: (search: Record<string, unknown>) => {
    const property = search.property;
    const direction = search.direction;
    const depth = search.depth;
    const node = search.node;
    const edge = search.edge;
    if (property !== undefined && (typeof property !== 'string' || property.length > 512)) throw notFound();
    if (direction !== undefined && direction !== 'out' && direction !== 'in' && direction !== 'both') throw notFound();
    if (depth !== undefined && depth !== '1' && depth !== '2' && depth !== 1 && depth !== 2) throw notFound();
    if (node !== undefined && (typeof node !== 'string' || !/^[0-9a-f-]{36}$/i.test(node))) throw notFound();
    if (edge !== undefined && (typeof edge !== 'string' || !/^[0-9a-f-]{36}$/i.test(edge))) throw notFound();
    return {
      property: typeof property === 'string' ? property : undefined,
      direction: typeof direction === 'string' ? direction : undefined,
      depth: depth === '2' || depth === 2 ? 2 : depth === '1' || depth === 1 ? 1 : undefined,
      node: typeof node === 'string' ? node : undefined,
      edge: typeof edge === 'string' ? edge : undefined,
      realm: validatePageRealm(search.realm),
    };
  },
  head: () => ({ meta: [{ title: m.graph_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: GraphRoute,
});

function GraphRoute() {
  const { id } = Route.useParams();
  const { property, direction, depth, node, edge } = Route.useSearch();
  return (
    <GraphBrowserSession
      key={`${id}:${getLocale()}:${property ?? ''}:${direction ?? ''}:${depth ?? ''}`}
      id={id}
      locale={getLocale()}
      property={property}
      direction={direction}
      depth={depth}
      node={node}
      edge={edge}
    />
  );
}
