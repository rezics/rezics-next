import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from '../../paraglide/messages.js';
import { ViewHeading } from '../pages/view-heading';
import type { CandidateTransport } from '../../subject/candidate-review';
import { EditorFailure } from './statement-editor-view';
import type { EditorRead } from './statement-editor';
import type { FactsTransport } from './subject-facts';
import { SubjectFacts } from './subject-facts-view';
import { identifierFields } from './identifiers-profile';

export type IdentifiersProfileProps = {
  id: string;
  locale: string;
  session: string;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  initialReview?: { property: string; candidate: string } | undefined;
};

/** A scoped presentation of the ordinary fact workspace, with its native controls and commands. */
export const IdentifiersProfile = catalogueEditor(IdentifiersProfileLive);

function IdentifiersProfileLive({ id, locale, session, transport, review, initialReview }: IdentifiersProfileProps) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['catalogue-identifiers', id, locale], lifetime.generation],
    queryFn: transport.read,
    enabled: session === 'signed-in',
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<Extract<EditorRead, { ok: true }> | undefined>(undefined);
  if (query.data?.ok && query.data.public.subject.id === id) retained.current = query.data;
  const readable =
    session === 'signed-in' &&
    !query.isError &&
    !query.isFetching &&
    query.data?.ok &&
    query.data.public.subject.id === id;
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
          ) : query.data?.ok && query.data.public.subject.id !== id ? (
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
      {retained.current && (
        <div hidden={!readable}>
          <SubjectFacts
            initial={retained.current}
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
            }}
          />
        </div>
      )}
    </section>
  );
}
