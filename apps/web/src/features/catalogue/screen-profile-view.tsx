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
export function ScreenProfile({
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
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: ['screen-profile', id, locale],
    queryFn: transport.load,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
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
      <article className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6">
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
            <Button onClick={() => void query.refetch()}>{m.correction_retry({}, o)}</Button>
          </>
        )}
      </article>
    );
  if (!id)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        <header className="space-y-3">
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
    <article className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6 [&_h2]:font-sans [&_h3]:font-sans">
      <ViewHeadingActions label={m.screen_edit({}, o)} headingClassName="font-sans" />
      <header className="space-y-3">
        <a href={href} lang={label.lang ?? undefined} className="font-serif text-2xl font-semibold underline">
          {label.text || m.subject_value_unlabelled({}, o)}
        </a>
        <p lang={pickText(read.release.types[subject.type]?.labels ?? {}, locale).lang ?? undefined}>
          {pickText(read.release.types[subject.type]?.labels ?? {}, locale).text}
        </p>
        {intro}
        <nav className="flex flex-wrap gap-2" aria-label={m.facts_other_editors({}, o)}>
          <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
            {m.candidate_view_public({}, o)}
          </a>
          <SubjectTermsEntry id={id} label={label.text} locale={locale} />
          <PublicationEditorEntry work={id} locale={locale} />
        </nav>
      </header>
      <section className="space-y-5" aria-label={m.candidate_current({}, o)}>
        <h2 className="text-xl font-semibold">{m.candidate_current({}, o)}</h2>
        {Object.entries(screenGroups(read.release, subject.type))
          .filter(([, fields]) => fields.length)
          .map(([group, fields]) => (
            <section key={group} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
              <h3 className="text-lg font-semibold">{screenGroupLabel(group as ScreenGroup, locale)}</h3>
              <dl className="space-y-4">
                {fields.map((property) => (
                  <div key={property} className="space-y-2">
                    <dt lang={screenName(read.release, property, locale).lang ?? undefined} className="font-medium">
                      {screenName(read.release, property, locale).text}
                    </dt>
                    <dd className="space-y-3 text-sm">
                      {!subject.statements[property]?.length && (
                        <p className="text-muted-foreground">{m.facts_no_value({}, o)}</p>
                      )}
                      {(subject.statements[property] ?? []).map((statement) => (
                        <div key={statement.id} className="space-y-2">
                          <CandidateValue snak={statement} related={read.public!.related} locale={locale} />
                          {statement.qualifiers.map((part, index) => (
                            <p key={index}>
                              <span lang={screenName(read.release, part.property.id, locale).lang ?? undefined}>
                                {screenName(read.release, part.property.id, locale).text}:{' '}
                              </span>
                              <CandidateValue snak={part} related={read.public!.related} locale={locale} />
                            </p>
                          ))}
                          {statement.references.map((reference, index) => (
                            <div key={index} className="border-s-2 ps-3">
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
            <details className="rounded-xl border border-border p-4" open>
              <summary className="cursor-pointer font-semibold">{m.facts_title({}, o)}</summary>
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
            <details className="space-y-4 rounded-xl border border-border p-4">
              <summary className="cursor-pointer font-semibold">{m.screen_credits_parts({}, o)}</summary>
              <RelationEditor embedded id={id} locale={locale} search={search} transport={transport.relations} />
            </details>
          )}
        </>
      )}
    </article>
  );
}
