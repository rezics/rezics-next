import { useMemo } from 'react';
import { candidateSession, useCandidateReading } from '../candidate-reading-application';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { readSubjectGraphBrowser } from './actions';
import { GraphBrowserPage } from './view';
import type { GraphBrowserRouteState, GraphSelection, GraphTruncation } from './index';
import type { GraphPublicVisit } from './public-visit';

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
  visit,
  publicReturnHref,
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
  visit?: GraphPublicVisit | undefined;
  publicReturnHref?: string | undefined;
  graphPath: string;
  onNavigate: (state: GraphBrowserRouteState) => void | Promise<unknown>;
}) {
  const work = useCandidateReading({ candidate: 'graph-explore', locale, address: id });
  const { state, subject } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
  const transport = useMemo(
    () => ({
      read: (query: GraphBrowserQuery, signal: AbortSignal) =>
        readSubjectGraphBrowser({
          data: {
            id,
            locale,
            expectedReader,
            ...query,
          },
          headers: csrfHeaders(),
          signal,
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
      visit={visit}
      publicReturnHref={publicReturnHref}
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
