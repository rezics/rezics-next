import { candidateSession, useCandidateReading } from '../../pages/candidate-reading-application';
import { editorRequest } from '../editor-request';
import { useCallback } from 'react';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../../pages/visit-host-port';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { readSubjectProducerHistory } from './actions';
import { ProducerHistoryAdmission } from '../../pages/producer-history-reading/admission';
import { ProducerHistoryPage } from '../../pages/producer-history';
import { catalogueEntries } from '../catalogue-entry';
import { subjectHref } from '../../../subject/subject-href';
import { withProducerHistoryReturn } from './visit';

export const ProducerHistorySession = candidateSession(ProducerHistorySessionLive);

export function ProducerHistoryOriginChoice({
  id,
  locale,
  returnTo,
}: {
  id: string;
  locale: string;
  returnTo?: string | undefined;
}) {
  const overview = subjectHref({ id, label: '' }, locale).href;
  const global = catalogueEntries.producerHistory({ id, locale });
  const globalHref = returnTo ? withProducerHistoryReturn(global.href, returnTo, { id, locale }) : global.href;
  if (!globalHref) throw new Error('Expected the admitted Organization return to fit a Global producer visit');
  return (
    <section className="space-y-3" aria-label={m.producer_history_title()}>
      <p>{m.producer_history_context_unavailable()}</p>
      <p>{m.producer_history_global_notice()}</p>
      <div className="flex flex-wrap gap-3">
        <a className="underline" href={returnTo ?? overview}>
          {m.producer_history_back()}
        </a>
        <a className="underline" href={globalHref}>
          {m.producer_history_global_visit()}
        </a>
      </div>
    </section>
  );
}

function ProducerHistorySessionLive({
  id,
  locale,
  context,
  realm,
  via,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  via?: string | undefined;
}) {
  const editorWork = useCandidateReading({
    candidate: 'producer-history-transport',
    locale,
    address: [id, context, realm, via],
  });
  const observed = useSession();
  const { state } = observed;
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (realm || (context && context !== candidateContext))
    return <ProducerHistoryOriginChoice id={id} locale={locale} returnTo={via} />;
  if (state !== 'signed-in') return <p>{state === 'signed-out' ? m.relation_sign_in() : m.candidate_loading()}</p>;
  return (
    <ProducerHistoryAdmission observed={observed} address={`${id}:${locale}`} locale={locale}>
      <ProducerHistoryPage
        id={id}
        locale={locale}
        returnTo={via}
        search={search}
        transport={{
          read: (stream, cursor, session) =>
            readSubjectProducerHistory({
              data: editorRequest({ id, stream, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          relation: (holder) => ({
            read: (slot, cursor, session) =>
              readSubjectRelationEditor({
                data: editorRequest({ id: holder, slot, cursor, session }, editorWork),
                headers: csrfHeaders(),
              }),
            propose: (data) =>
              proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
            confirm: (data) =>
              confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          }),
        }}
      />
    </ProducerHistoryAdmission>
  );
}
