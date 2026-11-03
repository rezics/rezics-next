import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import type { EntityPickerSearch, EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { cn } from '@rezics/ui/utils';
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import {
  publicationDraft,
  publicationWorkStatement,
  type PublicationCommand,
  type PublicationItem,
  type PublicationProfile,
  type PublicationRead,
  type PublicationTransport,
} from './publication-editor';
import { PublicationFacts } from './publication-editor-facts';
import {
  publicationCorrections,
  publicationCurrentHolders,
  type PublicationCorrection,
  type PublicationFactRow,
  type PublicationTerm,
} from './publication-editor-guidance';
import { usePublicationEditorNavigation } from './publication-editor-navigation';
import { PublicationReview } from './publication-editor-review';
import { PublicationTerms } from './publication-editor-terms';
import type { StatementInput } from './statement-editor';
import type { StatementFieldsRead } from './statement-editor-view';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const recoveryFocusClassName = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const selectClassName = 'w-full min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center underline [overflow-wrap:anywhere] md:pointer-fine:min-h-8';
const actionLinkClassName = cn(buttonVariants(), actionClassName);
const outlineLinkClassName = cn(buttonVariants({ variant: 'outline' }), actionClassName);

/** Ordinary initial facts for one independently identified publication, anchored to an existing work. */
export const PublicationEditor = catalogueEditor(PublicationEditorLive);

function PublicationEditorLive({
  work,
  locale,
  session,
  transport,
  search,
  onNavigate,
}: {
  work: string;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: PublicationTransport;
  search: EntityPickerSearch;
  onNavigate: (href: string) => void;
}) {
  const id = useId();
  const lifetime = useEditorLifetime();
  const localDraft = useRef(false);
  const navigation = usePublicationEditorNavigation(() => localDraft.current);
  const stay = useRef<HTMLButtonElement>(null);
  const o = { locale: locale as never };
  const query = useQuery({
    queryKey: [...['publication-editor', work, locale], lifetime.generation],
    queryFn: () => transport.load(),
    retry: false,
  });
  const recoveryScope = JSON.stringify([work, locale, session, lifetime.generation]);
  const recoveryFocus = useRef<
    | {
        scope: string;
        generation: number;
        opener: HTMLButtonElement;
        result?: Awaited<ReturnType<typeof query.refetch>>;
        cancel: () => void;
      }
    | undefined
  >(undefined);
  const [completedRecovery, setCompletedRecovery] = useState(0);
  useLayoutEffect(() => () => recoveryFocus.current?.cancel(), []);
  const [draftProfile, setDraftProfile] = useState<PublicationProfile>();
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const privateDefinitions = useRef<Pick<Extract<PublicationRead, { ok: true }>, 'release' | 'profiles'> | undefined>(
    undefined,
  );
  const [reviewDefinitions, setReviewDefinitions] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const refreshRequiredRef = useRef(false);
  const readingGeneration = useRef(0);
  const renderedReadingGeneration = readingGeneration.current;
  const matchingRead = query.data?.ok && query.data.public.subject.id === work ? query.data : undefined;
  const read = matchingRead && !refreshRequired && !refreshRequiredRef.current ? matchingRead : undefined;
  const currentProfile = read?.profiles.find((entry) => !draftProfile || entry.id === draftProfile.id);
  const profile = currentProfile ?? draftProfile;
  const displayRelease = read?.release ?? privateDefinitions.current?.release;
  const [relationChoice, setRelation] = useState('');
  const relation = relationChoice || profile?.relations[0] || '';
  const nextTermId = useRef(1);
  const [terms, setTerms] = useState<PublicationTerm[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const [workLink, setWorkLink] = useState<StatementInput>();
  const [facts, setFacts] = useState<PublicationFactRow[]>([]);
  const [picked, setPicked] = useState<Record<string, EntityPickerSubject>>({});
  const [field, setField] = useState('');
  const [independent, setIndependent] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState<PublicationItem>();
  const [failure, setFailure] = useState<CreateFailure>();
  const [corrections, setCorrections] = useState<PublicationCorrection[]>([]);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const command = useRef<PublicationCommand | null>(null);
  const uncertain = failure?.reason === 'unavailable' && command.current !== null;
  const locked = busy || uncertain || (failure?.reason === 'conflict' && !reviewDefinitions);
  const disabled = locked || session !== 'signed-in' || !read || refreshRequiredRef.current;
  const admission = useRef({ disabled, created, field });
  admission.current = { disabled, created, field };
  const editable = () =>
    lifetime.active() &&
    renderedReadingGeneration === readingGeneration.current &&
    !refreshRequiredRef.current &&
    !running.current &&
    !admission.current.disabled &&
    !admission.current.created;
  if (read && relation && !workLink)
    setWorkLink(publicationWorkStatement(relation, work, read.release));
  const name = (property: string) =>
    pickText(displayRelease?.properties[property]?.labels ?? {}, locale).text || draftNames[property] || '';
  const title = read ? pickText(read.public.subject.labels, locale).text : '';
  const back = read ? subjectHref({ id: work, label: title }, locale).href : `/${locale}/search`;
  const searchLabel = terms.map((term) => term.label.trim()).find(Boolean) || title;
  const currentWorkLink =
    workLink &&
    ({
      ...workLink,
      property: { id: relation },
      value: { type: 'value' as const, content: work },
      rank: 'normal' as const,
    } satisfies StatementInput);
  const reviewErrors =
    reviewDefinitions && read && profile && currentWorkLink
      ? publicationDraft(read, profile.id, relation, terms, currentWorkLink, facts.map((row) => row.statement), independent)
          .errors
      : [];
  const unsupportedRelation = reviewDefinitions && !currentProfile?.relations.includes(relation);
  const unsupportedFact = (property: string) => reviewDefinitions && !currentProfile?.fields.includes(property);
  const correctionsRequired =
    !currentProfile ||
    unsupportedRelation ||
    facts.some((row) => unsupportedFact(row.statement.property.id)) ||
    reviewErrors.length > 0;
  const holders = publicationCurrentHolders(terms, facts);
  const errorRows = corrections.map((error) =>
    error.target && holders.has(error.holder) ? error : { ...error, target: undefined },
  );
  const hasControlError = (target: string) => errorRows.some((error) => error.target === target);
  const pendingHolderFocus = useRef<string | undefined>(undefined);
  const controlErrorId = (target: string) => errorRows.find((error) => error.target === target)?.id;
  const reviewContext: StatementFieldsRead | undefined = displayRelease
    ? {
        release: displayRelease,
        source: null,
        public: {
          related: {
            ...(read ? { [work]: { labels: read.public.subject.labels, type: read.public.subject.type } } : {}),
            ...Object.fromEntries(
              Object.values(picked).map((item) => [
                item.id,
                { labels: { [locale]: item.title }, type: item.types[0] ?? '' },
              ]),
            ),
          },
          subject: { type: profile?.id ?? '' },
        },
      }
    : undefined;

  useLayoutEffect(() => {
    const intent = recoveryFocus.current;
    if (!intent) return;
    if (intent.scope !== recoveryScope || intent.generation !== readingGeneration.current || !lifetime.active())
      return intent.cancel();
    const result = intent.result;
    if (
      completedRecovery !== intent.generation ||
      query.isFetching ||
      !result ||
      result.data !== query.data ||
      result.error !== query.error ||
      result.dataUpdatedAt !== query.dataUpdatedAt ||
      result.errorUpdatedAt !== query.errorUpdatedAt
    )
      return;
    const document = intent.opener.ownerDocument;
    const active = document.activeElement;
    intent.cancel();
    if (active === intent.opener && intent.opener.isConnected && !intent.opener.disabled) return;
    if (active && active !== document.body) return;
    const recovered = !query.isError && !!read;
    const target = recovered
      ? !currentProfile
        ? `${id}-unsupported-profile`
        : reviewDefinitions
          ? `${id}-review-heading`
          : reviewing
            ? `${id}-whole-review`
            : `${id}-profile-heading`
      : `${id}-load-error`;
    document.getElementById(target)?.focus();
  });
  useLayoutEffect(() => {
    const target = pendingHolderFocus.current;
    if (!target || reviewing) return;
    pendingHolderFocus.current = undefined;
    document.getElementById(target)?.focus();
  });

  function keepPrivateDraft() {
    if (!read) return;
    privateDefinitions.current = { release: read.release, profiles: read.profiles };
    if (profile) setDraftProfile(profile);
    const properties = [relation, ...facts.map((row) => row.statement.property.id), field, 'schema:url'].filter(Boolean);
    setDraftNames((names) => ({
      ...names,
      ...Object.fromEntries(
        properties.map((property) => [
          property,
          pickText(read.release.properties[property]?.labels ?? {}, locale).text || names[property] || property,
        ]),
      ),
    }));
  }

  async function refreshDefinitions(event?: MouseEvent<HTMLButtonElement>) {
    if (!lifetime.active()) return;
    if (event && (renderedReadingGeneration !== readingGeneration.current || query.isFetching)) return;
    recoveryFocus.current?.cancel();
    keepPrivateDraft();
    const generation = ++readingGeneration.current;
    const opener = event?.currentTarget;
    if (event?.detail === 0 && opener && opener.ownerDocument.activeElement === opener) {
      const document = opener.ownerDocument;
      const cancel = () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', tabbed, true);
        if (recoveryFocus.current?.cancel === cancel) recoveryFocus.current = undefined;
      };
      const moved = (event: FocusEvent) => {
        if (event.target !== opener) cancel();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab') cancel();
      };
      recoveryFocus.current = { scope: recoveryScope, generation, opener, cancel };
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', tabbed, true);
    }
    const intent = recoveryFocus.current;
    refreshRequiredRef.current = true;
    setRefreshRequired(true);
    const refreshed = await query.refetch();
    if (!lifetime.active() || generation !== readingGeneration.current) return;
    if (intent && recoveryFocus.current === intent) {
      intent.result = refreshed;
      setCompletedRecovery(generation);
    }
    if (!refreshed.isError && refreshed.data?.ok && refreshed.data.public.subject.id === work) {
      refreshRequiredRef.current = false;
      setRefreshRequired(false);
    }
  }

  function reject(errors: NonNullable<CreateFailure['errors']>, extra?: CreateFailure) {
    setCorrections(
      publicationCorrections(
        errors,
        terms,
        currentWorkLink,
        facts,
        relation,
        (read ?? privateDefinitions.current)?.release ?? displayRelease!,
        locale,
        id,
      ),
    );
    setFailure(extra ?? { ok: false, reason: 'invalid', errors });
  }

  function edit(change: () => void, current: () => boolean = () => true) {
    if (!editable() || !current()) return;
    change();
    localDraft.current = true;
    command.current = null;
    setReviewing(false);
    setReviewed(undefined);
    setFailure(undefined);
    setCorrections([]);
  }

  async function submit(event: FormEvent) {
    if (!lifetime.active()) return;
    event.preventDefault();
    if (renderedReadingGeneration !== readingGeneration.current || refreshRequiredRef.current) return;
    if (
      running.current ||
      created ||
      !read ||
      !profile ||
      !currentWorkLink ||
      session !== 'signed-in' ||
      failure?.reason === 'conflict' ||
      reviewDefinitions ||
      refreshRequired
    )
      return;
    if (!command.current) {
      if (!reviewing) {
        const draft = publicationDraft(
          read,
          profile.id,
          relation,
          terms,
          currentWorkLink,
          facts.map((row) => row.statement),
          independent,
        );
        if (draft.errors.length) {
          reject(draft.errors);
          return;
        }
        setReviewed(draft.item);
        setReviewing(true);
        return;
      }
      if (!reviewed) return;
      command.current = { work, relation, item: structuredClone(reviewed), key: crypto.randomUUID() };
      setDraftProfile(profile);
      setDraftNames(
        Object.fromEntries(
          [relation, ...facts.map((row) => row.statement.property.id), 'schema:url'].map((property) => [
            property,
            name(property),
          ]),
        ),
      );
      setRelation(relation);
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.submit(command.current);
      if (!lifetime.active() || renderedReadingGeneration !== readingGeneration.current) return;
      if (result.ok) {
        admission.current.created = result;
        localDraft.current = false;
        setCreated(result);
        if (result.reader.state === 'ready') onNavigate(result.reader.href);
      } else {
        if (result.reason === 'unavailable' || result.reason === 'conflict') admission.current.disabled = true;
        setReviewing(false);
        if (result.errors) reject(result.errors, result);
        else setFailure(result);
        if (result.refreshDefinitions && result.reason !== 'unavailable') {
          setReviewDefinitions(true);
          await refreshDefinitions();
        }
        if (!lifetime.active()) return;
      }
    } catch {
      if (!lifetime.active()) return;
      admission.current.disabled = true;
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  async function openCreated() {
    if (!lifetime.active()) return;
    if (!created || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const reader = await transport.read(created.id);
      if (!lifetime.active()) return;
      setCreated({ ...created, reader });
      if (reader.state === 'ready') onNavigate(reader.href);
    } catch {
      if (!lifetime.active()) return;
      setCreated({ ...created, reader: { state: 'unavailable' } });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }

  function focusHolder(target: string) {
    pendingHolderFocus.current = target;
    edit(() => {});
  }

  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-1 text-foreground [overflow-wrap:anywhere] [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring">
      <AlertDialog
        open={navigation.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open) navigation.reset?.();
        }}
      >
        <AlertDialogContent initialFocus={stay} finalFocus={() => (lifetime.active() ? undefined : false)}>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.thread_authoring_leave_title({}, o)}</AlertDialogTitle>
            <AlertDialogDescription>
              {busy || uncertain ? m.thread_authoring_leave_pending({}, o) : m.thread_authoring_leave_unsaved({}, o)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={stay}>{m.thread_authoring_stay({}, o)}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => navigation.proceed?.()}>
              {m.thread_authoring_leave({}, o)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <header className="space-y-3">
        <PageHeading>{m.publication_add({}, o)}</PageHeading>
        <p className="text-muted-foreground">{m.publication_intro({}, o)}</p>
      </header>
      {created ? (
        <ContentItemFrame as="div" role="status" aria-labelledby={`${id}-result`} className="min-w-0 space-y-4 p-4 sm:p-6">
          <ContentItemHeading id={`${id}-result`} className="text-xl font-semibold">
            {m.catalogue_create_created({}, o)}
          </ContentItemHeading>
          {created.reader.state === 'ready' ? (
            <a href={created.reader.href} className={actionLinkClassName}>
              {m.catalogue_create_open({}, o)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : m.catalogue_create_reader_unavailable({}, o)}
              </p>
              <Button className={actionClassName} variant="outline" disabled={busy} onClick={() => void openCreated()}>
                {m.catalogue_create_retry({}, o)}
              </Button>
            </>
          )}
          <a href={back} className={outlineLinkClassName}>
            {m.publication_back({}, o)}
          </a>
        </ContentItemFrame>
      ) : (
        <>
          {query.isPending && (
            <ContentItemFrame as="div" role="status" className="p-4">
              {m.catalogue_create_loading({}, o)}
            </ContentItemFrame>
          )}
          {(query.isError ||
            query.data?.ok === false ||
            (query.data?.ok && !matchingRead) ||
            (refreshRequired && !query.isFetching)) && (
            <ContentItemFrame as="div" role="alert" aria-labelledby={`${id}-load-error`} className="min-w-0 space-y-3 p-4">
              <ContentItemHeading tabIndex={-1} id={`${id}-load-error`} className={cn('text-lg font-semibold', recoveryFocusClassName)}>
                {query.data?.ok === false && query.data.reason === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : query.data?.ok === false && query.data.reason === 'invalid'
                    ? m.publication_missing_work({}, o)
                    : m.catalogue_create_unavailable({}, o)}
              </ContentItemHeading>
              {query.data?.ok === false && query.data.reason === 'invalid' && !refreshRequired ? (
                <a href={`/${locale}/search`} className={outlineLinkClassName}>
                  {m.catalogue_create_search({}, o)}
                </a>
              ) : (
                <Button
                  className={actionClassName}
                  variant="outline"
                  disabled={busy || query.isFetching}
                  onClick={(event) => void refreshDefinitions(event)}
                >
                  {m.catalogue_create_retry({}, o)}
                </Button>
              )}
            </ContentItemFrame>
          )}
          {refreshRequired && query.isFetching && (
            <ContentItemFrame as="div" role="status" className="p-4">
              {m.catalogue_create_loading({}, o)}
            </ContentItemFrame>
          )}
          {read && (
            <>
              <ul className="min-w-0 list-none">
                <ContentItem
                  title={title || m.subject_value_unlabelled({}, o)}
                  href={back}
                  context={m.publication_work({}, o)}
                  preview={<p>{m.publication_duplicate({}, o)}</p>}
                  actions={
                    <a
                      href={`/${locale}/search?q=${encodeURIComponent(searchLabel)}`}
                      target="_blank"
                      rel="noreferrer"
                      className={outlineLinkClassName}
                    >
                      {m.publication_search({}, o)}
                    </a>
                  }
                  className="[&_[data-content-item-slot=title]]:line-clamp-none [&_[data-content-item-slot=title]]:[overflow-wrap:anywhere] [&_[data-slot=list-row-link]]:min-h-11"
                />
              </ul>
              {!profile && (
                <ContentItemFrame
                  id={`${id}-unsupported-profile`}
                  tabIndex={-1}
                  as="div"
                  role="status"
                  className={cn('p-4', recoveryFocusClassName)}
                >
                  {m.publication_empty({}, o)}
                </ContentItemFrame>
              )}
            </>
          )}
          {profile && (read || (refreshRequired && privateDefinitions.current)) && (
            <form onSubmit={(event) => void submit(event)} noValidate className="space-y-6" aria-busy={busy}>
              {reviewDefinitions && (
                <ContentItemFrame as="div" role="status" className="min-w-0 space-y-3 p-4">
                  <ContentItemHeading id={`${id}-review-heading`} tabIndex={-1} className={recoveryFocusClassName}>
                    {m.publication_definitions_review({}, o)}
                  </ContentItemHeading>
                  {!currentProfile && (
                    <div id={`${id}-unsupported-profile`} tabIndex={-1} className={recoveryFocusClassName}>
                      {m.publication_empty({}, o)}
                    </div>
                  )}
                  {reviewErrors.length > 0 && (
                    <ul className="list-inside list-disc">
                      {[...new Set(reviewErrors.map((error) => error.pointer))].map((pointer) => (
                        <li key={pointer}>
                          {pointer}: {m.catalogue_create_invalid_field({}, o)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    className={actionClassName}
                    type="button"
                    variant="outline"
                    disabled={busy || query.isFetching}
                    onClick={(event) => void refreshDefinitions(event)}
                  >
                    {m.publication_refresh({}, o)}
                  </Button>
                  <Button
                    className={actionClassName}
                    type="button"
                    disabled={busy || query.isFetching || refreshRequired || correctionsRequired}
                    onClick={() => edit(() => setReviewDefinitions(false))}
                  >
                    {m.catalogue_create_review_new({}, o)}
                  </Button>
                </ContentItemFrame>
              )}
              {session === 'unknown' && (
                <ContentItemFrame as="div" role="status" className="p-4">
                  {m.catalogue_create_loading({}, o)}
                </ContentItemFrame>
              )}
              {session === 'unavailable' && (
                <ContentItemFrame as="div" role="alert" className="p-4">
                  {m.catalogue_create_unavailable({}, o)}
                </ContentItemFrame>
              )}
              {session === 'signed-out' && (
                <p>
                  {m.catalogue_create_signed_out({}, o)}{' '}
                  <a
                    className={linkClassName}
                    href={`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/catalogue/publication?work=${work}`)}`}
                  >
                    {m.account_sign_in({}, o)}
                  </a>
                </p>
              )}
              {reviewing && reviewed && profile && reviewContext ? (
                <PublicationReview
                  id={id}
                  item={reviewed}
                  profile={profile}
                  relation={relation}
                  terms={terms}
                  facts={facts}
                  read={reviewContext}
                  locale={locale}
                  onEdit={focusHolder}
                />
              ) : (
                <>
                  <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
                    <FieldSet
                      disabled={disabled}
                      aria-describedby={profile.description ? `${id}-profile-description` : undefined}
                      className="min-w-0 gap-4"
                    >
                      <FieldLegend lang={profile.labelLang ?? undefined} className="max-w-full">
                        <ContentItemHeading
                          id={`${id}-profile-heading`}
                          tabIndex={-1}
                          className={cn('text-xl font-semibold [overflow-wrap:anywhere]', recoveryFocusClassName)}
                        >
                          {profile.label}
                        </ContentItemHeading>
                      </FieldLegend>
                      {profile.description && (
                        <FieldDescription
                          id={`${id}-profile-description`}
                          lang={profile.descriptionLang ?? undefined}
                          className="min-w-0 text-start [overflow-wrap:anywhere]"
                        >
                          {profile.description}
                          {profile.descriptionLang && profile.descriptionLang !== locale && (
                            <span lang={locale} className="ms-2">
                              {m.guide_fallback({ language: profile.descriptionLang }, o)}
                            </span>
                          )}
                        </FieldDescription>
                      )}
                      <PublicationTerms
                        id={id}
                        terms={terms}
                        locale={locale}
                        disabled={disabled}
                        errors={errorRows}
                        onChange={(termId, fieldName, value) =>
                          edit(() =>
                            setTerms((rows) =>
                              rows.map((row) => (row.id === termId ? { ...row, [fieldName]: value } : row)),
                            ),
                          )
                        }
                        onAdd={() =>
                          edit(() =>
                            setTerms((rows) => [
                              ...rows,
                              { id: nextTermId.current++, language: '', label: '', description: '', aliases: '' },
                            ]),
                          )
                        }
                        onRemove={(termId) => {
                          if (!editable()) return false;
                          edit(() => setTerms((rows) => rows.filter((row) => row.id !== termId)));
                          return true;
                        }}
                      />
                      <Field>
                        <FieldLabel className={labelClassName} htmlFor={`${id}-relation`}>
                          {m.relation_property({}, o)}
                        </FieldLabel>
                        <NativeSelect
                          className={selectClassName}
                          id={`${id}-relation`}
                          aria-describedby={controlErrorId(`${id}-relation`)}
                          aria-invalid={hasControlError(`${id}-relation`) || undefined}
                          value={relation}
                          onChange={(event) =>
                            edit(() => {
                              const next = event.target.value;
                              setRelation(next);
                              setWorkLink((current) =>
                                current ? { ...current, property: { id: next } } : current,
                              );
                            })
                          }
                        >
                          {unsupportedRelation && (
                            <NativeSelectOption value={relation} disabled>
                              {name(relation) || relation}
                            </NativeSelectOption>
                          )}
                          {(read ? (currentProfile?.relations ?? []) : profile.relations).map((property) => (
                            <NativeSelectOption key={property} value={property}>
                              {name(property)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        {unsupportedRelation && <FieldError>{m.publication_choice_review({}, o)}</FieldError>}
                      </Field>
                      <Field orientation="horizontal" data-invalid={hasControlError(`${id}-independent`) || undefined}>
                        <Checkbox
                          nativeButton
                          render={<button type="button" />}
                          id={`${id}-independent`}
                          aria-describedby={controlErrorId(`${id}-independent`)}
                          checked={independent}
                          aria-invalid={hasControlError(`${id}-independent`) || undefined}
                          onCheckedChange={(value) => edit(() => setIndependent(value))}
                        />
                        <FieldLabel
                          className={`${labelClassName} min-h-11 min-w-11 items-center md:pointer-fine:min-h-8`}
                          htmlFor={`${id}-independent`}
                        >
                          {m.publication_independent({}, o)}
                        </FieldLabel>
                      </Field>
                    </FieldSet>
                  </ContentItemFrame>
                  {currentWorkLink && displayRelease && (
                    <PublicationFacts
                      id={id}
                      work={work}
                      workTitle={title}
                      relation={relation}
                      workLink={currentWorkLink}
                      facts={facts}
                      profile={profile}
                      currentProfile={currentProfile}
                      release={displayRelease}
                      locale={locale}
                      search={search}
                      picked={picked}
                      disabled={disabled}
                      reviewDefinitions={reviewDefinitions}
                      guideReturn={`/${locale}/catalogue/publication?work=${work}`}
                      field={field}
                      errors={errorRows}
                      onWorkChange={(statement) => edit(() => setWorkLink(statement))}
                      onFactsChange={(next) => {
                        if (!editable()) return;
                        const removed = next.length < facts.length;
                        setFacts(next);
                        localDraft.current = true;
                        command.current = null;
                        setReviewing(false);
                        setReviewed(undefined);
                        if (!removed) {
                          setFailure(undefined);
                          setCorrections([]);
                        }
                      }}
                      onPicked={(subject, item) =>
                        edit(() =>
                          setPicked((current) => {
                            if (!item) {
                              const { [subject]: _removed, ...rest } = current;
                              return rest;
                            }
                            return { ...current, [subject]: item };
                          }),
                        )
                      }
                      onFieldChoice={(property) => edit(() => setField(property))}
                    />
                  )}
                </>
              )}
              {failure && (
                <ContentItemFrame
                  as="div"
                  role="alert"
                  aria-labelledby={`${id}-recovery`}
                  className="min-w-0 space-y-3 border-s-2 border-destructive/40 p-4"
                >
                  <ContentItemHeading id={`${id}-recovery`} className="text-lg font-semibold">
                    {failure.reason === 'denied'
                      ? m.catalogue_create_denied({}, o)
                      : failure.reason === 'signed-out'
                        ? m.catalogue_create_signed_out({}, o)
                        : failure.reason === 'conflict'
                          ? m.catalogue_create_conflict({}, o)
                          : failure.reason === 'invalid'
                            ? m.catalogue_create_invalid({}, o)
                            : m.catalogue_create_uncertain({}, o)}
                  </ContentItemHeading>
                  {errorRows.length ? (
                    <ul className="list-inside list-disc">
                      {errorRows.map((error) => (
                        <li key={error.id} id={error.id}>
                          {error.target ? (
                            <a className={linkClassName} href={`#${encodeURIComponent(error.target)}`}>
                              {error.label}
                            </a>
                          ) : (
                            error.label
                          )}
                          {error.instruction && <> — {error.instruction}</>}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
                  {failure.reason === 'conflict' && !reviewDefinitions && (
                    <Button className={actionClassName} type="button" variant="outline" onClick={() => edit(() => {})}>
                      {m.catalogue_create_review_new({}, o)}
                    </Button>
                  )}
                </ContentItemFrame>
              )}
              <ContentItemFrame as="div" className="flex min-w-0 flex-wrap gap-3 p-4">
                {reviewing && !uncertain && (
                  <Button className={actionClassName} type="button" variant="outline" onClick={() => edit(() => {})}>
                    {m.publication_continue({}, o)}
                  </Button>
                )}
                <Button
                  className={actionClassName}
                  type="submit"
                  disabled={
                    busy ||
                    session !== 'signed-in' ||
                    failure?.reason === 'conflict' ||
                    reviewDefinitions ||
                    refreshRequired
                  }
                >
                  {busy
                    ? m.catalogue_create_saving({}, o)
                    : uncertain
                      ? m.catalogue_create_retry({}, o)
                      : reviewing
                        ? m.publication_submit({}, o)
                        : m.publication_review({}, o)}
                </Button>
                {read && (
                  <a href={back} className={outlineLinkClassName}>
                    {m.publication_back({}, o)}
                  </a>
                )}
              </ContentItemFrame>
            </form>
          )}
        </>
      )}
    </article>
  );
}
