import { candidateSession } from '../../../subject/candidate-lifetime';
import { editorRequest } from '../editor-request';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { useCallback, useEffect, useRef } from 'react';
import { useSession } from '../../../session/query';
import { csrfHeaders } from '../../../threads/composer';
import { m } from '../../../paraglide/messages.js';
import { candidateContext } from '../../../subject/candidates';
import { relationTargetSearch } from '../relation-editor-search';
import { readSubjectRelationEditor, proposeSubjectRelation, confirmSubjectRelation } from '../relation-editor-actions';
import { readCorrection } from '../statement-editor-actions';
import { submitFactCorrection } from '../subject-facts-actions';
import { readSubjectCandidates, confirmSubjectCandidate } from '../../pages/curate-actions';
import { readSubjectCatalogueFile } from './actions';
import { CatalogueFileProfilePage } from './view';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueFileSourceReturnHref } from '../catalogue-file-reader/navigation';
import {
  catalogueFileGlobalHref,
  type CatalogueFileCorrectionOrigin,
} from './origin';

const actionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center whitespace-normal break-words py-2 underline-offset-4 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

export function CatalogueFileProfileContextUnavailable({
  locale,
  returnHref,
  globalHref,
}: {
  locale: string;
  returnHref?: string | undefined;
  globalHref: string;
}) {
  const o = { locale: locale as never };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6" data-slot="catalogue-file-context-unsupported">
      <h1 ref={heading} className="font-sans text-2xl font-semibold" tabIndex={-1}>
        {m.catalogue_file_title({}, o)}
      </h1>
      <p role="status">{m.catalogue_file_context_unsupported({}, o)}</p>
      <nav className="flex flex-wrap gap-2">
        {returnHref ? (
          <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={returnHref}>
            {m.catalogue_file_reader_return({}, o)}
          </a>
        ) : null}
        <a className={`${buttonVariants({ variant: 'outline' })} ${actionClass}`} href={globalHref}>
          {m.catalogue_file_global_correction_entry({}, o)}
        </a>
      </nav>
    </section>
  );
}

export const CatalogueFileProfileSession = candidateSession(CatalogueFileProfileSessionLive);

function CatalogueFileProfileSessionLive({
  id,
  locale,
  context,
  realm,
  initialReview,
  returnSourceId,
  origin,
  originInvalid,
  restartWithoutOrigin,
  returnHref,
}: {
  id: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
  initialReview?: { property: string; candidate: string } | undefined;
  returnSourceId?: string | undefined;
  origin?: CatalogueFileCorrectionOrigin | undefined;
  originInvalid?: boolean | undefined;
  restartWithoutOrigin?: boolean | undefined;
  returnHref?: string | undefined;
}) {
  const editorWork = useCatalogueLifetime('transport');
  const { state } = useSession();
  const search = useCallback(
    (text: string, signal: AbortSignal) => relationTargetSearch(text, signal, locale),
    [locale],
  );
  if (realm || (context && context !== candidateContext))
    return (
      <CatalogueFileProfileContextUnavailable
        locale={locale}
        returnHref={returnHref ?? (returnSourceId ? catalogueFileSourceReturnHref(returnSourceId, locale) : undefined)}
        globalHref={catalogueFileGlobalHref(id, locale, returnSourceId, returnHref)}
      />
    );
  if (state !== 'signed-in')
    return (
      <p role="status">
        {state === 'signed-out'
          ? m.catalogue_create_signed_out({}, { locale: locale as never })
          : m.candidate_loading({}, { locale: locale as never })}
      </p>
    );
  return (
    <CatalogueFileProfilePage
      id={id}
      locale={locale}
      search={search}
      initialReview={initialReview}
      returnSourceId={returnSourceId}
      returnHref={returnHref}
      origin={origin}
      originInvalid={originInvalid}
      restartWithoutOrigin={restartWithoutOrigin}
      transport={{
        read: (stream, cursor, detail, session) =>
          readSubjectCatalogueFile({
            data: editorRequest({ id, stream, cursor, detail, session }, editorWork),
            headers: csrfHeaders(),
          }),
        facts: {
          read: () => readCorrection({ data: editorRequest({ id }, editorWork), headers: csrfHeaders() }),
          propose: (data) => submitFactCorrection({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        },
        relation: (holder) => ({
          read: (slot, cursor, session) =>
            readSubjectRelationEditor({
              data: editorRequest({ id: holder, slot, cursor, session }, editorWork),
              headers: csrfHeaders(),
            }),
          propose: (data) => proposeSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
          confirm: (data) => confirmSubjectRelation({ data: editorRequest(data, editorWork), headers: csrfHeaders() }),
        }),
        review: (_property, initialSession) => ({
          read: async (property, cursor, session = initialSession, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            return readSubjectCandidates({
              data: { expectedReader: work.reader, id, property, cursor, session },
              headers: csrfHeaders(),
            });
          },
          confirm: async (command, work) => {
            if (!work?.live()) return { ok: false, reason: 'denied' };
            return confirmSubjectCandidate({ data: command, headers: csrfHeaders() });
          },
        }),
      }}
    />
  );
}
