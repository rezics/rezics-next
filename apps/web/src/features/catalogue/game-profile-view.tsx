import { CatalogueCurrentReading, catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import { relationFields, type RelationTransport } from '../../subject/relation-candidates';
import { ViewHeading } from '../pages/view-heading';
import { CandidateValue } from '../pages/data';
import { CreateSubjectForm } from './create-subject-form';
import type { CreatedReader, CreateResult } from './create-subject';
import { SubjectTermsEntry } from './subject-terms-entry';
import { PublicationEditorEntry } from './publication-editor-entry';
import { AuthoredFieldEntry } from './authored-field-entry';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { RelationEditor } from './relation-editor';
import { DefinitionGuideLink } from './definition-guide-view';
import { EditorFailure } from './statement-editor-view';
import type { StatementInput } from './statement-editor';
import { gameCreationAddress } from './game-creation-address';
import { GameClassifications, GameInitialFacts, gameGroupLabel } from './game-profile-fields';
import { gameDefinitions, gameDraft, gameGroups, type GameCommand, type GameRead } from './game-profile';
import { AuthoringDepartureBoundary } from '../../threads/authoring-departure';
import { GameDraftDeparture } from './game-classification-departure';

const gameActionClass =
  'min-h-8 min-w-8 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(max-width:639px)_and_(pointer:coarse)]:h-auto [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:min-w-11';
const gameDisclosureSummaryClass =
  'max-w-full cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(max-width:639px)_and_(pointer:coarse)]:min-h-11 [@media(max-width:639px)_and_(pointer:coarse)]:py-3';

export type GameProfileTransport = {
  load: () => Promise<GameRead>;
  create: (command: GameCommand) => Promise<CreateResult>;
  read: (id: string) => Promise<CreatedReader>;
  facts: FactsTransport;
  classifications: FactsTransport;
  relations: RelationTransport;
  review: (property: string, session?: string) => CandidateTransport;
  classificationReview: (property: string, session?: string) => CandidateTransport;
};
export const GameProfile = catalogueEditor(GameProfileLive);
type ReadyGame = Extract<GameRead, { ok: true }> & {
  public: NonNullable<Extract<GameRead, { ok: true }>['public']>;
};

function GameProfileLive({
  id,
  locale,
  session,
  transport,
  search,
  onNavigate,
}: {
  id?: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: GameProfileTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
}) {
  const lifetime = useEditorLifetime();
  const query = useQuery({
    queryKey: [...['game-profile', id ?? 'new', locale], lifetime.generation],
    queryFn: transport.load,
    retry: false,
  });
  const [readingRevision, setReadingRevision] = useState(0);
  const readingRevisionRef = useRef(0);
  const [drafts, setDrafts] = useState<Record<string, { key: string; statement: StatementInput }[]>>({});
  const [observed, setObserved] = useState(query.data);
  const [lastReading, setLastReading] = useState<Extract<GameRead, { ok: true }> | undefined>(
    query.data?.ok && (!id || query.data.public) ? query.data : undefined,
  );
  // Retain one admitted reading within this editor lifetime, only across transient failures.
  // Retiring responses clear it synchronously, so a later outage cannot revive concealed content.
  if (observed !== query.data) {
    setObserved(query.data);
    setLastReading(
      query.data?.ok && (!id || query.data.public)
        ? query.data
        : query.data && !query.data.ok && query.data.reason === 'unavailable'
          ? lastReading
          : undefined,
    );
  }
  const refreshFailed = query.isError || (!!query.data && !query.data.ok && query.data.reason === 'unavailable');
  const read = refreshFailed ? lastReading : query.data;
  const creationUnavailable = useRef(false);
  creationUnavailable.current = !id && (!read || !read.ok);
  const creationResult = useRef<HTMLDivElement>(null);
  const creationFailure = useRef<HTMLDivElement>(null);
  const existingResult = useRef<HTMLElement>(null);
  const existingFailure = useRef<HTMLDivElement>(null);
  const [, setFocusSettlement] = useState(0);
  // Reuse the editor's retirement boundary; session observations also retire local retry intent.
  const recovery = useMemo(() => ({ pending: false, dispose: () => {} }), [lifetime.generation, id, locale, session]);
  const currentRecovery = useRef(recovery);
  currentRecovery.current = recovery;
  const [creationAttempt, setCreationAttempt] = useState<{ owner: typeof recovery; pending: boolean }>();
  const creationPending = creationAttempt?.owner === recovery && creationAttempt.pending;
  const focusIntent = useRef<{ owner: typeof recovery; opener: HTMLButtonElement; complete: boolean } | undefined>(
    undefined,
  );
  useLayoutEffect(() => () => recovery.dispose(), [recovery]);
  useLayoutEffect(() => {
    const intent = focusIntent.current;
    if (!intent?.complete || creationPending || query.isFetching) return;
    const document = intent.opener.ownerDocument;
    const current = intent.owner === recovery && lifetime.active();
    recovery.dispose();
    if (!current || (document.activeElement !== intent.opener && document.activeElement !== document.body)) return;
    let openerVisible = intent.opener.isConnected && !intent.opener.disabled;
    for (let node: HTMLElement | null = intent.opener; openerVisible && node; node = node.parentElement) {
      const style = document.defaultView?.getComputedStyle(node);
      if (
        node.hidden ||
        node.hasAttribute('inert') ||
        node.getAttribute('aria-hidden') === 'true' ||
        style?.display === 'none' ||
        style?.visibility === 'hidden' ||
        style?.visibility === 'collapse'
      )
        openerVisible = false;
    }
    // A surviving failure-shell opener retains its ordinary focus.
    if (openerVisible) {
      if (document.activeElement !== intent.opener) intent.opener.focus();
      return;
    }
    const target = id
      ? ((existingResult.current?.querySelector('h1') as HTMLElement | null) ?? existingFailure.current)
      : (creationResult.current?.querySelector('h1') ?? creationFailure.current);
    if (target) {
      target.tabIndex = -1;
      target.focus();
    }
  });
  const captureRecoveryFocusIntent = (event: MouseEvent<HTMLButtonElement>) => {
    recovery.dispose();
    const opener = event.currentTarget;
    const document = opener.ownerDocument;
    if (event.detail !== 0 || document.activeElement !== opener) return;
    const intent = { owner: recovery, opener, complete: false };
    focusIntent.current = intent;
    const cancel = () => recovery.dispose();
    const moved = (event: FocusEvent) => {
      if (event.target !== opener && event.target !== document.body) cancel();
    };
    const tabbed = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', tabbed, true);
    document.defaultView?.addEventListener('blur', cancel);
    recovery.dispose = () => {
      if (focusIntent.current === intent) focusIntent.current = undefined;
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', tabbed, true);
      document.defaultView?.removeEventListener('blur', cancel);
    };
  };
  const refreshExisting = (expectedRevision: number, event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    if (!lifetime.active() || readingRevisionRef.current !== expectedRevision) return Promise.resolve();
    captureRecoveryFocusIntent(event);
    const nextRevision = expectedRevision + 1;
    readingRevisionRef.current = nextRevision;
    setReadingRevision(nextRevision);
    return query.refetch({ cancelRefetch: false }).then(() => {
      if (!lifetime.active() || currentRecovery.current !== recovery) return;
      if (focusIntent.current?.owner === recovery) {
        focusIntent.current.complete = true;
        setFocusSettlement((current) => current + 1);
      }
    });
  };
  const retryCreation = (event: MouseEvent<HTMLButtonElement>) => {
    if (
      !lifetime.active() ||
      currentRecovery.current !== recovery ||
      !creationUnavailable.current ||
      recovery.pending ||
      query.isFetching
    )
      return;
    captureRecoveryFocusIntent(event);
    recovery.pending = true;
    setCreationAttempt({ owner: recovery, pending: true });
    // Match existing explicit readers: coalesce, never cancel and replace an in-flight read.
    void query.refetch({ cancelRefetch: false }).then(() => {
      if (!lifetime.active() || currentRecovery.current !== recovery) return;
      recovery.pending = false;
      if (focusIntent.current?.owner === recovery) focusIntent.current.complete = true;
      setCreationAttempt({ owner: recovery, pending: false });
    });
  };
  const o = { locale: locale as never };
  const admitted =
    !query.isError && !query.isFetching && query.data?.ok && query.data.public && query.data.public.subject.id === id
      ? { ...query.data, public: query.data.public }
      : undefined;
  const privateReading = useRef<ReadyGame>(undefined);
  if (admitted) privateReading.current = admitted;
  // Existing-subject recovery retains private holders, never display authority.
  if (id)
    return (
      <CatalogueCurrentReading visible={!!admitted} ready={!!admitted} revision={`${id}:${readingRevision}`}>
        {!admitted && (
          <article className="mx-auto min-w-0 max-w-4xl space-y-5">
            <ViewHeading label={m.game_profile_title({}, o)} headingClassName="font-sans" />
            {query.isPending ? (
              <p role="status">{m.catalogue_create_loading({}, o)}</p>
            ) : (
              <>
                {refreshFailed && <p role="status">{m.game_profile_refresh_failed({}, o)}</p>}
                <div ref={existingFailure} tabIndex={-1}>
                  <EditorFailure
                    reason={
                      query.isError
                        ? 'unavailable'
                        : query.data?.ok
                          ? query.data.public
                            ? 'stale'
                            : 'denied'
                          : (query.data?.reason ?? 'unavailable')
                    }
                    locale={locale}
                  />
                </div>
                <Button
                  className={gameActionClass}
                  disabled={query.isFetching}
                  onClick={(event) => void refreshExisting(readingRevision, event)}
                >
                  {m.game_profile_refresh({}, o)}
                </Button>
              </>
            )}
          </article>
        )}
        {privateReading.current && (
          <AuthoringDepartureBoundary>
            <GameCorrection
              read={privateReading.current}
              visible={!!admitted}
              locale={locale}
              session={session}
              transport={transport}
              search={search}
              refresh={(event) => refreshExisting(readingRevision, event)}
              focusResult={existingResult}
              refreshing={query.isFetching}
            />
          </AuthoringDepartureBoundary>
        )}
      </CatalogueCurrentReading>
    );
  if (!read || !read.ok || creationPending)
    return (
      <article className="mx-auto min-w-0 max-w-4xl space-y-5">
        <ViewHeading label={m.game_profile_title({}, o)} headingClassName="font-sans" />
        {query.isPending || query.isFetching || creationPending ? (
          <p role="status">{m.catalogue_create_loading({}, o)}</p>
        ) : (
          <>
            <div ref={creationFailure} tabIndex={-1}>
              <EditorFailure reason={read && !read.ok ? read.reason : 'unavailable'} locale={locale} />
            </div>
          </>
        )}
        {!query.isPending && (
          <Button className={gameActionClass} disabled={query.isFetching || creationPending} onClick={retryCreation}>
            {m.correction_reload({}, o)}
          </Button>
        )}
      </article>
    );
  if (!id)
    return (
      <div ref={creationResult} className="space-y-6">
        <p className="mx-auto max-w-3xl text-sm text-muted-foreground">{m.game_profile_grain({}, o)}</p>
        <CreateSubjectForm
          locale={locale}
          session={session}
          onNavigate={onNavigate}
          profile={{
            title: m.game_profile_title({}, o),
            scope: 'game',
            control: (pointer, type) => gameCreationAddress(pointer, drafts[type] ?? [], read.release, locale),
            labelLanguage: (type) => pickText(read.release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type) =>
              pickText(read.release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            prepare: (initial) =>
              gameDraft(
                read.release,
                initial,
                (drafts[initial.type] ?? []).map((row) => row.statement),
              ),
            fields: (type, disabled) => (
              <GameInitialFacts
                key={type}
                type={type}
                release={read.release}
                locale={locale}
                search={search}
                statements={drafts[type] ?? []}
                disabled={disabled}
                change={(rows) => setDrafts((previous) => ({ ...previous, [type]: rows }))}
              />
            ),
          }}
          transport={{
            definitions: async (refresh) => {
              const refreshed = refresh ? await query.refetch() : undefined;
              const current = refreshed ? (refreshed.isError ? undefined : refreshed.data) : read;
              if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
              return current?.ok ? { ok: true, types: gameDefinitions(current.release, locale) } : { ok: false };
            },
            submit: (command) => {
              // The common form seals the augmented native ItemInput and its key before the first request.
              const item = command.item as GameCommand['item'];
              return transport.create({ item, key: command.key });
            },
            read: transport.read,
          }}
        />
      </div>
    );
  return null;
}
function GameCorrection({
  read,
  locale,
  session,
  transport,
  search,
  refresh,
  focusResult,
  refreshing,
  visible,
}: {
  refresh: (event: MouseEvent<HTMLButtonElement>) => Promise<void>;
  focusResult: { current: HTMLElement | null };
  refreshing: boolean;
  visible: boolean;
  read: ReadyGame;
  locale: string;
  session: string;
  transport: GameProfileTransport;
  search: EntityPickerSearch;
}) {
  const lifetime = useEditorLifetime();
  const client = useQueryClient();
  const o = { locale: locale as never };
  const subject = read.public.subject;
  const title = pickText(subject.labels, locale);
  const type = pickText(read.release.types[subject.type]!.labels, locale);
  const href = subjectHref({ id: subject.id, label: title.text }, locale).href;
  const groups = gameGroups(read.release, subject.type);
  const fields = useMemo(
    () => relationFields(read.release, subject.type, locale),
    [read.release, subject.type, locale],
  );
  const relationRead = useMemo(
    () => ({
      ok: true as const,
      public: read.public,
      fields,
      page: null,
      names: Object.fromEntries(Object.entries(read.release.properties).map(([id, field]) => [id, field.labels])),
    }),
    [read.public, read.release, fields],
  );
  return (
    <article ref={focusResult} className="mx-auto min-w-0 w-full max-w-4xl space-y-8">
      {visible && (
        <header className="space-y-4">
          <ViewHeading label={m.game_profile_title({}, o)} headingClassName="font-sans" />
          <h2 className="min-w-0 font-sans text-2xl font-semibold [overflow-wrap:anywhere]">
            <a
              className="max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans text-xl underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              lang={title.lang ?? undefined}
              href={href}
            >
              {title.text || m.subject_value_unlabelled({}, o)}
            </a>
          </h2>
          <p
            className="max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
            lang={type.lang ?? undefined}
          >
            {type.text || m.guide_missing({}, o)}
          </p>
          <p className="text-sm font-medium">{m.specialist_identity_scope({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.game_profile_grain({}, o)}</p>
          <nav
            className="flex min-w-0 max-w-full flex-wrap gap-2 [overflow-wrap:anywhere]"
            aria-label={m.facts_other_editors({}, o)}
          >
            <a className={`${buttonVariants({ variant: 'outline' })} ${gameActionClass}`} href={href}>
              {m.candidate_view_public({}, o)}
            </a>
            <SubjectTermsEntry id={subject.id} label={title.text} locale={locale} />
            {read.release.types[subject.type]!.properties.some(
              (id) => read.release.properties[id]?.datatype === 'document',
            ) && <AuthoredFieldEntry id={subject.id} title={title.text} locale={locale} />}
            {subject.type !== 'wd:Q20631656' && <PublicationEditorEntry work={subject.id} locale={locale} />}
            <DefinitionGuideLink locale={locale} address={{ type: subject.type, returnTo: `${href}/game` }} />
            <Button
              className={gameActionClass}
              type="button"
              variant="outline"
              disabled={refreshing}
              onClick={(event) => lifetime.active() && void refresh(event)}
            >
              {m.game_profile_refresh({}, o)}
            </Button>
          </nav>
          <p role={refreshing ? 'status' : undefined} className="text-sm">
            {refreshing ? m.game_profile_refreshing({}, o) : m.game_profile_current({}, o)}
          </p>
          <p className="text-sm text-muted-foreground">{m.game_profile_support({}, o)}</p>
        </header>
      )}
      {visible &&
        Object.entries(groups)
          .filter(([, ids]) => ids.length)
          .map(([group, ids]) => (
            <section key={group} className="space-y-4">
              <h2 className="font-sans text-xl font-semibold">{gameGroupLabel(group, locale)}</h2>
              <dl className="divide-y divide-border rounded-xl border border-border bg-card px-4">
                {ids.map((property) => {
                  const label = pickText(read.release.properties[property]!.labels, locale);
                  return (
                    <div key={property} className="grid min-w-0 gap-2 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
                      <dt className="text-sm font-medium" lang={label.lang ?? undefined}>
                        {label.text}
                      </dt>
                      <dd className="min-w-0 space-y-3 break-words">
                        {!subject.statements[property]?.length && (
                          <span className="text-sm text-muted-foreground">{m.facts_no_value({}, o)}</span>
                        )}
                        <ol className="space-y-3">
                          {(subject.statements[property] ?? []).map((statement) => (
                            <GameStatement key={statement.id} statement={statement} read={read} locale={locale} />
                          ))}
                        </ol>
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}
      {session !== 'signed-in' ? (
        visible &&
        (session === 'unavailable' ? (
          <div role="alert" className="space-y-3">
            <p>{m.catalogue_create_unavailable({}, o)}</p>
            <Button
              className={gameActionClass}
              onClick={() => void client.invalidateQueries({ queryKey: ['session'] })}
            >
              {m.catalogue_create_retry({}, o)}
            </Button>
          </div>
        ) : (
          <p role="status">
            {session === 'signed-out' ? m.relation_sign_in({}, o) : m.catalogue_create_loading({}, o)}
          </p>
        ))
      ) : (
        <>
          <details hidden={!visible} className="min-w-0 max-w-full rounded-xl border border-border p-4">
            {visible && (
              <summary className={`${gameDisclosureSummaryClass} font-sans font-semibold`}>
                {m.game_profile_facts({}, o)}
              </summary>
            )}
            <SubjectFacts
              initial={{ ...read, source: null }}
              locale={locale}
              transport={transport.facts}
              review={transport.review}
            />
          </details>
          <details
            hidden={!visible}
            open={groups.classification.length ? undefined : true}
            className={
              groups.classification.length
                ? 'min-w-0 max-w-full space-y-4 rounded-xl border border-border p-4'
                : 'contents'
            }
          >
              {visible && !!groups.classification.length && (
                <summary className={`${gameDisclosureSummaryClass} font-sans font-semibold`}>
                  {m.game_profile_classification({}, o)}
                </summary>
              )}
              <GameClassifications
                read={read}
                locale={locale}
                search={search}
                transport={transport.classifications}
                review={transport.classificationReview}
              />
          </details>
          {!!fields.length && (
            <details hidden={!visible} className="min-w-0 max-w-full rounded-xl border border-border p-4">
              {visible && (
                <summary className={`${gameDisclosureSummaryClass} font-sans font-semibold`}>
                  {m.game_profile_relations({}, o)}
                </summary>
              )}
              <RelationEditor
                id={subject.id}
                locale={locale}
                initial={relationRead}
                search={search}
                transport={transport.relations}
                navigation={(state) => <GameDraftDeparture {...state} />}
              />
            </details>
          )}
        </>
      )}
      {visible && (
        <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3">
          <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
            {m.specialist_identity_names({}, o)}
          </summary>
          <dl className="mt-3 min-w-0 space-y-3">
            {Array.from(
              new Set([
                ...Object.keys(subject.labels),
                ...Object.keys(subject.descriptions),
                ...Object.keys(subject.aliases),
              ]),
            ).map((language) => (
              <div key={language} className="min-w-0">
                <dt className="text-sm text-muted-foreground">{language}</dt>
                <dd
                  lang={language}
                  className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                >
                  {subject.labels[language]}
                </dd>
                {subject.descriptions[language] && (
                  <dd
                    lang={language}
                    className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm"
                  >
                    {subject.descriptions[language]}
                  </dd>
                )}
                {!!subject.aliases[language]?.length && (
                  <dd
                    lang={language}
                    className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] text-sm text-muted-foreground"
                  >
                    {subject.aliases[language]!.join(' · ')}
                  </dd>
                )}
              </div>
            ))}
          </dl>
        </details>
      )}
      {visible && (
        <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border border-border p-4">
          <summary className={gameDisclosureSummaryClass}>{m.specialist_identity_reference({}, o)}</summary>
          <dl className="mt-3 min-w-0 space-y-3">
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.specialist_identity_subject_id({}, o)}</dt>
              <dd className="min-w-0">
                <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                  {subject.id}
                </code>
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{m.specialist_identity_type({}, o)}</dt>
              <dd className="min-w-0">
                <code dir="ltr" className="select-text whitespace-normal break-words [overflow-wrap:anywhere]">
                  {subject.type}
                </code>
              </dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">{m.game_profile_terms_help({}, o)}</p>
        </details>
      )}
    </article>
  );
}

/** Keep the assertion, qualifier meaning and each individually labelled citation together. */
function GameStatement({
  statement,
  read,
  locale,
}: {
  statement: ReadyGame['public']['subject']['statements'][string][number];
  read: ReadyGame;
  locale: string;
}) {
  const o = { locale: locale as never };
  return (
    <li className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <CandidateValue snak={statement} related={read.public.related} locale={locale} />
      <dl className="space-y-2 text-sm">
        {statement.qualifiers.map((part, index) => (
          <GamePart key={index} part={part} read={read} locale={locale} />
        ))}
      </dl>
      <ol className="space-y-3">
        {statement.references.map((reference, index) => (
          <li key={index} className="space-y-2 border-s-2 ps-3 text-sm">
            <p className="text-muted-foreground">
              {m.correction_references({}, o)} {index + 1}
            </p>
            <dl className="space-y-2">
              {reference.parts.map((part, partIndex) => (
                <GamePart key={partIndex} part={part} read={read} locale={locale} />
              ))}
            </dl>
          </li>
        ))}
      </ol>
    </li>
  );
}

function GamePart({
  part,
  read,
  locale,
}: {
  part: ReadyGame['public']['subject']['statements'][string][number]['qualifiers'][number];
  read: ReadyGame;
  locale: string;
}) {
  const label = pickText(
    read.release.properties[part.property.id]?.labels ?? read.public.related[part.property.id]?.labels ?? {},
    locale,
  );
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-muted-foreground" lang={label.lang ?? undefined}>
        {label.text || <code>{part.property.id}</code>}
      </dt>
      <dd className="min-w-0">
        <CandidateValue snak={part} related={read.public.related} locale={locale} />
      </dd>
    </div>
  );
}
