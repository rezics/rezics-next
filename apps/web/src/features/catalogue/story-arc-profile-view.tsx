import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EntityPicker, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import type { RelationTransport } from '../../subject/relation-candidates';
import { pageText } from '../pages/data';
import { ViewHeadingActions } from '../pages/view-heading';
import { CreateSubjectForm } from './create-subject-form';
import { EditorFailure } from './statement-editor-view';
import { SubjectFacts } from './subject-facts-view';
import { CharacterClassification } from './character-profile-classification';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { storyArcEntry } from './story-arc-profile-entry';
import {
  storyArcFacts,
  storyArcRelations,
  storyArcType,
  storyArcWork,
  type StoryArcAddress,
  type StoryArcRead,
  type StoryArcTransport,
} from './story-arc-profile';

const callerActionClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal break-words py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:h-8 md:pointer-fine:min-h-8 md:pointer-fine:min-w-8 md:pointer-fine:py-1';
const callerTextActionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-8 md:pointer-fine:py-0';
const callerPickerClass =
  '[&_[data-slot=input-group]]:h-auto [&_[data-slot=input-group]]:min-h-11 [&_[data-slot=input-group-control]]:h-auto [&_[data-slot=input-group-control]]:min-h-11 md:pointer-fine:[&_[data-slot=input-group]]:h-8 md:pointer-fine:[&_[data-slot=input-group]]:min-h-8 md:pointer-fine:[&_[data-slot=input-group-control]]:h-8 md:pointer-fine:[&_[data-slot=input-group-control]]:min-h-8';

export type StoryArcProfileProps = StoryArcAddress & {
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: StoryArcTransport;
  search: EntityPickerSearch;
  facts: (id: string) => FactsTransport;
  review: (id: string, property: string, session?: string) => CandidateTransport;
  relations: (id: string) => RelationTransport;
};

