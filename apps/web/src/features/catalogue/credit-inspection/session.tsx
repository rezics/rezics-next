import { useMemo } from 'react';
import { candidateSession, useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { editorRequest } from '../editor-request';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { loadCreditRevision } from './actions';
import { CreditInspection } from './view';
import type { CreditAssertion, CreditVisit } from './model';

export const CreditInspectionSession = candidateSession(function CreditInspectionSession({
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
  const work = useCatalogueLifetime('credit-inspection');
  const observed = useSession();
  const transport = useMemo(
    () => ({
      read: (slot?: import('../../../subject/relation-candidates').RelationSlot, cursor?: string, session?: string) =>
        readSubjectRelationEditor({
          data: editorRequest({ id: credit.holder, slot, cursor, session }, work),
          headers: csrfHeaders(),
        }),
      propose: (data: import('../../../subject/relation-candidates').RelationProposal) =>
        proposeSubjectRelation({ data: editorRequest(data, work), headers: csrfHeaders() }),
      confirm: (data: import('../../../subject/relation-candidates').RelationConfirmation) =>
        confirmSubjectRelation({ data: editorRequest(data, work), headers: csrfHeaders() }),
    }),
    [credit.holder, work],
  );
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
});
