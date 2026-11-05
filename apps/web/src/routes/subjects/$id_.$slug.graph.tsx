import { createFileRoute, notFound, useLocation } from '@tanstack/react-router';
import { GraphBrowserSession } from '../../features/pages/graph-browser/session';
import {
  graphPublicPath,
  graphPublicVisitReturn,
  graphPublicVisitUnsupported,
  parseGraphPublicVisit,
} from '../../features/pages/graph-browser/public-visit';
import { GraphPublicVisitNotice } from '../../features/pages/graph-browser/public-visit-view';
import type { GraphBrowserRouteState } from '../../features/pages/graph-browser';
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
    const from = search.from;
    const to = search.to;
    const edgeProperty = search.edgeProperty;
    if (property !== undefined && (typeof property !== 'string' || property.length > 512)) throw notFound();
    if (direction !== undefined && direction !== 'out' && direction !== 'in' && direction !== 'both') throw notFound();
    if (depth !== undefined && depth !== '1' && depth !== '2' && depth !== 1 && depth !== 2) throw notFound();
    if (node !== undefined && (typeof node !== 'string' || !/^[0-9a-f-]{36}$/i.test(node))) throw notFound();
    if (edge !== undefined && (typeof edge !== 'string' || !/^[0-9a-f-]{36}$/i.test(edge))) throw notFound();
    if (from !== undefined && (typeof from !== 'string' || !/^[0-9a-f-]{36}$/i.test(from))) throw notFound();
    if (to !== undefined && (typeof to !== 'string' || !/^[0-9a-f-]{36}$/i.test(to))) throw notFound();
    if (edgeProperty !== undefined && (typeof edgeProperty !== 'string' || !/^[^\s]{1,128}$/.test(edgeProperty)))
      throw notFound();
    if (
      (node !== undefined && edge !== undefined) ||
      ((from !== undefined || to !== undefined || edgeProperty !== undefined) && edge === undefined) ||
      (edge !== undefined && (from === undefined || to === undefined || edgeProperty === undefined))
    )
      throw notFound();
    return {
      property: typeof property === 'string' ? property : undefined,
      direction: typeof direction === 'string' ? direction : undefined,
      depth: depth === '2' || depth === 2 ? 2 : depth === '1' || depth === 1 ? 1 : undefined,
      node: typeof node === 'string' ? node : undefined,
      edge: typeof edge === 'string' ? edge : undefined,
      from: typeof from === 'string' ? from : undefined,
      to: typeof to === 'string' ? to : undefined,
      edgeProperty: typeof edgeProperty === 'string' ? edgeProperty : undefined,
      realm: validatePageRealm(search.realm),
      origin: search.origin === undefined ? undefined : typeof search.origin === 'string' ? search.origin : '!',
      publicReturn:
        search.publicReturn === undefined
          ? undefined
          : typeof search.publicReturn === 'string'
            ? search.publicReturn
            : '!',
    };
  },
  head: () => ({ meta: [{ title: m.graph_explore_title() }, { name: 'robots', content: 'noindex,follow' }] }),
  component: GraphRoute,
});

function GraphRoute() {
  const { id } = Route.useParams();
  const { property, direction, depth, node, edge, from, to, edgeProperty } = Route.useSearch();
  const location = useLocation();
  const navigate = Route.useNavigate();
  const locale = getLocale();
  const graphPath = graphPublicPath(location.pathname, locale);
  const visit = parseGraphPublicVisit(location.searchStr, location.hash, id, locale, graphPath);
  if (visit?.kind === 'invalid' || graphPublicVisitUnsupported(visit))
    return <GraphPublicVisitNotice locale={locale} path={graphPath} visit={visit ?? { kind: 'invalid' }} />;
  function updateGraphState(state: GraphBrowserRouteState) {
    return navigate({ search: (previous) => ({ ...previous, ...state }) });
  }
  return (
    <GraphBrowserSession
      key={JSON.stringify([id, locale, visit])}
      id={id}
      locale={locale}
      property={property}
      direction={direction}
      depth={depth}
      node={node}
      edge={edge}
      from={from}
      to={to}
      edgeProperty={edgeProperty}
      visit={visit}
      publicReturnHref={graphPublicVisitReturn(visit)}
      graphPath={graphPath}
      onNavigate={updateGraphState}
    />
  );
}
