import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useQuery } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
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
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { cn } from '@rezics/ui/utils';
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CreateFailure, CreateResult } from './create-subject';
import {
  publicationDraft,
  publicationTarget,
  type PublicationCommand,
  type PublicationProfile,
  type PublicationTransport,
} from './publication-editor';
import { ScalarControl } from './statement-editor-view';
import type { SnakInput } from './statement-editor';
import { usePublicationEditorNavigation } from './publication-editor-navigation';

// Caller sizing preserves dense fine-pointer desktops and lets translated actions wrap.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
// NativeSelect applies className to its wrapper, so size the native target inside it.
const selectClassName = 'w-full min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center underline [overflow-wrap:anywhere] md:pointer-fine:min-h-8';
const actionLinkClassName = cn(buttonVariants(), actionClassName);
const outlineLinkClassName = cn(buttonVariants({ variant: 'outline' }), actionClassName);

function hasFactContent(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  if (value == null) return false;
  if (typeof value === 'object') return Object.values(value).some(hasFactContent);
  return true;
}

/** Keep confirmation with the property-keyed row, outside the submitted fact value. */
function PublicationFactRemoval({
  property,
  populated,
  disabled,
  editable,
  onRemove,
  locale,
}: {
  property: string;
  populated: boolean;
  disabled: boolean;
  editable: () => boolean;
  onRemove: () => void;
  locale: string;
}) {
  const o = { locale };
  const [confirmingProperty, setConfirmingProperty] = useState<string>();
  const confirming = confirmingProperty === property;
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const current = useRef({ property, disabled, editable, onRemove });
  current.current = { property, disabled, editable, onRemove };
  const canRemove = () =>
    current.current.property === property && !current.current.disabled && current.current.editable();

  useLayoutEffect(() => {
    if (disabled) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);

  function cancelRemoval() {
    restoreFocus.current = true;
    setConfirmingProperty(undefined);
  }

  function remove() {
    const section = holder.current?.closest('fieldset');
    if (!canRemove() || !section?.isConnected) return;
    const controls = [
      ...(section.closest('form')?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"]',
      ) ?? []),
    ];
    const first = controls.findIndex((control) => section.contains(control));
    const last = controls.findLastIndex((control) => section.contains(control));
    [...controls.slice(last + 1), ...controls.slice(0, first).reverse()]
      .find(
        (control) =>
          !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') &&
          !control.closest('[hidden], [inert]'),
      )
      ?.focus();
    current.current.onRemove();
  }

  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.relation_remove({}, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.relation_remove({}, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancel}
              className={actionClassName}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button
              className={actionClassName}
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={remove}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={actionClassName}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (!canRemove()) return;
            if (populated) setConfirmingProperty(property);
            else remove();
          }}
        >
          {m.relation_remove({}, o)}
        </Button>
      )}
    </div>
  );
}

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
  // Session and the independent public work/definition reads start together.
  const query = useQuery({
    queryKey: [...['publication-editor', work, locale], lifetime.generation],
    queryFn: () => transport.load(),
    retry: false,
  });
  const read = query.data?.ok ? query.data : undefined;
  const [draftProfile, setDraftProfile] = useState<PublicationProfile>();
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const currentProfile = read?.profiles.find((entry) => !draftProfile || entry.id === draftProfile.id);
  const profile = currentProfile ?? draftProfile;
  const [reviewDefinitions, setReviewDefinitions] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [relationChoice, setRelation] = useState('');
  const relation = relationChoice || profile?.relations[0] || '';
  const [language, setLanguage] = useState(locale);
  const [label, setLabel] = useState('');
  const [facts, setFacts] = useState<Record<string, SnakInput['value']>>({});
  const [publisher, setPublisher] = useState<EntityPickerSubject[]>([]);
  const [field, setField] = useState('');
  const [citation, setCitation] = useState('');
  const [independent, setIndependent] = useState(false);
  const [failure, setFailure] = useState<CreateFailure>();
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const command = useRef<PublicationCommand | null>(null);
  const uncertain = failure?.reason === 'unavailable' && command.current !== null;
  const locked = busy || uncertain || (failure?.reason === 'conflict' && !reviewDefinitions);
  const disabled = locked || session !== 'signed-in';
  const name = (id: string) =>
    pickText(read?.release.properties[id]?.labels ?? {}, locale).text || draftNames[id] || '';
  const title = read ? pickText(read.public.subject.labels, locale).text : '';
  const back = read ? subjectHref({ id: work, label: title }, locale).href : `/${locale}/search`;
  // Reuse the producer's current profile and schema validation; never narrow the staged draft to fit it.
  const reviewErrors =
    reviewDefinitions && read && profile
      ? publicationDraft(
          read,
          profile.id,
          relation,
          [{ language, label, description: '', aliases: '' }],
          facts,
          citation,
          independent,
        ).errors
      : [];
  const unsupportedRelation = reviewDefinitions && !currentProfile?.relations.includes(relation);
  const unsupportedFact = (property: string) => reviewDefinitions && !currentProfile?.fields.includes(property);
  const unsupportedPublisher =
    reviewDefinitions &&
    !!read &&
    Object.hasOwn(facts, 'schema:publisher') &&
    publisher.some((item) => !item.types.some((type) => publicationTarget(read.release, type, 'schema:publisher')));
  const factNeedsReview = (property: string) =>
    unsupportedFact(property) ||
    (property === 'schema:publisher' && unsupportedPublisher) ||
    reviewErrors.some((error) => error.pointer.startsWith(`/statements/${property}`));
  const correctionsRequired =
    !currentProfile ||
    unsupportedRelation ||
    unsupportedPublisher ||
    Object.keys(facts).some(unsupportedFact) ||
    reviewErrors.length > 0;

  async function refreshDefinitions() {
    setRefreshRequired(true);
    const refreshed = await query.refetch();
    if (!lifetime.active()) return;
    if (!refreshed.isError && refreshed.data?.ok) setRefreshRequired(false);
  }

  function edit(change: () => void) {
    change();
    localDraft.current = true;
    // Only an explicit edit after a definite refusal starts a different request. Uncertain drafts stay frozen.
    command.current = null;
    setFailure(undefined);
  }
  const invalid = (pointer: string) => failure?.errors?.some((error) => error.pointer.startsWith(pointer)) === true;
  function errorControl(pointer: string) {
    if (pointer.includes('/references/')) return { id: `${id}-citation`, label: m.relation_citation({}, o) };
    if (pointer.startsWith('/statements/')) {
      const property = pointer.split('/')[2] ?? '';
      return property === relation
        ? { id: `${id}-relation`, label: m.relation_property({}, o) }
        : {
            id: `${id}-fact-${encodeURIComponent(property)}`,
            label: name(property) || m.publication_field({}, o),
          };
    }
    if (pointer === '/independent') return { id: `${id}-independent`, label: m.publication_independent({}, o) };
    if (pointer === '/type' || pointer === '/relation')
      return { id: `${id}-relation`, label: m.relation_property({}, o) };
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language.trim()))
      return { id: `${id}-language`, label: m.catalogue_create_language({}, o) };
    return { id: `${id}-label`, label: m.catalogue_create_label({}, o) };
  }

  async function submit(event: FormEvent) {
    if (!lifetime.active()) return;
    event.preventDefault();
    if (
      running.current ||
      created ||
      !read ||
      !profile ||
      session !== 'signed-in' ||
      failure?.reason === 'conflict' ||
      reviewDefinitions ||
      refreshRequired
    )
      return;
    if (!command.current) {
      const draft = publicationDraft(
        read,
        profile.id,
        relation,
        [{ language, label, description: '', aliases: '' }],
        facts,
        citation,
        independent,
      );
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      command.current = { work, relation, item: draft.item, key: crypto.randomUUID() };
      setDraftProfile(profile);
      setDraftNames(
        Object.fromEntries(
          [relation, ...Object.keys(facts), 'schema:url'].map((property) => [property, name(property)]),
        ),
      );
      setRelation(relation);
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.submit(command.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        localDraft.current = false;
        setCreated(result);
        if (result.reader.state === 'ready') onNavigate(result.reader.href);
      } else {
        setFailure(result);
        // Uncertain commands retain their exact original body/key, even if a response asks for new metadata.
        if (result.refreshDefinitions && result.reason !== 'unavailable') {
          setReviewDefinitions(true);
          await refreshDefinitions();
        }
        if (!lifetime.active()) return;
      }
    } catch {
      if (!lifetime.active()) return;
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
        <ContentItemFrame
          as="div"
          role="status"
          aria-labelledby={`${id}-result`}
          className="min-w-0 space-y-4 p-4 sm:p-6"
        >
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
        </ContentItemFrame>
      ) : (
        <>
          {query.isPending && (
            <ContentItemFrame as="div" role="status" className="p-4">
              {m.catalogue_create_loading({}, o)}
            </ContentItemFrame>
          )}
          {(query.isError || query.data?.ok === false) && (
            <ContentItemFrame
              as="div"
              role="alert"
              aria-labelledby={`${id}-load-error`}
              className="min-w-0 space-y-3 p-4"
            >
              <ContentItemHeading id={`${id}-load-error`} className="text-lg font-semibold">
                {query.data?.ok === false && query.data.reason === 'concealed'
                  ? m.catalogue_create_concealed({}, o)
                  : query.data?.ok === false && query.data.reason === 'invalid'
                    ? m.publication_missing_work({}, o)
                    : m.catalogue_create_unavailable({}, o)}
              </ContentItemHeading>
              {query.data?.ok === false && query.data.reason === 'invalid' ? (
                <a href={`/${locale}/search`} className={outlineLinkClassName}>
                  {m.catalogue_create_search({}, o)}
                </a>
              ) : (
                <Button className={actionClassName} variant="outline" onClick={() => void refreshDefinitions()}>
                  {m.catalogue_create_retry({}, o)}
                </Button>
              )}
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
                      href={`/${locale}/search?q=${encodeURIComponent(label.trim() || title)}`}
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
              {!profile ? (
                <ContentItemFrame as="div" role="status" className="p-4">
                  {m.publication_empty({}, o)}
                </ContentItemFrame>
              ) : (
                <form onSubmit={(event) => void submit(event)} noValidate className="space-y-6" aria-busy={busy}>
                  {reviewDefinitions && (
                    <ContentItemFrame as="div" role="status" className="min-w-0 space-y-3 p-4">
                      <p>{m.publication_definitions_review({}, o)}</p>
                      {!currentProfile && <p>{m.publication_empty({}, o)}</p>}
                      {reviewErrors.length > 0 && (
                        <ul className="list-inside list-disc">
                          {[...new Set(reviewErrors.map((error) => errorControl(error.pointer).label))].map((label) => (
                            <li key={label}>
                              {label}: {m.catalogue_create_invalid_field({}, o)}
                            </li>
                          ))}
                        </ul>
                      )}
                      <Button
                        className={actionClassName}
                        type="button"
                        variant="outline"
                        disabled={busy || query.isFetching}
                        onClick={() => void refreshDefinitions()}
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
                  <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
                    <FieldSet
                      disabled={disabled}
                      aria-describedby={profile.description ? `${id}-profile-description` : undefined}
                      className="min-w-0 gap-4"
                    >
                      <FieldLegend lang={profile.labelLang ?? undefined} className="max-w-full">
                        <ContentItemHeading className="text-xl font-semibold [overflow-wrap:anywhere]">
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
                      <Field data-invalid={invalid('/labels') || undefined}>
                        <FieldLabel className={labelClassName} htmlFor={`${id}-label`}>
                          {m.catalogue_create_label({}, o)}
                        </FieldLabel>
                        <Input
                          className={inputClassName}
                          id={`${id}-label`}
                          aria-describedby={
                            failure?.errors?.some((error) => errorControl(error.pointer).id === `${id}-label`)
                              ? `${id}-label-error`
                              : undefined
                          }
                          value={label}
                          required
                          maxLength={250}
                          aria-invalid={invalid('/labels')}
                          onChange={(e) => edit(() => setLabel(e.target.value))}
                        />
                      </Field>
                      <Field>
                        <FieldLabel className={labelClassName} htmlFor={`${id}-language`}>
                          {m.catalogue_create_language({}, o)}
                        </FieldLabel>
                        <Input
                          className={inputClassName}
                          id={`${id}-language`}
                          value={language}
                          maxLength={64}
                          aria-describedby={`${id}-language-help${failure?.errors?.some((error) => errorControl(error.pointer).id === `${id}-language`) ? ` ${id}-language-error` : ''}`}
                          onChange={(e) => edit(() => setLanguage(e.target.value))}
                        />
                        <FieldDescription id={`${id}-language-help`} className="text-start">
                          {m.catalogue_create_language_help({}, o)}
                        </FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel className={labelClassName} htmlFor={`${id}-relation`}>
                          {m.relation_property({}, o)}
                        </FieldLabel>
                        <NativeSelect
                          className={selectClassName}
                          id={`${id}-relation`}
                          aria-describedby={
                            failure?.errors?.some((error) => errorControl(error.pointer).id === `${id}-relation`)
                              ? `${id}-relation-error`
                              : undefined
                          }
                          value={relation}
                          onChange={(e) => edit(() => setRelation(e.target.value))}
                        >
                          {unsupportedRelation && (
                            <NativeSelectOption value={relation} disabled>
                              {name(relation) || relation}
                            </NativeSelectOption>
                          )}
                          {(currentProfile?.relations ?? []).map((id) => (
                            <NativeSelectOption key={id} value={id}>
                              {name(id)}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                        {unsupportedRelation && <FieldError>{m.publication_choice_review({}, o)}</FieldError>}
                      </Field>
                      <Field orientation="horizontal" data-invalid={invalid('/independent') || undefined}>
                        <Checkbox
                          nativeButton
                          render={<button type="button" />}
                          id={`${id}-independent`}
                          aria-describedby={
                            failure?.errors?.some((error) => errorControl(error.pointer).id === `${id}-independent`)
                              ? `${id}-independent-error`
                              : undefined
                          }
                          checked={independent}
                          aria-invalid={invalid('/independent')}
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
                  {Object.entries(facts).map(([property, value]) => (
                    <ContentItemFrame as="div" key={property} className="min-w-0 p-4 sm:p-6">
                      <FieldSet
                        id={`${id}-fact-${encodeURIComponent(property)}`}
                        disabled={disabled}
                        tabIndex={-1}
                        aria-describedby={
                          failure?.errors?.some(
                            (error) => errorControl(error.pointer).id === `${id}-fact-${encodeURIComponent(property)}`,
                          )
                            ? `${id}-fact-${encodeURIComponent(property)}-error`
                            : undefined
                        }
                        className="min-w-0 gap-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <FieldLegend className="max-w-full">
                          <ContentItemHeading level={3} className="text-base font-semibold [overflow-wrap:anywhere]">
                            {name(property) || m.correction_preserved({}, o)}
                          </ContentItemHeading>
                        </FieldLegend>
                        {factNeedsReview(property) && (
                          <>
                            <FieldError>{m.publication_choice_review({}, o)}</FieldError>
                            {property === 'schema:publisher' && <p>{publisher.map((item) => item.title).join(', ')}</p>}
                            <details>
                              <summary className={linkClassName}>{m.publication_staged_value({}, o)}</summary>
                              <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {JSON.stringify({ property, value }, null, 2)}
                              </pre>
                            </details>
                          </>
                        )}
                        {unsupportedFact(property) ? null : property === 'schema:publisher' ? (
                          <EntityPicker
                            label={name(property)}
                            value={publisher}
                            search={async (text, signal) =>
                              (await search(text, signal)).filter((item) =>
                                item.types.some((type) => publicationTarget(read.release, type, property)),
                              )
                            }
                            src={coverSrc}
                            disabled={disabled}
                            onValueChange={(items) =>
                              edit(() => {
                                setPublisher(items);
                                if (!lifetime.active()) return;
                                setFacts({ ...facts, [property]: { type: 'value', content: items[0]?.id ?? '' } });
                              })
                            }
                          />
                        ) : (
                          <ScalarControl
                            part={{ property: { id: property }, value }}
                            definition={read.release.properties[property]}
                            read={read}
                            locale={locale}
                            onChange={(next) => edit(() => setFacts({ ...facts, [property]: next }))}
                          />
                        )}
                        {invalid(`/statements/${property}`) && (
                          <FieldError>{m.catalogue_create_invalid_field({}, o)}</FieldError>
                        )}
                        <PublicationFactRemoval
                          property={property}
                          locale={locale}
                          populated={
                            value.type !== 'value' || hasFactContent(value.content) ||
                            (property === 'schema:publisher' && publisher.length > 0)
                          }
                          disabled={disabled}
                          editable={() => lifetime.active() && !running.current && !disabled && !created}
                          onRemove={() =>
                            edit(() => {
                              setFacts(Object.fromEntries(Object.entries(facts).filter(([id]) => id !== property)));
                              if (property === 'schema:publisher') setPublisher([]);
                            })
                          }
                        />
                      </FieldSet>
                    </ContentItemFrame>
                  ))}
                  <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
                    <FieldSet disabled={disabled} className="min-w-0 flex-row flex-wrap items-end gap-3">
                      <FieldLegend className="sr-only">{m.publication_field({}, o)}</FieldLegend>
                      <Field className="min-w-0 basis-full sm:flex-1 sm:basis-64">
                        <FieldLabel className={labelClassName} htmlFor={`${id}-field`}>
                          {m.publication_field({}, o)}
                        </FieldLabel>
                        <NativeSelect
                          className={selectClassName}
                          id={`${id}-field`}
                          value={field}
                          onChange={(e) => setField(e.target.value)}
                        >
                          <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                          {(currentProfile?.fields ?? [])
                            .filter((id) => !Object.hasOwn(facts, id))
                            .map((id) => (
                              <NativeSelectOption key={id} value={id}>
                                {name(id)}
                              </NativeSelectOption>
                            ))}
                        </NativeSelect>
                      </Field>
                      <Button
                        className={actionClassName}
                        type="button"
                        variant="outline"
                        disabled={!field || !currentProfile?.fields.includes(field) || Object.hasOwn(facts, field)}
                        onClick={() =>
                          edit(() => {
                            const datatype = read.release.properties[field]?.datatype;
                            setFacts({
                              ...facts,
                              [field]: {
                                type: 'value',
                                content: datatype === 'time' || datatype === 'quantity' ? {} : '',
                              },
                            });
                            setField('');
                          })
                        }
                      >
                        {m.correction_add({}, o)}
                      </Button>
                    </FieldSet>
                  </ContentItemFrame>
                  {(read.release.properties['schema:url'] || citation) && (
                    <ContentItemFrame as="div" className="min-w-0 p-4 sm:p-6">
                      <FieldSet disabled={disabled} className="min-w-0 gap-3">
                        <FieldLegend className="max-w-full">
                          <ContentItemHeading className="text-xl font-semibold [overflow-wrap:anywhere]">
                            {name('schema:url') || m.relation_citation({}, o)}
                          </ContentItemHeading>
                        </FieldLegend>
                        <Field>
                          <FieldLabel className={labelClassName} htmlFor={`${id}-citation`}>
                            {m.relation_citation({}, o)}
                          </FieldLabel>
                          <Input
                            className={inputClassName}
                            id={`${id}-citation`}
                            aria-describedby={`${id}-citation-help${failure?.errors?.some((error) => errorControl(error.pointer).id === `${id}-citation`) ? ` ${id}-citation-error` : ''}`}
                            type="url"
                            value={citation}
                            maxLength={1500}
                            onChange={(e) => edit(() => setCitation(e.target.value))}
                          />
                          <FieldDescription id={`${id}-citation-help`} className="text-start">
                            {m.publication_citation({}, o)}
                          </FieldDescription>
                          {reviewErrors.some((error) => error.pointer.includes('/references/')) && (
                            <FieldError>{m.publication_choice_review({}, o)}</FieldError>
                          )}
                        </Field>
                      </FieldSet>
                    </ContentItemFrame>
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
                      {failure.errors?.length ? (
                        <ul className="list-inside list-disc">
                          {[
                            ...new Map(
                              failure.errors.map((error) => {
                                const control = errorControl(error.pointer);
                                return [control.id, control] as const;
                              }),
                            ).values(),
                          ].map((control) => (
                            <li key={control.id} id={`${control.id}-error`}>
                              <a className={linkClassName} href={`#${encodeURIComponent(control.id)}`}>
                                {control.label}
                              </a>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, o)}</p>}
                      {failure.reason === 'conflict' && !reviewDefinitions && (
                        <Button
                          className={actionClassName}
                          type="button"
                          variant="outline"
                          onClick={() => edit(() => {})}
                        >
                          {m.catalogue_create_review_new({}, o)}
                        </Button>
                      )}
                    </ContentItemFrame>
                  )}
                  <ContentItemFrame as="div" className="flex min-w-0 flex-wrap gap-3 p-4">
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
                          : m.publication_submit({}, o)}
                    </Button>
                    <a href={back} className={outlineLinkClassName}>
                      {m.publication_back({}, o)}
                    </a>
                  </ContentItemFrame>
                </form>
              )}
            </>
          )}
        </>
      )}
    </article>
  );
}
