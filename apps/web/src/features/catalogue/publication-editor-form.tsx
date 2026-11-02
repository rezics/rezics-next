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
  type PublicationRead,
  type PublicationTransport,
} from './publication-editor';
import { ScalarControl } from './statement-editor-view';
import type { SnakInput, StatementInput } from './statement-editor';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
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

function pointerSegments(pointer: string): string[] | undefined {
  if (!pointer.startsWith('/')) return;
  const segments = pointer.slice(1).split('/');
  if (segments.some((segment) => /~(?![01])/.test(segment))) return;
  return segments.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerFrom(segments: string[]): string {
  return `/${segments.map((segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function statementAddress(pointer: string) {
  const segments = pointerSegments(pointer);
  if (segments?.[0] !== 'statements' || !segments[1]) return;
  return { property: segments[1], index: segments[2], path: segments.slice(3) };
}

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
  const o = { locale: locale as never };
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
      ...(section.closest('form')?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]') ??
        []),
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
  const controlRead =
    read ??
    (privateDefinitions.current && {
      release: privateDefinitions.current.release,
      public: { related: {} },
    });
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
  const disabled = locked || session !== 'signed-in' || !read || refreshRequiredRef.current;
  const name = (id: string) =>
    pickText(displayRelease?.properties[id]?.labels ?? {}, locale).text || draftNames[id] || '';
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
    reviewErrors.some((error) => statementAddress(error.pointer)?.property === property);
  const correctionsRequired =
    !currentProfile ||
    unsupportedRelation ||
    unsupportedPublisher ||
    Object.keys(facts).some(unsupportedFact) ||
    reviewErrors.length > 0;

  function keepPrivateDraft() {
    if (!read) return;
    privateDefinitions.current = { release: read.release, profiles: read.profiles };
    if (profile) setDraftProfile(profile);
    const properties = [relation, ...Object.keys(facts), field, 'schema:url'].filter(Boolean);
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

  async function refreshDefinitions() {
    if (!lifetime.active()) return;
    keepPrivateDraft();
    const generation = ++readingGeneration.current;
    refreshRequiredRef.current = true;
    setRefreshRequired(true);
    const refreshed = await query.refetch();
    if (!lifetime.active() || generation !== readingGeneration.current) return;
    if (!refreshed.isError && refreshed.data?.ok && refreshed.data.public.subject.id === work) {
      refreshRequiredRef.current = false;
      setRefreshRequired(false);
    }
  }

  function edit(change: () => void) {
    if (!lifetime.active() || renderedReadingGeneration !== readingGeneration.current || refreshRequiredRef.current)
      return;
    change();
    localDraft.current = true;
    // Only an explicit edit after a definite refusal starts a different request. Uncertain drafts stay frozen.
    command.current = null;
    setFailure(undefined);
  }
  function scalarEntries(property: string) {
    return (failure?.errors ?? []).flatMap((error) => {
      const address = statementAddress(error.pointer);
      if (
        address?.property !== property ||
        address.index !== '0' ||
        address.path.length === 0 ||
        address.path[0] === 'references'
      )
        return [];
      return [{ error, path: address.path, pointer: pointerFrom(['statement', ...address.path]) }];
    });
  }
  function scalarFeedback(property: string) {
    const feedbackId = `${id}-scalar-${encodeURIComponent(property)}`;
    const part: StatementInput = {
      property: { id: property },
      value: facts[property] ?? { type: 'novalue' },
      qualifiers: [],
      references: [],
      rank: 'normal',
    };
    const entries = scalarEntries(property);
    const errors = controlRead
      ? presentStatementViolations(
          entries.map(({ error, pointer }) => ({ pointer, code: error.code })),
          part,
          controlRead.release,
          locale,
          feedbackId,
        )
      : [];
    return { feedback: { id: feedbackId, address: 'fact', errors }, entries };
  }
  function linkedError(target: string, label: string, instruction: string = m.catalogue_create_invalid_field({}, o)) {
    return { target, summaryId: `${target}-error`, label, instruction, unique: false };
  }
  function generalError(error: NonNullable<CreateFailure['errors']>[number], index: number) {
    const summaryId = `${id}-general-error-${index}`;
    const diagnostic = controlRead
      ? presentStatementViolations(
          [{ pointer: '/unsupported', code: error.code }],
          {
            property: { id: '' },
            value: { type: 'novalue' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
          controlRead.release,
          locale,
          summaryId,
        )[0]
      : undefined;
    return {
      target: undefined,
      summaryId,
      label: diagnostic?.label ?? m.catalogue_create_invalid_field({}, o),
      instruction: diagnostic?.instruction ?? '',
      unique: false,
    };
  }
  function errorControl(error: NonNullable<CreateFailure['errors']>[number], index: number) {
    const languageValue = language.trim();
    const languageValid = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(languageValue);
    const segments = pointerSegments(error.pointer);
    if (error.pointer === '/independent') return linkedError(`${id}-independent`, m.publication_independent({}, o));
    if (error.pointer === '/type' || error.pointer === '/relation')
      return linkedError(`${id}-relation`, m.relation_property({}, o));
    if (error.pointer === '/language') return linkedError(`${id}-language`, m.catalogue_create_language({}, o));
    if (segments?.[0] === 'labels') {
      const target =
        segments.length === 1
          ? `${id}-label`
          : segments.length === 2 && segments[1] === languageValue
            ? languageValid
              ? `${id}-label`
              : `${id}-language`
            : undefined;
      if (target)
        return linkedError(
          target,
          target === `${id}-language` ? m.catalogue_create_language({}, o) : m.catalogue_create_label({}, o),
        );
    }
    const address = statementAddress(error.pointer);
    if (address) {
      const { property, index: statementIndex, path } = address;
      const currentStatement = property === relation || Object.hasOwn(facts, property);
      const citationVisible = !!controlRead?.release.properties['schema:url'] || !!citation;
      const citationPath =
        (path.length === 1 && path[0] === 'references') ||
        (path.join('/') === 'references/0/parts/0/value/content' && !!citation.trim());
      if (currentStatement && citationVisible && statementIndex === '0' && citationPath) {
        const value =
          property === relation
            ? { type: 'value' as const, content: read?.public.subject.id ?? '' }
            : (facts[property] ?? { type: 'novalue' as const });
        const part: StatementInput = {
          property: { id: property },
          value,
          qualifiers: [],
          references: citation.trim()
            ? [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value', content: citation.trim() },
                    },
                  ],
                },
              ]
            : [],
          rank: 'normal',
        };
        const [presented] = controlRead
          ? presentStatementViolations(
              [{ pointer: pointerFrom(['statement', ...path]), code: error.code }],
              part,
              controlRead.release,
              locale,
              `${id}-citation-feedback`,
            )
          : [];
        return linkedError(
          `${id}-citation`,
          m.relation_citation({}, o),
          presented?.instruction ?? m.catalogue_create_invalid_field({}, o),
        );
      }
      const propertyRoot = statementIndex === undefined || (statementIndex === '0' && path.length === 0);
      if (currentStatement && property === relation && propertyRoot)
        return linkedError(`${id}-relation`, m.relation_property({}, o));
      if (currentStatement && property !== relation && propertyRoot) {
        const fieldset = `${id}-fact-${encodeURIComponent(property)}`;
        const label = name(property);
        if (label) return linkedError(fieldset, label);
      }
      if (
        Object.hasOwn(facts, property) &&
        property !== 'schema:publisher' &&
        statementIndex === '0' &&
        path.length > 0 &&
        !unsupportedFact(property)
      ) {
        const { feedback, entries } = scalarFeedback(property);
        const scalarIndex = entries.findIndex((entry) => entry.error === error);
        const presented = feedback.errors[scalarIndex];
        const scalarFields = [
          'state',
          'value',
          'date',
          'amount',
          'unit',
          'lowerBound',
          'upperBound',
          'text',
          'language',
        ];
        if (presented && scalarFields.some((field) => presented.target === controlId(feedback.id, 'fact', field))) {
          const precision = path.join('/') === 'value/content/precision';
          return {
            target:
              precision && controlRead?.release.properties[property]?.datatype === 'time'
                ? controlId(feedback.id, 'fact', 'precision')
                : presented.target,
            summaryId: presented.id,
            label: precision ? `${presented.label} · ${m.correction_precision({}, o)}` : presented.label,
            instruction: presented.instruction,
            unique: true,
          };
        }
      }
    }
    return generalError(error, index);
  }
  const errorRows = (() => {
    const rows = (failure?.errors ?? []).map(errorControl);
    const grouped: typeof rows = [];
    const byTarget = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!row.target || row.unique) {
        grouped.push(row);
        continue;
      }
      const existing = byTarget.get(row.target);
      if (existing) {
        existing.instruction = [existing.instruction, row.instruction].filter(Boolean).join(' ');
      } else {
        byTarget.set(row.target, row);
        grouped.push(row);
      }
    }
    return grouped;
  })();
  const hasControlError = (target: string) => errorRows.some((error) => error.target === target);
  const controlErrorId = (target: string) => errorRows.find((error) => error.target === target)?.summaryId;
  function reviewErrorLabel(pointer: string) {
    if (pointer.includes('/references/')) return m.relation_citation({}, o);
    const address = statementAddress(pointer);
    if (address)
      return address.property === relation
        ? m.relation_property({}, o)
        : name(address.property) || m.publication_field({}, o);
    if (pointer === '/independent') return m.publication_independent({}, o);
    if (pointer === '/type' || pointer === '/relation') return m.relation_property({}, o);
    const segments = pointerSegments(pointer);
    if (segments?.[0] === 'labels')
      return /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language.trim())
        ? m.catalogue_create_label({}, o)
        : m.catalogue_create_language({}, o);
    return m.catalogue_create_invalid_field({}, o);
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
      if (!lifetime.active() || renderedReadingGeneration !== readingGeneration.current) return;
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
          {(query.isError ||
            query.data?.ok === false ||
            (query.data?.ok && !matchingRead) ||
            (refreshRequired && !query.isFetching)) && (
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
              {query.data?.ok === false && query.data.reason === 'invalid' && !refreshRequired ? (
                <a href={`/${locale}/search`} className={outlineLinkClassName}>
                  {m.catalogue_create_search({}, o)}
                </a>
              ) : (
                <Button
                  className={actionClassName}
                  variant="outline"
                  disabled={busy || query.isFetching}
                  onClick={() => void refreshDefinitions()}
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
              {!profile && (
                <ContentItemFrame as="div" role="status" className="p-4">
                  {m.publication_empty({}, o)}
                </ContentItemFrame>
              )}
            </>
          )}
          {profile && (read || (refreshRequired && privateDefinitions.current)) && (
            <form onSubmit={(event) => void submit(event)} noValidate className="space-y-6" aria-busy={busy}>
              {reviewDefinitions && (
                <ContentItemFrame as="div" role="status" className="min-w-0 space-y-3 p-4">
                  <p>{m.publication_definitions_review({}, o)}</p>
                  {!currentProfile && <p>{m.publication_empty({}, o)}</p>}
                  {reviewErrors.length > 0 && (
                    <ul className="list-inside list-disc">
                      {[...new Set(reviewErrors.map((error) => reviewErrorLabel(error.pointer)))].map((label) => (
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
                  <Field data-invalid={hasControlError(`${id}-label`) || undefined}>
                    <FieldLabel className={labelClassName} htmlFor={`${id}-label`}>
                      {m.catalogue_create_label({}, o)}
                    </FieldLabel>
                    <Input
                      className={inputClassName}
                      id={`${id}-label`}
                      aria-describedby={controlErrorId(`${id}-label`)}
                      value={label}
                      required
                      maxLength={250}
                      aria-invalid={hasControlError(`${id}-label`) || undefined}
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
                      aria-describedby={`${id}-language-help${controlErrorId(`${id}-language`) ? ` ${controlErrorId(`${id}-language`)}` : ''}`}
                      aria-invalid={hasControlError(`${id}-language`) || undefined}
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
                      aria-describedby={controlErrorId(`${id}-relation`)}
                      aria-invalid={hasControlError(`${id}-relation`) || undefined}
                      value={relation}
                      onChange={(e) => edit(() => setRelation(e.target.value))}
                    >
                      {unsupportedRelation && (
                        <NativeSelectOption value={relation} disabled>
                          {name(relation) || relation}
                        </NativeSelectOption>
                      )}
                      {(read ? (currentProfile?.relations ?? []) : profile.relations).map((id) => (
                        <NativeSelectOption key={id} value={id}>
                          {name(id)}
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
              {Object.entries(facts).map(([property, value]) => (
                <ContentItemFrame as="div" key={property} className="min-w-0 p-4 sm:p-6">
                  <FieldSet
                    id={`${id}-fact-${encodeURIComponent(property)}`}
                    disabled={disabled}
                    tabIndex={-1}
                    aria-describedby={controlErrorId(`${id}-fact-${encodeURIComponent(property)}`)}
                    aria-invalid={hasControlError(`${id}-fact-${encodeURIComponent(property)}`) || undefined}
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
                        search={async (text, signal) => {
                          const results = await search(text, signal);
                          if (
                            !read ||
                            renderedReadingGeneration !== readingGeneration.current ||
                            refreshRequiredRef.current
                          )
                            return [];
                          return results.filter((item) =>
                            item.types.some((type) => publicationTarget(read.release, type, property)),
                          );
                        }}
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
                        definition={controlRead?.release.properties[property]}
                        read={controlRead!}
                        locale={locale}
                        feedback={scalarFeedback(property).feedback}
                        onChange={(next) => edit(() => setFacts({ ...facts, [property]: next }))}
                      />
                    )}
                    <PublicationFactRemoval
                      property={property}
                      locale={locale}
                      populated={
                        value.type !== 'value' ||
                        hasFactContent(value.content) ||
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
                      onChange={(e) => edit(() => setField(e.target.value))}
                    >
                      <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                      {(read ? (currentProfile?.fields ?? []) : profile.fields)
                        .filter((id) => !Object.hasOwn(facts, id))
                        .map((id) => (
                          <NativeSelectOption key={id} value={id}>
                            {name(id)}
                          </NativeSelectOption>
                        ))}
                      {field && read && !currentProfile?.fields.includes(field) && (
                        <NativeSelectOption value={field} disabled>
                          {name(field) || field}
                        </NativeSelectOption>
                      )}
                    </NativeSelect>
                    {field && read && !currentProfile?.fields.includes(field) && (
                      <FieldError>{m.publication_choice_review({}, o)}</FieldError>
                    )}
                  </Field>
                  <Button
                    className={actionClassName}
                    type="button"
                    variant="outline"
                    disabled={
                      disabled || !field || !currentProfile?.fields.includes(field) || Object.hasOwn(facts, field)
                    }
                    onClick={() =>
                      edit(() => {
                        const datatype = read?.release.properties[field]?.datatype;
                        if (!datatype) return;
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
              {(displayRelease?.properties['schema:url'] || citation) && (
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
                        aria-describedby={`${id}-citation-help${controlErrorId(`${id}-citation`) ? ` ${controlErrorId(`${id}-citation`)}` : ''}`}
                        aria-invalid={hasControlError(`${id}-citation`) || undefined}
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
                  {errorRows.length ? (
                    <ul className="list-inside list-disc">
                      {errorRows.map((error) => (
                        <li key={error.summaryId} id={error.summaryId}>
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
