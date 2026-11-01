import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { ViewHeadingActions } from '../pages/view-heading';
import { CandidateValue } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import type { CreateResult, CreatedReader } from './create-subject';
import { SubjectTermsEntry } from './subject-terms-entry';
import { AuthoredFieldEntry } from './authored-field-entry';
import { PublicationEditorEntry } from './publication-editor-entry';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { EditorFailure } from './statement-editor-view';
import { ScreenInitialFields, screenGroupLabel, type ScreenRow } from './screen-profile-fields';
import {
  screenCreateTypes,
  screenFactId,
  screenGroups,
  screenInitialFacts,
  screenName,
  type ScreenCommand,
  type ScreenRead,
  type ScreenGroup,
} from './screen-profile';

export type ScreenTransport = {
  load: () => Promise<ScreenRead>;
  create: (command: ScreenCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
  facts?: FactsTransport;
  review?: (property: string, session?: string) => CandidateTransport;
  relations?: RelationTransport;
};

const screenActionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const screenSummaryClassName =
  'min-h-11 max-w-full cursor-pointer py-2 font-semibold [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export const ScreenProfile = catalogueEditor(ScreenProfileLive);

function ScreenProfileLive({
  id,
  locale,
  session,
  transport,
  search,
  onNavigate,
}: {
  id?: string | undefined;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: ScreenTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['screen-profile', id, locale], lifetime.generation],
    queryFn: transport.load,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [drafts, setDrafts] = useState<Record<string, ScreenRow[]>>({});
  const retained = useRef<Extract<ScreenRead, { ok: true }>>(undefined);
  if (query.data?.ok) retained.current = query.data;
  // A failed creation metadata refresh must not unmount the term/fact drafts or their frozen request.
  const read = query.data?.ok ? query.data : !id ? retained.current : undefined;
  const subject = read?.public?.subject;
  const label = pickText(subject?.labels ?? {}, locale);
  const href = subject ? subjectHref({ id: subject.id, label: label.text }, locale).href : '';
  const intro = (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>{m.screen_intro({}, o)}</p>
      <p>{m.screen_native_help({}, o)}</p>
    </div>
  );
  if (!read)
    return (
      <article className="mx-auto w-full max-w-4xl min-w-0 space-y-5 p-4 sm:p-6">
        <ViewHeadingActions label={id ? m.screen_edit({}, o) : m.screen_title({}, o)} headingClassName="font-sans" />
        {query.isPending ? (
          <p role="status">{m.candidate_loading({}, o)}</p>
        ) : (
          <>
            {query.data && !query.data.ok && query.data.reason === 'concealed' ? (
              <p role="alert">{m.catalogue_create_concealed({}, o)}</p>
            ) : (
              <EditorFailure
                locale={locale}
                reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'}
              />
            )}
            <Button className={screenActionClassName} onClick={() => void query.refetch()}>
              {m.correction_retry({}, o)}
            </Button>
          </>
        )}
      </article>
    );
  if (!id)
    return (
      <div className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6">
        <header className="min-w-0 space-y-3">
          <ViewHeadingActions label={m.screen_title({}, o)} headingClassName="font-sans" />
          {intro}
        </header>
        <CreateSubjectForm
          locale={locale}
          session={session}
          onNavigate={onNavigate}
          transport={{
            definitions: async (refresh) => {
              const next = refresh ? (await query.refetch()).data : read;
              if (!lifetime.active()) return;
              return next?.ok ? { ok: true, types: screenCreateTypes(next.release, locale) } : { ok: false };
            },
            submit: (command) => transport.create(command as ScreenCommand),
            read: transport.read,
          }}
          profile={{
            title: m.screen_title({}, o),
            scope: 'screen-profile',
            hideHeading: true,
            href: `/${locale}/catalogue/screen`,
            labelLanguage: (type) => pickText(read.release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type) =>
              pickText(read.release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            prepare: (item) =>
              screenInitialFacts(
                read.release,
                item,
                (drafts[item.type] ?? []).map((row) => row.statement),
              ),
            fields: (type, disabled) => (
              <ScreenInitialFields
                key={type}
                type={type}
                release={read.release}
                locale={locale}
                disabled={disabled}
                search={search}
                rows={drafts[type] ?? []}
                change={(rows) => setDrafts((previous) => ({ ...previous, [type]: rows }))}
              />
            ),
            control: (pointer) =>
              pointer.startsWith('/statements/') ? screenFactId(pointer.split('/')[2] ?? '') : undefined,
          }}
        />
      </div>
    );
  if (!subject || !read.public) return <EditorFailure locale={locale} reason="unavailable" />;
  const current = { ok: true as const, release: read.release, public: read.public, source: null };
  return (
    <article className="mx-auto w-full max-w-4xl min-w-0 space-y-6 px-4 py-8 sm:px-6 [&_h2]:font-sans [&_h3]:font-sans">
      <ViewHeadingActions label={m.screen_edit({}, o)} headingClassName="font-sans" />
      <header className="min-w-0 space-y-3">
        <a
          href={href}
          lang={label.lang ?? undefined}
          className="inline-flex min-h-11 min-w-11 max-w-full items-center [overflow-wrap:anywhere] py-1 font-sans text-2xl font-semibold underline md:pointer-fine:min-h-8"
        >
          {label.text || m.subject_value_unlabelled({}, o)}
        </a>
        <p
          lang={pickText(read.release.types[subject.type]?.labels ?? {}, locale).lang ?? undefined}
          className="min-w-0 max-w-full [overflow-wrap:anywhere]"
        >
          {pickText(read.release.types[subject.type]?.labels ?? {}, locale).text}
        </p>
        {intro}
        <nav
          className="flex min-w-0 flex-wrap items-start gap-2 [&>a]:h-auto [&>a]:min-h-11 [&>a]:min-w-11 [&>a]:max-w-full [&>a]:whitespace-normal [&>a]:py-2 [&>a]:[overflow-wrap:anywhere] md:pointer-fine:[&>a]:min-h-8 md:pointer-fine:[&>a]:py-1"
          aria-label={m.facts_other_editors({}, o)}
        >
          <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
            {m.candidate_view_public({}, o)}
          </a>
          <SubjectTermsEntry id={id} label={label.text} locale={locale} />
          <PublicationEditorEntry work={id} locale={locale} />
        </nav>
      </header>
      <section className="min-w-0 space-y-5" aria-label={m.candidate_current({}, o)}>
        <h2 className="text-xl font-semibold">{m.candidate_current({}, o)}</h2>
        {Object.entries(screenGroups(read.release, subject.type))
          .filter(([, fields]) => fields.length)
          .map(([group, fields]) => (
            <section key={group} className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
              <h3 className="min-w-0 max-w-full text-lg font-semibold [overflow-wrap:anywhere]">
                {screenGroupLabel(group as ScreenGroup, locale)}
              </h3>
              <dl className="min-w-0 space-y-4">
                {fields.map((property) => (
                  <div key={property} className="min-w-0 space-y-2">
                    <dt
                      lang={screenName(read.release, property, locale).lang ?? undefined}
                      className="min-w-0 max-w-full font-medium [overflow-wrap:anywhere]"
                    >
                      {screenName(read.release, property, locale).text}
                    </dt>
                    <dd className="min-w-0 max-w-full space-y-3 text-sm [overflow-wrap:anywhere]">
                      {!subject.statements[property]?.length && (
                        <p className="text-muted-foreground">{m.facts_no_value({}, o)}</p>
                      )}
                      {(subject.statements[property] ?? []).map((statement) => (
                        <div key={statement.id} className="min-w-0 space-y-2">
                          <CandidateValue snak={statement} related={read.public!.related} locale={locale} />
                          {statement.qualifiers.map((part, index) => (
                            <p key={index} className="min-w-0 max-w-full [overflow-wrap:anywhere]">
                              <span lang={screenName(read.release, part.property.id, locale).lang ?? undefined}>
                                {screenName(read.release, part.property.id, locale).text}:{' '}
                              </span>
                              <CandidateValue snak={part} related={read.public!.related} locale={locale} />
                            </p>
                          ))}
                          {statement.references.map((reference, index) => (
                            <div key={index} className="min-w-0 max-w-full border-s-2 ps-3 [overflow-wrap:anywhere]">
                              {reference.parts.map((part, at) => (
                                <CandidateValue key={at} snak={part} related={read.public!.related} locale={locale} />
                              ))}
                            </div>
                          ))}
                        </div>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
              {group === 'classification' && (
                <p className="text-sm text-muted-foreground">{m.screen_classification_pending({}, o)}</p>
              )}
              {group === 'authored' && <AuthoredFieldEntry id={id} title={label.text} locale={locale} />}
            </section>
          ))}
      </section>
      {session !== 'signed-in' ? (
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.candidate_unavailable({}, o)
              : m.candidate_loading({}, o)}
        </p>
      ) : (
        <>
          {transport.facts && transport.review && (
            <details className="min-w-0 rounded-xl border border-border p-4" open>
              <summary className={screenSummaryClassName}>{m.facts_title({}, o)}</summary>
              <SubjectFacts
                embedded
                initial={current}
                locale={locale}
                transport={transport.facts}
                review={transport.review}
              />
            </details>
          )}
          {transport.relations && (
            <details className="min-w-0 space-y-4 rounded-xl border border-border p-4">
              <summary className={screenSummaryClassName}>{m.screen_credits_parts({}, o)}</summary>
              <RelationEditor embedded id={id} locale={locale} search={search} transport={transport.relations} />
            </details>
          )}
        </>
      )}
    </article>
  );
}
