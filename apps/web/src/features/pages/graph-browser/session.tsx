import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { readSubjectGraphBrowser } from './actions';
import { GraphBrowserPage } from './view';
import type { GraphSelection, GraphTruncation } from './index';

export const GraphBrowserSession = candidateSession(GraphBrowserSessionLive);

function GraphBrowserSessionLive({
  id,
  locale,
  property,
  direction,
  depth,
  node,
  edge,
}: {
  id: string;
  locale: string;
  property?: string | undefined;
  direction?: string | undefined;
  depth?: number | undefined;
  node?: string | undefined;
  edge?: string | undefined;
}) {
  const work = useCatalogueLifetime('graph-explore');
  const { state, subject } = useSession();
  const expectedReader = state === 'signed-in' ? work.reader : null;
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
      transport={{
        read: (query) =>
          readSubjectGraphBrowser({
            data: {
              id,
              locale,
              expectedReader,
              ...query,
            },
            headers: csrfHeaders(),
          }),
      }}
      {...(state === 'signed-in' && subject ? { reader: subject } : {})}
    />
  );
}

export type GraphBrowserQuery = {
  property?: string | readonly string[] | undefined;
  direction?: string | undefined;
  depth?: string | number | undefined;
  node?: string | undefined;
  edge?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  edgeProperty?: string | undefined;
  expansion?: GraphTruncation | undefined;
  session?: string | undefined;
  selection?: GraphSelection | undefined;
};
