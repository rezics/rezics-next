import { useMemo } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { readSubjectGraphBrowser } from './actions';
import { GraphBrowserPage } from './view';
import type { GraphBrowserRouteState, GraphSelection, GraphTruncation } from './index';

export const GraphBrowserSession = candidateSession(GraphBrowserSessionLive);

function GraphBrowserSessionLive({
  id,
  locale,
  property,
  direction,
  depth,
  node,
  edge,
  from,
  to,
  edgeProperty,
  graphPath,
  onNavigate,
}: {
  id: string;
  locale: string;
  property?: GraphBrowserRouteState['property'];
  direction?: GraphBrowserRouteState['direction'];
  depth?: GraphBrowserRouteState['depth'];
  node?: GraphBrowserRouteState['node'];
  edge?: GraphBrowserRouteState['edge'];
  from?: GraphBrowserRouteState['from'];
  to?: GraphBrowserRouteState['to'];
  edgeProperty?: GraphBrowserRouteState['edgeProperty'];
  graphPath: string;
  onNavigate: (state: GraphBrowserRouteState) => void | Promise<unknown>;
}) {
  const work = useCatalogueLifetime('graph-explore');
  const { state, subject } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  const transport = useMemo(
    () => ({
      read: (query: GraphBrowserQuery) =>
        readSubjectGraphBrowser({
          data: {
            id,
            locale,
            expectedReader,
            ...query,
          },
          headers: csrfHeaders(),
        }),
    }),
    [id, locale, expectedReader],
  );
  if (state === 'unknown') return <p>{m.graph_explore_loading({}, { locale: locale as never })}</p>;
  return (
    <GraphBrowserPage
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
      graphPath={graphPath}
      onNavigate={onNavigate}
      transport={transport}
      reader={work.reader || subject || undefined}
    />
  );
}

export type GraphBrowserQuery = Omit<GraphBrowserRouteState, 'property' | 'depth'> & {
  property?: string | readonly string[] | undefined;
  depth?: string | number | undefined;
  expansion?: GraphTruncation | undefined;
  session?: string | undefined;
  selection?: GraphSelection | undefined;
};
