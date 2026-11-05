import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from '../../paraglide/messages.js';
import { ViewHeading } from '../pages/view-heading';
import type { CandidateTransport } from '../../subject/candidate-review';
import { EditorFailure } from './statement-editor-view';
import type { EditorRead } from './statement-editor';
import type { FactsTransport } from './subject-facts';
import { SubjectFacts } from './subject-facts-view';
import { identifierFields } from './identifiers-profile';
import type { IdentifierVisitOrigin } from './identifier-current-visit';
import { identifierOriginHref, identifierReviewHref } from './identifier-current-visit';
import { candidateContext } from '../../subject/candidates';
import { subjectHref } from '../../subject/subject-href';

export type IdentifiersProfileProps = {
  id: string;
  locale: string;
  session: string;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  initialReview?: { property: string; candidate: string } | undefined;
  origin?: IdentifierVisitOrigin | undefined;
  editorHref?: string | undefined;
  originHref?: string | undefined;
  globalHref?: string | undefined;
};

/** A scoped presentation of the ordinary fact workspace, with its native controls and commands. */
export const IdentifiersProfile = catalogueEditor(IdentifiersProfileLive);

function IdentifiersProfileLive({
  id,
  locale,
  session,
  transport,
  review,
  initialReview,
  origin,
  editorHref,
  originHref,
  globalHref,
}: IdentifiersProfileProps) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [
      'catalogue-identifiers',
      id,
      locale,
      origin?.context ?? null,
      origin?.realm ?? null,
      lifetime.generation,
    ],
    queryFn: transport.read,
    enabled: session === 'signed-in',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [retained, setRetained] = useState<Extract<EditorRead, { ok: true }> | undefined>();
  const current =
    query.data?.ok && query.data.public.subject.id === id && query.data.public.subject.context === candidateContext
      ? query.data
      : undefined;
  if (current && retained !== current) setRetained(current);
  const readable = session === 'signed-in' && !query.isError && !query.isFetching && !!current;
  return (
    <section className="flex flex-col gap-4" data-slot="identifiers-profile">
      {!readable && (
        <div className="flex flex-col gap-4 p-6">
          <ViewHeading label={m.identifiers_title({}, o)} headingClassName="font-sans" />
          {session === 'signed-out' ? (
            <p role="status">{m.catalogue_create_signed_out({}, o)}</p>
          ) : session === 'unavailable' || query.isError ? (
            <EditorFailure reason="unavailable" locale={locale} />
          ) : query.data && !query.data.ok ? (
            <EditorFailure reason={query.data.reason} locale={locale} />
          ) : query.data?.ok && current === undefined ? (
            <EditorFailure reason="stale" locale={locale} />
          ) : (
            <p role="status">{m.candidate_loading({}, o)}</p>
          )}
          {session === 'signed-in' && !query.isFetching && (
            <button type="button" className="text-start underline" onClick={() => void query.refetch()}>
              {m.correction_reload({}, o)}
            </button>
          )}
        </div>
      )}
      {retained && (
        <div hidden={!readable}>
          <SubjectFacts
            initial={retained}
            locale={locale}
            transport={transport}
            review={review}
            initialReview={initialReview}
            profile={{
              properties: identifierFields,
              title: m.identifiers_title({}, o),
              intro: m.identifiers_intro({}, o),
              empty: m.identifiers_empty({}, o),
              path: 'identifiers',
              editorHref: editorHref ?? `${subjectHref({ id, label }, locale).href}/identifiers`,
              reviewHref: (property, candidate) =>
                identifierReviewHref(
                  editorHref ?? `${subjectHref({ id, label }, locale).href}/identifiers`,
                  property,
                  candidate,
                ),
            }}
            profileIntro={
              origin?.kind === 'realm' ? (
                <div className="space-y-2">
                  <p>{m.identifiers_global_only_notice({}, o)}</p>
                  {originHref && (
                    <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={originHref}>
                      {m.identifiers_return_origin({}, o)}
                    </a>
                  )}
                </div>
              ) : origin?.kind === 'unsupported' ? (
                <div className="space-y-2">
                  <p>{m.identifiers_global_only_notice({}, o)}</p>
                  <a
                    className="inline-flex min-h-11 items-center underline underline-offset-4"
                    href={globalHref ?? identifierOriginHref({ id, label }, locale)}
                  >
                    {m.identifiers_open_global_subject({}, o)}
                  </a>
                </div>
              ) : undefined
            }
          />
        </div>
      )}
    </section>
  );
}
