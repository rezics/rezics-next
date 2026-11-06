import { useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CandidateReaderBoundary, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { browserObservation, cachedBrowserSession, type BrowserSession } from '../../../session';
import { csrfHeaders } from '../../../threads/composer';
import { editorRequest } from '../editor-request';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { loadCreditRevision } from './actions';
import { CreditInspection } from './view';
import type { CreditAssertion, CreditVisit } from './model';

function CreditInspectionBody({
  credit,
  visit,
  locale,
  title,
  propertyLabel,
  onClose,
  returnFocus,
  observed,
}: {
  credit: CreditAssertion;
  visit: CreditVisit;
  locale: string;
  title: string;
  propertyLabel: string;
  onClose: () => void;
  returnFocus?: (() => HTMLElement | null) | undefined;
  observed: BrowserSession;
}) {
  const work = useCatalogueLifetime('credit-inspection');
  const csrf = observed.csrfToken;
  const transport = useMemo(() => {
    const headers = csrf ? { 'X-CSRF-Token': csrf } : csrfHeaders();
    return {
      read: (slot?: import('../../../subject/relation-candidates').RelationSlot, cursor?: string, session?: string) =>
        readSubjectRelationEditor({
          data: editorRequest({ id: credit.holder, slot, cursor, session }, work),
          headers,
        }),
      propose: (data: import('../../../subject/relation-candidates').RelationProposal) =>
        proposeSubjectRelation({ data: editorRequest(data, work), headers }),
      confirm: (data: import('../../../subject/relation-candidates').RelationConfirmation) =>
        confirmSubjectRelation({ data: editorRequest(data, work), headers }),
    };
  }, [credit.holder, csrf, work]);
  return (
    <CreditInspection
      credit={credit}
      visit={visit}
      locale={locale}
      title={title}
      propertyLabel={propertyLabel}
      onClose={onClose}
      returnFocus={returnFocus}
      transport={transport}
      signedIn={observed.state === 'signed-in'}
      isCurrent={work.active}
      search={(text, signal) => relationTargetSearch(text, signal, locale)}
      metadata={() => {
        if (!work.active()) return Promise.resolve({ kind: 'unavailable' as const });
        return loadCreditRevision({
          data: {
            id: credit.holder,
            revision: credit.statement.rezics.revision,
            locale,
            expectedReader: work.reader || null,
          },
          headers: observed.csrfToken ? { 'X-CSRF-Token': observed.csrfToken } : {},
        });
      }}
    />
  );
}

/** Public inspect reads the page session cache. It does not start another session fetch. */
export function CreditInspectionSession({
  id,
  address,
  credit,
  visit,
  locale,
  title,
  propertyLabel,
  onClose,
  returnFocus,
}: {
  id: string;
  address: string;
  credit: CreditAssertion;
  visit: CreditVisit;
  locale: string;
  title: string;
  propertyLabel: string;
  onClose: () => void;
  returnFocus?: (() => HTMLElement | null) | undefined;
}) {
  const client = useQueryClient();
  const store = browserObservation(client);
  const revision = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const observed = cachedBrowserSession(client);
  const admission = useMemo(
    () => ({ reader: observed.subject ?? '', live: () => store.getSnapshot() === revision }),
    [observed.subject, revision, store],
  );
  return (
    <CandidateReaderBoundary admission={admission} observed={observed} address={JSON.stringify([id, locale, address])}>
      <CreditInspectionBody
        credit={credit}
        visit={visit}
        locale={locale}
        title={title}
        propertyLabel={propertyLabel}
        onClose={onClose}
        returnFocus={returnFocus}
        observed={observed}
      />
    </CandidateReaderBoundary>
  );
}
