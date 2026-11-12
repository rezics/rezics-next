import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOperationAdmission } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { readerSessionSource } from '../reader/lifetime';
import { useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { exportKnowledgePublicTransferRequest } from './transfer-server';
import { copyKnowledgeTransferRequest, exportKnowledgeOwnTransferRequest, prepareKnowledgeTransferRequest, readKnowledgeCopyRequest, readKnowledgeNavigationVisit } from './private-server';
import { KnowledgeTransferEntry } from './transfer-panel';
import type { KnowledgeTransferBinding, KnowledgeTransferSource } from './transfer';
import type { KnowledgeTransferOperations } from './transfer-visit';

/** Every callback rechecks the same caller lifetime; replacement closes private review and local download bytes. */
export function KnowledgeTransferCaller({ source, title, locale, binding = null, blocked = false, lifetime = '', onSourceLost }: {
  source: KnowledgeTransferSource;
  title: string;
  locale: string;
  binding?: KnowledgeTransferBinding | null;
  blocked?: boolean;
  lifetime?: string;
  onSourceLost?: () => void;
}) {
  const client = useQueryClient();
  const session = useSession();
  const sessionSource = readerSessionSource(client);
  const sessionRevision = useSyncExternalStore(sessionSource.subscribe, sessionSource.snapshot, sessionSource.serverSnapshot);
  const exposureSource = viewerExposureLifetime(client);
  const exposure = useSyncExternalStore(exposureSource.subscribe, exposureSource.getSnapshot, exposureSource.getServerSnapshot);
  const publicExport = useOperationAdmission('knowledge_document.public_export');
  const ownExport = useOperationAdmission('knowledge_document.own_export');
  const copy = useOperationAdmission('knowledge_document.copy');
  const owned = useOperationAdmission('knowledge_notebook.owned_list');
  const outline = useOperationAdmission('knowledge_notebook.outline');
  const privateRead = useOperationAdmission('knowledge_document.private_read');
  const viewer = session.state === 'signed-in' ? session.subject : null;
  const csrfToken = session.state === 'signed-in' ? session.csrfToken : null;
  const exposureKey = exposure.state === 'signed-in' ? viewerExposureQuery(exposure.observation).queryKey : null;
  const revision = () => {
    const current = exposureKey ? client.getQueryState(exposureKey) : client.getQueryState(['exposure', 'anonymous']);
    return JSON.stringify([exposure, current?.status, current?.dataUpdateCount, current?.dataUpdatedAt, current?.isInvalidated]);
  };
  const exposureRevision = revision();
  const admitted = !!viewer && !!csrfToken && exposure.state === 'signed-in' && exposure.observation.subject === viewer;
  const canExport = (source.representation === 'public' ? publicExport : ownExport) === 'available';
  const canCopy = admitted && [copy, owned, outline, privateRead].every((value) => value === 'available');
  const owner = JSON.stringify([source, viewer, csrfToken, sessionRevision, exposureRevision, locale, lifetime, binding, blocked, canExport, canCopy]);
  const active = useRef(owner);
  active.current = owner;
  const operations = useMemo<KnowledgeTransferOperations>(() => {
    const expected = { viewer: viewer!, csrfToken: csrfToken! };
    const headers = { 'X-CSRF-Token': csrfToken ?? '' };
    return {
      current: () => active.current === owner && sessionSource.snapshot() === sessionRevision && revision() === exposureRevision && getLocale() === locale,
      subscribeRetirement: (retire) => {
        const stopSession = sessionSource.subscribe(retire);
        const stopExposure = client.getQueryCache().subscribe((event) => {
          if (event.query.queryKey[0] === 'exposure' && revision() !== exposureRevision) retire();
        });
        const stopObservation = exposureSource.subscribe(retire);
        return () => { stopSession(); stopExposure(); stopObservation(); };
      },
      export: (selected) => selected.representation === 'public'
        ? exportKnowledgePublicTransferRequest({ data: selected })
        : exportKnowledgeOwnTransferRequest({ data: { source: selected, expected }, headers }),
      prepare: () => prepareKnowledgeTransferRequest({ data: expected, headers }),
      navigate: (request) => readKnowledgeNavigationVisit({ data: { request, expected }, headers }),
      copy: (intent) => copyKnowledgeTransferRequest({ data: { ...intent, ...intent.binding }, headers }),
      readback: (receipt) => readKnowledgeCopyRequest({ data: { receipt, expected }, headers }),
    };
  }, [owner]);
  return <KnowledgeTransferEntry key={owner} source={source} title={title} locale={locale} operations={operations} binding={binding} blocked={blocked} canExport={canExport} canCopy={canCopy} {...(onSourceLost ? { onSourceLost } : {})} />;
}
