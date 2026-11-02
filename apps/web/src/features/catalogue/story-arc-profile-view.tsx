import {
  CatalogueCurrentReading,
  catalogueEditor,
  useEditorLifetime,
  useEditorWorkspaceLifetime,
} from './editor-lifetime';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
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
import type { CreateResult } from './create-subject';
import { EditorFailure } from './statement-editor-view';
import { SubjectFacts } from './subject-facts-view';
import { CharacterClassification } from './character-profile-classification';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { FictionalReferenceDetails, FictionalWorkReference } from './fictional-work-reference';
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
export const StoryArcProfile = catalogueEditor(StoryArcProfileWorkspace);

function StoryArcProfileWorkspace(props: StoryArcProfileProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <StoryArcProfileLive {...props} />
    </AuthoringDepartureBoundary>
  );
}

/** Child state supplies the decision even when its current public reading is hidden. */
function StoryArcDraftDeparture({ dirty, pending }: { dirty: boolean; pending: boolean }) {
  const holder = useEditorWorkspaceLifetime();
  useAuthoringDeparture(
    () => holder.active() && (dirty || pending),
    pending,
    String(holder.generation),
    undefined,
    holder.retire,
  );
  return null;
}

function StoryArcProfileLive({
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
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const [id, setId] = useState(initialId);
  const [work, setWork] = useState(initialWork);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const selection = JSON.stringify([id, work]);
  const [reloadAttempt, setReloadAttempt] = useState<{ selection: string; sequence: number }>();
  const reloadSequence = useRef(0);
  const reloading = reloadAttempt?.selection === selection;
  const query = useQuery({
    queryKey: [...['story-arc-profile', id, work, locale, session], lifetime.generation],
    queryFn: () => transport.load({ id, work }),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retained = useRef<
    | {
        selection: string;
        read: Extract<StoryArcRead, { ok: true }>;
      }
    | undefined
  >(undefined);
  // Retained data supplies private holders only; public markup uses the current read.
  if (retained.current?.selection !== selection) retained.current = undefined;
  if (query.data?.ok) retained.current = { selection, read: query.data };
  const readable = !reloading && !query.isError && query.data?.ok === true;
  const current = readable && query.data?.ok ? query.data : undefined;
  const privateRead = retained.current?.read;
  const arc = current?.arc;
  const label = pageText(arc?.subject.labels, locale);
  const href = arc ? subjectHref({ id: arc.subject.id, label: label.text }, locale).href : undefined;
  const address = storyArcEntry({
    id: readable ? id : undefined,
    work: readable ? work : undefined,
    label: label.text,
    locale,
  }).href;
  const editable = session === 'signed-in' && readable;
  const observation = useRef({ readable, selection, token: {} });
  if (observation.current.readable !== readable || observation.current.selection !== selection)
    observation.current = { readable, selection, token: {} };
  const token = observation.current.token;
  const { requestNavigation } = useAuthoringDeparture(false, false, selection);
  const choose = (destination: { id: string | undefined } | { work: string | undefined }) => {
    if (!lifetime.active() || observation.current.token !== token) return;
    if ('id' in destination ? destination.id === id : destination.work === work) return;
    requestNavigation(() => {
      // A read may recover while the decision is open; the captured selection still owns the choice.
      if (!lifetime.active() || observation.current.selection !== selection) return;
      // Retire selection callbacks synchronously, before React commits the replacement holders.
      observation.current = { readable: false, selection, token: {} };
      if ('id' in destination) {
        setCreated(undefined);
        setId(destination.id);
      } else setWork(destination.work);
    });
  };
  const canEdit = () => lifetime.active() && editable && observation.current.token === token;
  const reload = () => {
    if (query.isFetching) return;
    const sequence = ++reloadSequence.current;
    observation.current = { readable: false, selection, token: {} };
    setReloadAttempt({ selection, sequence });
    void query.refetch().finally(() => {
      setReloadAttempt((active) => (active?.sequence === sequence ? undefined : active));
    });
  };
  return (
    <article key={selection} className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8 sm:px-6">
      <ViewHeadingActions
        label={id ? m.story_arc_title({}, o) : m.story_arc_create({}, o)}
        headingClassName="font-sans"
        actions={
          href &&
          readable && (
            <a href={href} className={buttonVariants({ variant: 'outline', className: callerActionClass })}>
              {m.candidate_view_public({}, o)}
            </a>
          )
        }
      />
      <p className="text-muted-foreground">{id ? m.story_arc_intro({}, o) : m.story_arc_creation_help({}, o)}</p>
      {(query.isPending || reloading) && <p role="status">{m.candidate_loading({}, o)}</p>}
      {(query.isError || (query.data && !query.data.ok)) && (
        <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
      )}
      <Button variant="outline" className={callerActionClass} disabled={query.isFetching} onClick={reload}>
        {m.correction_reload({}, o)}
      </Button>
      {session === 'signed-in' && !readable && (id || work) && (
        <div className="flex flex-wrap gap-3">
          {id && (
            <Button
              variant="outline"
              className={callerActionClass}
              onClick={() => {
                choose({ id: undefined });
              }}
            >
              {m.story_arc_choose_existing({}, o)}
            </Button>
          )}
          {!readable && work && (
            <Button variant="outline" className={callerActionClass} onClick={() => choose({ work: undefined })}>
              {m.story_arc_choose_work({}, o)}
            </Button>
          )}
        </div>
      )}
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
      <div className="space-y-8">
        <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6">
          {current && arc ? (
            <>
              <h2 className="text-xl font-semibold">{m.story_arc_identity({}, o)}</h2>
              <p lang={label.lang} className="text-lg font-medium">
                {label.text || m.subject_value_unlabelled({}, o)}
              </p>
              <p lang={pageText(current.release.types[storyArcType]!.labels, locale).lang}>
                {pageText(current.release.types[storyArcType]!.labels, locale).text}
              </p>
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
              {readable && <FictionalReferenceDetails id={arc.subject.id} type={storyArcType} locale={locale} />}
              {editable && (
                <Button
                  variant="outline"
                  className={callerActionClass}
                  onClick={() => {
                    if (!canEdit()) return;
                    choose({ id: undefined });
                  }}
                >
                  {m.story_arc_choose_existing({}, o)}
                </Button>
              )}
            </>
          ) : null}
          {!id && privateRead && (
            <div className="space-y-6">
              <EntityPicker
                disabled={!editable}
                label={m.story_arc_choose_existing({}, o)}
                className={callerPickerClass}
                value={[]}
                src={coverSrc}
                search={async (text, signal) =>
                  (await search(text, signal)).filter((entry) => entry.types.includes(storyArcType))
                }
                onValueChange={(items) => {
                  if (canEdit() && items[0]) choose({ id: items[0].id });
                }}
              />
              <CreateSubjectForm
                locale={locale}
                session={session}
                transport={transport.creation}
                onNavigate={() => {}}
                onCreated={setCreated}
                navigation={({ dirty, pending, confirmed }) => (
                  <StoryArcDraftDeparture dirty={!confirmed && dirty} pending={!confirmed && pending} />
                )}
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
              {created?.reader.state === 'ready' && (
                <a
                  href={`${created.reader.href}/story-arc${current?.work ? `?work=${encodeURIComponent(current.work.subject.id)}` : ''}`}
                  onClick={(event) => {
                    // Keep ordinary authored href navigation for new tabs and modified clicks.
                    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    choose({ id: created.id });
                  }}
                  className={buttonVariants({ className: callerActionClass })}
                >
                  {m.story_arc_continue({}, o)}
                </a>
              )}
            </div>
          )}
        </section>
        {privateRead?.arc && (
          <CatalogueCurrentReading visible={editable} ready={editable} revision={selection}>
            <div>
              <SubjectFacts
                key={privateRead.arc.subject.id}
                initial={storyArcFacts(privateRead)}
                locale={locale}
                transport={facts(privateRead.arc.subject.id)}
                review={(property, token) => review(privateRead.arc!.subject.id, property, token)}
              />
              {privateRead.release.types[storyArcType]!.properties.filter(
                (property) => privateRead.release.properties[property]?.relation?.group === 'classification',
              ).map((property) => (
                <CharacterClassification
                  key={`${privateRead.arc!.subject.id}:${property}`}
                  property={property}
                  read={{ ok: true, release: privateRead.release, public: privateRead.arc!, source: null }}
                  locale={locale}
                  search={search}
                  transport={facts(privateRead.arc!.subject.id)}
                  review={(field, token) => review(privateRead.arc!.subject.id, field, token)}
                />
              ))}
              {editable && (
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
              )}
            </div>
          </CatalogueCurrentReading>
        )}
        <section
          aria-label={m.story_arc_work({}, o)}
          className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
        >
          <h2 className="text-xl font-semibold">{m.story_arc_work({}, o)}</h2>
          <p>{m.story_arc_work_help({}, o)}</p>
          {current?.work && (
            <FictionalWorkReference
              subject={current.work.subject}
              locale={locale}
              onChooseAnother={
                editable
                  ? () => {
                      if (canEdit()) choose({ work: undefined });
                    }
                  : undefined
              }
            />
          )}
          {privateRead?.work && (
            <CatalogueCurrentReading visible={editable} ready={editable} revision={selection}>
              <RelationEditor
                key={`work:${privateRead.work.subject.id}`}
                id={privateRead.work.subject.id}
                navigation={(state) => <StoryArcDraftDeparture {...state} />}
                locale={locale}
                search={search}
                transport={{
                  ...relations(privateRead.work.subject.id),
                  read: async (...args) =>
                    storyArcRelations(
                      await relations(privateRead.work!.subject.id).read(...args),
                      privateRead.release,
                      true,
                    ),
                }}
              />
            </CatalogueCurrentReading>
          )}
          {!current?.work && (
            <EntityPicker
              label={m.story_arc_choose_work({}, o)}
              className={callerPickerClass}
              value={[]}
              src={coverSrc}
              disabled={!editable}
              search={async (text, signal) =>
                (await search(text, signal)).filter((entry) =>
                  entry.types.some((type) => !!current && storyArcWork(current.release, type)),
                )
              }
              onValueChange={(items) => {
                if (canEdit() && items[0]) choose({ work: items[0].id });
              }}
            />
          )}
        </section>
      </div>
    </article>
  );
}