/** Composition of the ordinary creation, scalar and exact-slot relationship workspaces. */
export function StoryArcProfile({
  id: initialId,
  work: initialWork,
  locale,
  session,
  transport,
  search,
  facts,
  review,
  relations,
}: StoryArcProfileProps) {
  const o = { locale: locale as never };
  const [id, setId] = useState(initialId);
  const [work, setWork] = useState(initialWork);
  const [createdHref, setCreatedHref] = useState<string>();
  const query = useQuery({
    queryKey: ['story-arc-profile', id, work, locale, session],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<Extract<StoryArcRead, { ok: true }> | undefined>(undefined);
  if (query.data?.ok) retained.current = query.data;
  const current = retained.current;
  const arc = current?.arc;
  const label = pageText(arc?.subject.labels, locale);
  const href = arc ? subjectHref({ id: arc.subject.id, label: label.text }, locale).href : undefined;
  const address = storyArcEntry({ id, work, label: label.text, locale }).href;
  const editable = session === 'signed-in' && query.data?.ok;
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6">
      <ViewHeadingActions
        label={id ? m.story_arc_title({}, o) : m.story_arc_create({}, o)}
        headingClassName="font-sans"
        actions={
          href &&
          query.data?.ok && (
            <a href={href} className={buttonVariants({ variant: 'outline', className: callerActionClass })}>
              {m.candidate_view_public({}, o)}
            </a>
          )
        }
      />
      <p className="text-muted-foreground">{id ? m.story_arc_intro({}, o) : m.story_arc_creation_help({}, o)}</p>
      {query.isPending && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || (query.data && !query.data.ok)) && (
        <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
      )}
      <Button
        variant="outline"
        className={callerActionClass}
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {m.correction_reload({}, o)}
      </Button>
      {session !== 'signed-in' && (
        <p role="status">
          {session === 'signed-out'
            ? m.catalogue_create_signed_out({}, o)
            : session === 'unavailable'
              ? m.catalogue_create_unavailable({}, o)
              : m.candidate_loading({}, o)}{' '}
          {session === 'signed-out' && (
            <a
              className={`${callerTextActionClass} underline`}
              href={`/auth/sign-in?return_to=${encodeURIComponent(address)}`}
            >
              {m.account_sign_in({}, o)}
            </a>
          )}
        </p>
      )}
      {current && (
        <div hidden={!query.data?.ok} className="space-y-8">
          <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
            {arc ? (
              <>
                <h2 className="text-xl font-semibold">{m.story_arc_identity({}, o)}</h2>
                <p lang={pageText(current.release.types[storyArcType]!.labels, locale).lang}>
                  {pageText(current.release.types[storyArcType]!.labels, locale).text} <code>{storyArcType}</code>
                </p>
                <p lang={label.lang} className="text-lg font-medium">
                  {label.text}
                </p>
                <code className="block break-all text-sm">{arc.subject.id}</code>
                {href && (
                  <nav className="flex flex-wrap gap-3" aria-label={m.facts_other_editors({}, o)}>
                    <a href={`${href}/terms`} className={`${callerTextActionClass} underline`}>
                      {m.catalogue_terms_title({}, o)}
                    </a>
                    <a
                      href={`${href}/context-review?${new URLSearchParams({ context: arc.subject.context })}`}
                      className={`${callerTextActionClass} underline`}
                    >
                      {m.context_title({}, o)}
                    </a>
                  </nav>
                )}
              </>
            ) : (
              <div hidden={!editable} className="space-y-6">
                <EntityPicker
                  label={m.story_arc_choose_existing({}, o)}
                  className={callerPickerClass}
                  value={[]}
                  src={coverSrc}
                  search={async (text, signal) =>
                    (await search(text, signal)).filter((entry) => entry.types.includes(storyArcType))
                  }
                  onValueChange={(items) => {
                    if (items[0]) setId(items[0].id);
                  }}
                />
                <CreateSubjectForm
                  locale={locale}
                  session={session}
                  transport={transport.creation}
                  onNavigate={setCreatedHref}
                  profile={{
                    scope: 'story-arc',
                    hideHeading: true,
                    readOnlyType: true,
                    fields: () => null,
                    prepare: (item) => ({ item, errors: [] }),
                    type: storyArcType,
                    title: m.story_arc_create({}, o),
                    intro: m.story_arc_creation_help({}, o),
                    href: address,
                  }}
                />
                {createdHref && (
                  <a
                    href={`${createdHref}/story-arc${work ? `?work=${encodeURIComponent(work)}` : ''}`}
                    className={buttonVariants({ className: callerActionClass })}
                  >
                    {m.story_arc_continue({}, o)}
                  </a>
                )}
              </div>
            )}
          </section>
          {arc && (
            <div hidden={!editable}>
              <SubjectFacts
                key={arc.subject.id}
                initial={storyArcFacts(current)}
                locale={locale}
                transport={facts(arc.subject.id)}
                review={(property, token) => review(arc.subject.id, property, token)}
              />
              {current.release.types[storyArcType]!.properties.filter(
                (property) => current.release.properties[property]?.relation?.group === 'classification',
              ).map((property) => (
                <CharacterClassification
                  key={`${arc.subject.id}:${property}`}
                  property={property}
                  read={{ ok: true, release: current.release, public: arc, source: null }}
                  locale={locale}
                  search={search}
                  transport={facts(arc.subject.id)}
                  review={(field, token) => review(arc.subject.id, field, token)}
                />
              ))}
              <section className="space-y-4">
                <h2 className="text-xl font-semibold">{m.story_arc_relations({}, o)}</h2>
                <p className="text-sm text-muted-foreground">{m.story_arc_relations_help({}, o)}</p>
                <a
                  href={`${href}/relation-edit`}
                  className={buttonVariants({ variant: 'outline', className: callerActionClass })}
                >
                  {m.relation_title({}, o)}
                </a>
              </section>
            </div>
          )}
          <section
            aria-label={m.story_arc_work({}, o)}
            className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
          >
            <h2 className="text-xl font-semibold">{m.story_arc_work({}, o)}</h2>
            <p>{m.story_arc_work_help({}, o)}</p>
            {current.work ? (
              <>
                <a
                  className={`${callerTextActionClass} underline`}
                  lang={pageText(current.work.subject.labels, locale).lang}
                  href={
                    subjectHref(
                      { id: current.work.subject.id, label: pageText(current.work.subject.labels, locale).text },
                      locale,
                    ).href
                  }
                >
                  {pageText(current.work.subject.labels, locale).text}
                </a>
                <code className="block break-all text-sm">{current.work.subject.id}</code>
                <div hidden={!editable}>
                  <RelationEditor
                    key={`work:${current.work.subject.id}`}
                    id={current.work.subject.id}
                    locale={locale}
                    search={search}
                    transport={{
                      ...relations(current.work.subject.id),
                      read: async (...args) =>
                        storyArcRelations(
                          await relations(current.work!.subject.id).read(...args),
                          current.release,
                          true,
                        ),
                    }}
                  />
                </div>
              </>
            ) : (
              <EntityPicker
                label={m.story_arc_choose_work({}, o)}
                className={callerPickerClass}
                value={[]}
                src={coverSrc}
                disabled={!editable}
                search={async (text, signal) =>
                  (await search(text, signal)).filter((entry) =>
                    entry.types.some((type) => storyArcWork(current.release, type)),
                  )
                }
                onValueChange={(items) => {
                  if (items[0]) setWork(items[0].id);
                }}
              />
            )}
          </section>
        </div>
      )}
    </article>
  );
}
