import { useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useOperationAdmission } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { readerSessionSource } from '../reader/lifetime';
import { useSession } from '../session/query';
import { isKnowledgeId } from './private-knowledge';
import {
  readKnowledgeNavigationVisit,
  readKnowledgeOrganizationVisit,
  prepareKnowledgeOrganizationVisit,
  moveKnowledgeOrganizationPlacement,
} from './private-server';
import {
  KnowledgeNavigationEntry,
  type KnowledgeNavigationAccess,
  type KnowledgeNavigationOperations,
} from './navigation-page';
import type { KnowledgeNavigationAddress } from './navigation-read';
import { knowledgeNavigationBinding } from './navigation-return';
import { useKnowledgeNavigationReturn } from './navigation-return-link';
import { knowledgeLink } from './workspace';

/** Public SSR renders preparation only. Account-private operands start after browser session/exposure admission. */
export function KnowledgeNavigationRoute({ notebookId, subjectId }: { notebookId?: string; subjectId?: string }) {
  const client = useQueryClient();
  const returning = useKnowledgeNavigationReturn();
  const session = useSession();
  const source = readerSessionSource(client);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const lifetime = viewerExposureLifetime(client);
  const exposure = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot, lifetime.getServerSnapshot);
  const owned = useOperationAdmission('knowledge_notebook.owned_list');
  const outline = useOperationAdmission('knowledge_notebook.outline');
  const move = useOperationAdmission('knowledge_notebook.move_placement');
  const history = useOperationAdmission('knowledge_notebook.structure_history');
  const create = useOperationAdmission('knowledge_notebook.create');
  const admission = notebookId === undefined ? owned : outline;
  const locale = getLocale();
  const viewer = session.state === 'signed-in' ? session.subject : null;
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  let exposureRevision = 'closed';
  const exposureKey = exposure.state === 'signed-in' ? viewerExposureQuery(exposure.observation).queryKey : undefined;
  const revision = () => {
    const state = exposureKey ? client.getQueryState(exposureKey) : undefined;
    return exposure.state === 'signed-in'
      ? JSON.stringify([
          exposure.observation.id,
          state?.status,
          state?.dataUpdateCount,
          state?.dataUpdatedAt,
          state?.isInvalidated,
        ])
      : 'closed';
  };
  if (exposure.state === 'signed-in' && exposure.observation.subject === viewer) exposureRevision = revision();
  let access: KnowledgeNavigationAccess = 'preparing';
  if (session.state === 'signed-out') access = 'signed-out';
  else if (session.state === 'unavailable') access = 'unavailable';
  else if (
    viewer &&
    isKnowledgeId(viewer) &&
    csrfToken &&
    exposure.state === 'signed-in' &&
    exposure.observation.subject === viewer
  )
    access = admission === 'available' ? 'available' : admission === 'unknown' ? 'preparing' : admission;
  const binding =
    viewer && csrfToken
      ? knowledgeNavigationBinding(viewer, csrfToken, sessionRevision, exposureRevision, locale)
      : 'closed';
  const operations = useMemo<KnowledgeNavigationOperations>(
    () => ({
      read: (request) =>
        readKnowledgeNavigationVisit({
          data: { request, expected: { viewer, csrfToken } },
          headers: { 'X-CSRF-Token': csrfToken ?? '' },
        }),
      ...(notebookId !== undefined && move === 'available' && history === 'available'
        ? {
            organization: {
              read: (request: import('./organization-read').OrganizationRequest) =>
                readKnowledgeOrganizationVisit({
                  data: { request, expected: { viewer, csrfToken } },
                  headers: { 'X-CSRF-Token': csrfToken ?? '' },
                }),
              prepare: () =>
                prepareKnowledgeOrganizationVisit({
                  data: { viewer, csrfToken },
                  headers: { 'X-CSRF-Token': csrfToken ?? '' },
                }),
              move: (intent: import('./organization-read').OrganizationIntent) =>
                moveKnowledgeOrganizationPlacement({
                  data: intent,
                  headers: { 'X-CSRF-Token': intent.binding.csrfToken },
                }),
            },
          }
        : {}),
      current: () => source.snapshot() === sessionRevision && revision() === exposureRevision && getLocale() === locale,
      subscribeRetirement: (retire) => {
        const stopSession = source.subscribe(retire);
        const stopExposure = client.getQueryCache().subscribe((event) => {
          if (
            event.query.queryKey[0] === 'exposure' &&
            event.query.queryKey[1] === 'viewer' &&
            revision() !== exposureRevision
          )
            retire();
        });
        return () => {
          stopSession();
          stopExposure();
        };
      },
    }),
    [binding, notebookId, move, history],
  );
  const address = useMemo<KnowledgeNavigationAddress>(
    () =>
      notebookId === undefined
        ? { kind: 'owned', ...(subjectId === undefined ? {} : { subjectId }) }
        : { kind: 'outline', notebookId, parentPlacementId: null },
    [notebookId, subjectId],
  );
  const attached = subjectId !== undefined;
  if (attached && (session.state !== 'signed-in' || !viewer || !isKnowledgeId(subjectId))) return null;
  const navigation = (
    <KnowledgeNavigationEntry
      address={address}
      locale={locale}
      binding={binding}
      access={access}
      operations={operations}
      embedded={attached}
      returning={attached ? undefined : returning}
      retryAccess={() => {
        void client.invalidateQueries({ queryKey: ['session'], exact: true });
        if (exposureKey) void client.invalidateQueries({ queryKey: exposureKey, exact: true });
      }}
    />
  );
  if (!attached) return navigation;
  return (
    <section className="min-w-0 space-y-3" aria-label={m.knowledge_navigation_heading({}, { locale })}>
      <h2 className="text-base font-semibold">{m.knowledge_navigation_heading({}, { locale })}</h2>
      {create === 'available' ? (
        <Link to="/knowledge/new" search={{ subjectId }} preload={false} className={knowledgeLink}>
          {m.knowledge_private_create_kind({}, { locale })}
        </Link>
      ) : null}
      {navigation}
    </section>
  );
}
