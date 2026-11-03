import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { CreateSubjectLifetime, CreateSubjectProfileDraft, hasInitialDraft } from './create-subject-lifetime';
import { LiteraryProfileEntry } from './literary-profile-entry';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { DefinitionGuideLink } from './definition-guide-view';
import { DefinitionMeaning } from './definition-meaning';
import { GameProfileEntry } from './game-profile-entry';
import type { ReactNode } from 'react';
import type { InitialSubject } from './create-subject';
import type { Violation } from '@rezics/definitions/validate';
import { RecipeEditorEntry } from './recipe-editor-entry';
import { CharacterProfileEntry } from './character-profile-entry';
import { ScreenProfileEntry } from './screen-profile-entry';
import { TypeDirectoryPicker } from './type-directory-picker';
import { MangaProfileEntry } from './manga-profile-entry';
import { PeopleProfileEntry } from './people-profile-entry';
import { AlbumProfileEntry } from './album-profile-entry';
import { MusicContextCreateEntry } from './music-context-create-entry';
import { createSubjectControls, createSubjectGuidance } from './create-subject-guidance';
import {
  initialTerms,
  type CreateFailure,
  type CreateResult,
  type CreateSubjectCommand,
  type CreateTransport,
  type CreateType,
  type TermDraft,
} from './create-subject';

type Session = 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
type Created = Extract<CreateResult, { ok: true }>;

/** Read the producer's current label after commit; no property meaning is inferred from an endpoint or ID. */
function CreationCorrection({
  id,
  label,
  pointer,
  locale,
}: {
  id: string | undefined;
  label: string | undefined;
  pointer: string;
  locale: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState({ label: '', language: undefined as string | undefined, available: false });
  useLayoutEffect(() => {
    const form = ref.current?.closest('form');
    const target = id ? ref.current?.ownerDocument.getElementById(id) : undefined;
    const mapped = !!target && !!form?.contains(target);
    const available = mapped && !target.closest('[hidden]');
    const labelledBy = mapped ? target.getAttribute('aria-labelledby')?.split(/\s+/) : undefined;
    const heading = mapped ? target.querySelector<HTMLElement>(':scope > legend, :scope > h2, :scope > h3') : undefined;
    const labels = mapped && 'labels' in target ? (target as HTMLInputElement).labels : undefined;
    const source = labelledBy
      ?.map((key) => target!.ownerDocument.getElementById(key))
      .filter((node) => node && form?.contains(node));
    const named =
      label?.trim() ||
      source
        ?.map((node) => node!.textContent)
        .join(' ')
        .trim() ||
      (mapped ? target.getAttribute('aria-label')?.trim() : '') ||
      (labels
        ? Array.from(labels, (node) => node.textContent)
            .join(' ')
            .trim()
        : '') ||
      heading?.textContent?.trim() ||
      '';
    const property = pointer.startsWith('/statements/')
      ? pointer.split('/')[2]?.replaceAll('~1', '/').replaceAll('~0', '~')
      : undefined;
    const text = named === id || named === pointer || named === property ? '' : named;
    const language = label
      ? undefined
      : ((source?.[0] ?? labels?.[0] ?? heading ?? target)?.closest('[lang]')?.getAttribute('lang') ?? undefined);
    if (text !== current.label || language !== current.language || available !== current.available)
      setCurrent({ label: text, language, available });
  });
  return (
    <span ref={ref}>
      {current.available ? (
        <a
          className="inline-flex min-h-11 max-w-full items-center whitespace-normal underline [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          href={`#${encodeURIComponent(id ?? '')}`}
          lang={current.label ? current.language : locale}
          onClick={(event) => {
            const target = id ? event.currentTarget.ownerDocument.getElementById(id) : null;
            if (!target || !event.currentTarget.closest('form')?.contains(target)) return;
            // Profile mappings can point to a named field group rather than its inner input.
            for (let parent = target.parentElement; parent; parent = parent.parentElement)
              if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
            const focus = target.matches('input, select, textarea, button')
              ? target
              : target.querySelector<HTMLElement>(
                  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
                );
            if (focus) focus.focus();
            else {
              target.setAttribute('tabindex', '-1');
              target.focus();
            }
          }}
        >
          {current.label || m.catalogue_creation_field_unknown({}, { locale: locale as never })}
        </a>
      ) : (
        <span lang={current.label ? current.language : locale}>
          {current.label || m.catalogue_creation_field_unknown({}, { locale: locale as never })}
        </span>
      )}
    </span>
  );
}

/** The same small initial-terms form is used by the route and its request-backed stories. */
export const CreateSubjectForm = catalogueEditor(CreateSubjectFormLive);

function CreateSubjectFormLive({
  locale,
  session,
  transport,
  onNavigate,
  profile,
  onCreated,
  navigation,
  typeAdmission,
}: {
  profile?: {
    title: string;
    scope: string;
    hideHeading?: boolean;
    // A family can retain private draft metadata while retiring its current reference reading.
    metadata?: { ready: boolean; pending: boolean; failure: ReactNode; types: CreateType[] };
    refreshMetadata?: () => void;
    readOnlyType?: boolean;
    control?: (pointer: string, type: string) => string | { id: string; label: string } | undefined;
    errorLabel?: (id: string) => string | undefined;
    type?: string;
    intro?: string;
    href?: string;
    /** A feature may keep each exact Type's private term draft separately. */
    retainTypeDrafts?: boolean;
    initialLanguage?: string;
    onTypeDraftChange?: (type: string, hasTerms: boolean) => void;
    onDiscardType?: (type: string) => void;
    canEditType?: (type: string) => boolean;
    canCreateType?: (type: string) => boolean;
    reviewRevision?: string;
    labelLanguage?: (type: string) => string | undefined;
    descriptionLanguage?: (type: string) => string | undefined;
    fields: (
      type: string,
      disabled: boolean,
      canEdit: () => boolean,
      invalidate?: () => void,
      discardTypeDraft?: () => void,
    ) => ReactNode;
    prepare: (item: InitialSubject) => { item: InitialSubject; errors: Violation[] };
    /** Opt-in whole-item review before sealing. Default callers skip this and submit immediately. */
    review?: (state: { item: InitialSubject; stale: boolean }) => ReactNode;
  };
  locale: string;
  session: Session;
  transport: CreateTransport;
  onNavigate: (href: string) => void;
  onCreated?: (result: Created) => void;
  /** A containing workspace composes creation state into its shared departure decision. */
  navigation?: (state: Parameters<typeof CreateSubjectLifetime>[0]) => ReactNode;
  typeAdmission?: {
    offered?: readonly CreateType[];
    unavailable?: readonly string[];
    admitType?: (type: CreateType) => boolean;
  };
}) {
  const lifetime = useEditorLifetime();
  const options = { locale: locale as never };
  const client = useQueryClient();
  const directoryMode = !profile && !!transport.typeDirectory;
  const usesDefinitions = !directoryMode && !!transport.definitions;
  const queryKey = ['catalogue-create', 'definitions', locale, String(lifetime.generation)];
  if (profile) queryKey.push(profile.scope);
  async function loadDefinitions(refresh = false) {
    if (!transport.definitions) throw new Error('Creation definitions unavailable');
    const result = await transport.definitions(refresh);
    // A failed reload must not replace the last usable choices or unmount the draft's controls.
    if (!result.ok) throw new Error('Creation definitions unavailable');
    return result;
  }
  // Definitions and the route's session read start independently.
  const definitions = useQuery({ queryKey, queryFn: () => loadDefinitions(), enabled: usesDefinitions, retry: false });
  async function reloadDefinitions() {
    if (!usesDefinitions) return;
    await client
      .fetchQuery({ queryKey, queryFn: () => loadDefinitions(true), retry: false, staleTime: 0 })
      .catch(() => undefined);
  }
  const [type, setType] = useState(profile?.type ?? '');
  const [directoryType, setDirectoryType] = useState<CreateType | null>(null);
  const [directoryPending, setDirectoryPending] = useState(false);
  const [directoryRefreshToken, setDirectoryRefreshToken] = useState(0);
  const [rows, setRows] = useState<TermDraft[]>([
    { language: profile?.initialLanguage ?? locale, label: '', description: '', aliases: '' },
  ]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const typeRows = useRef(new Map<string, TermDraft[]>());
  const [failure, setFailure] = useState<CreateFailure>();
  // Capture profile addresses at rejection, before row deletion or Type changes can shift native indices.
  const targets = useRef(new Map<string, { id: string; label?: string }>());
  function reject(result: CreateFailure) {
    targets.current = new Map();
    for (const error of result.errors ?? []) {
      const target = profile?.control?.(error.pointer, type);
      if (target) targets.current.set(error.pointer, typeof target === 'string' ? { id: target } : target);
    }
    setFailure(result);
  }
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created>();
  const [itemReview, setItemReview] = useState<{ item: InitialSubject; fingerprint: string; stale: boolean }>();
  const confirmed = useRef(false);
  function invalidateReview() {
    setItemReview((current) => (current && !current.stale ? { ...current, stale: true } : current));
  }
  const [profileDirty, setProfileDirty] = useState(false);
  const outcome = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!busy && (created || failure)) outcome.current?.focus();
  }, [busy, created, failure]);
  const running = useRef(false);
  const unresolvedDelivery = useRef(false);
  const request = useRef<CreateSubjectCommand | null>(null);
  const types = (profile?.metadata?.types ?? (definitions.data?.ok ? definitions.data.types : [])).filter(
    (entry) => !profile?.type || entry.id === profile.type,
  );
  const selectedType = directoryMode ? directoryType : types.find((entry) => entry.id === type);
  const selectedTypeName = selectedType?.label.trim();
  const hasTypeName = !!selectedTypeName && selectedTypeName !== type;
  const uncertain = (failure?.reason === 'unavailable' && request.current !== null) || unresolvedDelivery.current;
  const locked = busy || uncertain || failure?.reason === 'conflict';
  const disabled = locked || session !== 'signed-in';
  const errors = failure?.errors ?? [];
  const readOnlyType = !!profile?.type && profile.readOnlyType;
  const hasDraft = !!type || rows.some((row) => !!(row.label || row.description || row.aliases));
  // Retrying an uncertain command needs its original identity, even while definitions are unavailable.
  const definitionsFailed = directoryMode ? false : profile?.metadata ? !profile.metadata.ready : definitions.isError;
  const hasCurrentType = directoryMode
    ? directoryType?.id === type
    : profile?.canCreateType
      ? profile.canCreateType(type)
      : types.some((entry) => entry.id === type);
  const definitionsBlocked =
    !request.current &&
    (!!profile?.metadata?.pending ||
      (directoryMode
        ? directoryPending || (!!type && !hasCurrentType)
        : definitionsFailed ||
          definitions.isFetching ||
          types.length === 0 ||
          (!!type && !!profile?.canCreateType && !hasCurrentType)));
  // Profile callbacks share this form's workspace and command lock, including before busy renders.
  const typeEditable = !profile?.metadata?.pending && (!profile?.canEditType || profile.canEditType(type));
  const profileEditable =
    !disabled && !definitionsBlocked && !profile?.metadata?.pending && typeEditable && !!selectedType && !created;
  const currentEdit = useRef<object | null>(null);
  const edit = useMemo(() => {
    const token = {};
    return {
      token,
      active: () =>
        currentEdit.current === token &&
        lifetime.active() &&
        profileEditable &&
        !running.current &&
        !request.current &&
        !confirmed.current,
    };
  }, [type, session, profileEditable, lifetime]);
  currentEdit.current = edit.token;
  useLayoutEffect(() => {
    currentEdit.current = edit.token;
    return () => {
      currentEdit.current = null;
    };
  }, [edit]);
  const termControl = createSubjectControls(rows);
  const control = (pointer: string) => targets.current.get(pointer)?.id || termControl(pointer);
  const corrections = new Map<string, { id: string | undefined; label: string | undefined; errors: Violation[] }>();
  for (const error of errors) {
    const id = control(error.pointer);
    const key = id ? `control:${id}` : `pointer:${error.pointer}`;
    const group = corrections.get(key) ?? {
      id,
      label: targets.current.get(error.pointer)?.label,
      errors: [] as Violation[],
    };
    group.errors.push(error);
    corrections.set(key, group);
  }
  const invalid = (id: string) => corrections.has(`control:${id}`);
  function guidance(id: string, field: keyof TermDraft | 'type', index?: number) {
    return [
      ...new Set(
        (corrections.get(`control:${id}`)?.errors ?? []).map((error) =>
          targets.current.has(error.pointer)
            ? m.catalogue_create_invalid_field({}, options)
            : createSubjectGuidance(error, field, { type, rows, index: index ?? 0 }, locale),
        ),
      ),
    ].join(' ');
  }

  function hasTermInput(next: readonly TermDraft[]) {
    return next.some((row) => !!(row.language || row.label || row.description || row.aliases));
  }

  function writeRows(next: TermDraft[], ownerType = type) {
    rowsRef.current = next;
    setRows(next);
    if (profile?.retainTypeDrafts) profile.onTypeDraftChange?.(ownerType, hasTermInput(next));
  }

  function changeType(nextType: string) {
    if (nextType === type) return;
    currentEdit.current = null;
    if (profile?.retainTypeDrafts) {
      const current = structuredClone(rowsRef.current);
      if (type) typeRows.current.set(type, current);
      if (type) profile.onTypeDraftChange?.(type, hasTermInput(current));
      const stored = typeRows.current.get(nextType);
      if (stored) writeRows(structuredClone(stored), nextType);
      else if (!type && hasTermInput(current)) {
        typeRows.current.set(nextType, current);
        writeRows(current, nextType);
      } else {
        writeRows(
          [{ language: profile.initialLanguage ?? '', label: '', description: '', aliases: '' }],
          nextType,
        );
      }
    }
    setType(nextType);
    setFailure(undefined);
    invalidateReview();
  }

  function discardTypeDraft() {
    if (!profile?.retainTypeDrafts) return;
    const discardedType = type;
    typeRows.current.delete(type);
    writeRows([{ language: profile.initialLanguage ?? '', label: '', description: '', aliases: '' }], '');
    setType('');
    profile.onDiscardType?.(discardedType);
    setFailure(undefined);
    invalidateReview();
  }

  function update(index: number, field: keyof TermDraft, value: string) {
    writeRows(rowsRef.current.map((row, at) => (at === index ? { ...row, [field]: value } : row)));
    setFailure(undefined);
    invalidateReview();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    if (!lifetime.active()) return;
    event.preventDefault();
    if (running.current || session !== 'signed-in' || created || failure?.reason === 'conflict' || definitionsBlocked)
      return;
    if (!request.current) {
      const draft = initialTerms(type, rows);
      if (profile) {
        const prepared = profile.prepare(draft.item);
        draft.item = prepared.item;
        draft.errors.push(...prepared.errors);
      }
      if (!hasCurrentType) draft.errors.push({ pointer: '/type', code: 'unsupported' });
      if (draft.errors.length) {
        reject({ ok: false, reason: 'invalid', errors: draft.errors });
        return;
      }
      if (profile?.review) {
        const fingerprint = JSON.stringify([draft.item, profile?.reviewRevision]);
        if (!itemReview || itemReview.stale || itemReview.fingerprint !== fingerprint) {
          setItemReview({ item: structuredClone(draft.item), fingerprint, stale: false });
          return;
        }
      }
      request.current = { item: structuredClone(draft.item), key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.submit(request.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        confirmed.current = true;
        setCreated(result);
        onCreated?.(result);
        if (result.reader.state === 'ready') onNavigate(result.reader.href);
      } else {
        reject(result);
        if (result.reason === 'unavailable') unresolvedDelivery.current = true;
        // Uncertain delivery and key conflicts retain the exact frozen command. Never silently create a second identity.
        if (!unresolvedDelivery.current && result.reason !== 'unavailable' && result.reason !== 'conflict') {
          request.current = null;
          invalidateReview();
        }
        if (result.refreshDefinitions) {
          if (directoryMode && directoryType) {
            setDirectoryPending(true);
            setDirectoryRefreshToken((token) => token + 1);
          } else if (profile?.refreshMetadata) await profile.refreshMetadata();
          else await reloadDefinitions();
        }
      }
    } catch {
      if (!lifetime.active()) return;
      unresolvedDelivery.current = true;
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
      onCreated?.({ ...created, reader });
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

  const departure = {
    locale,
    dirty: profileDirty || hasInitialDraft(type, profile?.type ?? '', rows),
    pending: !created && request.current !== null,
    confirmed: !!created,
    isActive: () => lifetime.active() && !confirmed.current,
  };
  return (
    <article className="mx-auto min-w-0 w-full max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      {navigation ? navigation(departure) : <CreateSubjectLifetime {...departure} />}
      {!profile?.hideHeading && (
        <header className="space-y-3">
          {profile ? (
            <PageHeading>{profile.title}</PageHeading>
          ) : (
            <PageHeading>{m.catalogue_create_title({}, options)}</PageHeading>
          )}
          <p className="text-muted-foreground">{profile?.intro ?? m.catalogue_create_intro({}, options)}</p>
        </header>
      )}
      {created ? (
        <section
          ref={outcome}
          tabIndex={-1}
          role="status"
          className="space-y-4 rounded-xl border border-border bg-card p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-6"
        >
          <p className="font-medium">{m.catalogue_create_created({}, options)}</p>
          {created.reader.state === 'ready' ? (
            <a href={created.reader.href} className={buttonVariants()}>
              {m.catalogue_create_open({}, options)}
            </a>
          ) : (
            <>
              <p>
                {created.reader.state === 'concealed'
                  ? m.catalogue_create_concealed({}, options)
                  : created.reader.state === 'stale'
                    ? m.catalogue_create_reader_stale({}, options)
                    : created.reader.state === 'denied'
                      ? m.catalogue_create_reader_denied({}, options)
                      : m.catalogue_create_reader_unavailable({}, options)}
              </p>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void openCreated()}>
                {m.catalogue_create_retry({}, options)}
              </Button>
            </>
          )}
        </section>
      ) : (
        <>
          {(session === 'unknown' || (usesDefinitions && definitions.isPending)) && (
            <p role="status">{m.catalogue_create_loading({}, options)}</p>
          )}
          {session === 'signed-out' && (
            <p role="status">
              {m.catalogue_create_signed_out({}, options)}{' '}
              <a
                className="underline"
                href={`/auth/sign-in?return_to=${encodeURIComponent(profile?.href ?? `/${locale}/catalogue/new`)}`}
              >
                {m.account_sign_in({}, options)}
              </a>
            </p>
          )}
          {(session === 'unavailable' || definitionsFailed) && (
            <div role="alert" className="space-y-3">
              {profile?.metadata && !profile.metadata.ready ? (
                profile.metadata.failure
              ) : (
                <p>{m.catalogue_create_unavailable({}, options)}</p>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={(usesDefinitions && definitions.isFetching) || profile?.metadata?.pending}
                onClick={() => {
                  if (usesDefinitions) void reloadDefinitions();
                  profile?.refreshMetadata?.();
                  void client.invalidateQueries({ queryKey: ['session'] });
                }}
              >
                {m.catalogue_create_retry({}, options)}
              </Button>
            </div>
          )}
          {usesDefinitions && definitions.data?.ok && types.length === 0 && (
            <p role="status">{m.catalogue_create_empty({}, options)}</p>
          )}
          {(
            directoryMode ||
            (usesDefinitions && definitions.data?.ok && (types.length > 0 || hasDraft)) ||
            (!!profile?.metadata?.ready && (types.length > 0 || hasDraft))
          ) && (
            <form className="space-y-6" noValidate onSubmit={(event) => void submit(event)} aria-busy={busy}>
              {rows.map((row, index) => (
                <fieldset
                  key={index}
                  disabled={disabled || !typeEditable}
                  className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
                >
                  <legend className="px-1 text-sm font-semibold">{m.catalogue_create_terms({}, options)}</legend>
                  {(['label', 'language', 'description', 'aliases'] as const).map((field) => {
                    const id = `create-${field}-${index}`;
                    const describedBy =
                      [field !== 'description' ? `${id}-help` : undefined, invalid(id) ? `${id}-error` : undefined]
                        .filter(Boolean)
                        .join(' ') || undefined;
                    const label =
                      field === 'language'
                        ? m.catalogue_create_language({}, options)
                        : field === 'label'
                          ? m.catalogue_create_label({}, options)
                          : field === 'description'
                            ? m.catalogue_create_description({}, options)
                            : m.catalogue_create_aliases({}, options);
                    return (
                      <Field key={field} data-invalid={invalid(id) || undefined}>
                        <FieldLabel htmlFor={id}>{label}</FieldLabel>
                        {field === 'aliases' ? (
                          <Textarea
                            id={id}
                            value={row[field]}
                            rows={3}
                            aria-invalid={invalid(id)}
                            aria-describedby={describedBy}
                            onChange={(event) => update(index, field, event.target.value)}
                          />
                        ) : (
                          <Input
                            id={id}
                            value={row[field]}
                            maxLength={field === 'language' ? 64 : 250}
                            required={field === 'language' || field === 'label'}
                            aria-invalid={invalid(id)}
                            aria-describedby={describedBy}
                            onChange={(event) => update(index, field, event.target.value)}
                          />
                        )}
                        {field === 'label' && (
                          <FieldDescription id={`${id}-help`}>
                            {m.catalogue_create_duplicate_help({}, options)}{' '}
                            <a
                              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
                              href={`/${locale}/search${row.label.trim() ? `?q=${encodeURIComponent(row.label.trim())}` : ''}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {m.catalogue_create_search({}, options)}
                              <span className="sr-only"> · {m.guide_new_tab({}, options)}</span>
                            </a>
                          </FieldDescription>
                        )}
                        {field === 'language' && (
                          <FieldDescription id={`${id}-help`}>
                            {m.catalogue_create_language_help({}, options)}
                          </FieldDescription>
                        )}
                        {field === 'aliases' && (
                          <FieldDescription id={`${id}-help`}>
                            {m.catalogue_create_aliases_help({}, options)}
                          </FieldDescription>
                        )}
                        {invalid(id) && <FieldError id={`${id}-error`}>{guidance(id, field, index)}</FieldError>}
                      </Field>
                    );
                  })}
                  {rows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        writeRows(rowsRef.current.filter((_, at) => at !== index));
                        setFailure(undefined);
                        invalidateReview();
                      }}
                    >
                      {m.catalogue_create_remove_language({}, options)}
                    </Button>
                  )}
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  writeRows([...rowsRef.current, { language: '', label: '', description: '', aliases: '' }]);
                  invalidateReview();
                }}
              >
                {m.catalogue_create_add_language({}, options)}
              </Button>
              <Field
                hidden={!!profile?.type && profile.hideHeading && !readOnlyType}
                data-invalid={invalid('create-type') || undefined}
              >
                {readOnlyType ? (
                  <div
                    id="create-type"
                    tabIndex={-1}
                    aria-labelledby="create-type-label"
                    aria-invalid={invalid('create-type')}
                    aria-describedby={`create-type-help${invalid('create-type') ? ' create-type-error' : ''}`}
                  >
                    <p id="create-type-label" className="text-sm font-medium">
                      {m.catalogue_create_type({}, options)}
                    </p>
                    <p lang={hasTypeName ? (profile?.labelLanguage?.(type) ?? selectedType?.labelLanguage) : locale}>
                      {hasTypeName ? selectedTypeName : m.catalogue_creation_type_unlabelled({}, options)}
                    </p>
                  </div>
                ) : directoryMode ? (
                  <div
                    id="create-type"
                    tabIndex={-1}
                    aria-labelledby="create-type-label"
                    aria-invalid={invalid('create-type')}
                    aria-describedby={`create-grain create-type-help${invalid('create-type') ? ' create-type-error' : ''}`}
                  >
                    <p id="create-type-label" className="text-sm font-medium">
                      {m.catalogue_create_type({}, options)}
                    </p>
                    <TypeDirectoryPicker
                      locale={locale}
                      transport={transport.typeDirectory!}
                      selected={directoryType}
                      disabled={disabled}
                      invalid={invalid('create-type')}
                      describedBy={`create-grain create-type-help${invalid('create-type') ? ' create-type-error' : ''}`}
                      refreshToken={directoryRefreshToken}
                      onSelectionChange={(nextType) => {
                        setDirectoryType(nextType);
                        setType(nextType?.id ?? '');
                        if (nextType) setFailure(undefined);
                        invalidateReview();
                      }}
                      onPendingChange={setDirectoryPending}
                      {...(typeAdmission?.offered ? { offered: typeAdmission.offered } : {})}
                      {...(typeAdmission?.unavailable ? { unavailable: typeAdmission.unavailable } : {})}
                      {...(typeAdmission?.admitType ? { admitType: typeAdmission.admitType } : {})}
                    />
                    <FieldDescription id="create-grain">{m.catalogue_create_grain({}, options)}</FieldDescription>
                  </div>
                ) : (
                  <>
                    <FieldLabel htmlFor="create-type">{m.catalogue_create_type({}, options)}</FieldLabel>
                    <NativeSelect
                      id="create-type"
                      value={type}
                      disabled={disabled || !!profile?.metadata?.pending}
                      aria-invalid={invalid('create-type')}
                      aria-describedby={`create-grain create-type-help${invalid('create-type') ? ' create-type-error' : ''}`}
                      onChange={(event) => changeType(event.target.value)}
                    >
                      <NativeSelectOption value="">{m.catalogue_create_choose_type({}, options)}</NativeSelectOption>
                      {type && !types.some((entry) => entry.id === type) && (
                        <NativeSelectOption value={type} disabled>
                          {m.catalogue_create_choose_type({}, options)}
                        </NativeSelectOption>
                      )}
                      {types.map((entry) => (
                        <NativeSelectOption
                          key={entry.id}
                          value={entry.id}
                          lang={
                            entry.label.trim() && entry.label !== entry.id ? profile?.labelLanguage?.(entry.id) : locale
                          }
                        >
                          {entry.label.trim() && entry.label !== entry.id
                            ? entry.label
                            : m.catalogue_creation_type_unlabelled({}, options)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <FieldDescription id="create-grain">{m.catalogue_create_grain({}, options)}</FieldDescription>
                  </>
                )}
                <FieldDescription id="create-type-help">
                  {type && (
                    <DefinitionMeaning
                      text={selectedType?.description}
                      language={profile?.descriptionLanguage?.(type) ?? selectedType?.descriptionLanguage}
                      locale={locale}
                    />
                  )}
                </FieldDescription>
                {type ? (
                  <details className="min-w-0 text-sm">
                    <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      {m.catalogue_creation_technical_details({}, options)}
                    </summary>
                    <dl className="flex min-w-0 flex-col gap-1 py-2">
                      <dt>{m.catalogue_creation_type_id({}, options)}</dt>
                      <dd>
                        <code className="select-all break-all">{type}</code>
                      </dd>
                    </dl>
                  </details>
                ) : null}
                <DefinitionGuideLink locale={locale} address={{ type, returnTo: `/${locale}/catalogue/new` }} />
                {invalid('create-type') && (
                  <FieldError id="create-type-error">{guidance('create-type', 'type')}</FieldError>
                )}
              </Field>
              {profile && (
                <CreateSubjectProfileDraft type={type} onDirty={setProfileDirty}>
                  {profile.fields(type, disabled, edit.active, invalidateReview, discardTypeDraft)}
                </CreateSubjectProfileDraft>
              )}
              {itemReview && profile?.review?.(itemReview)}
              {failure && (
                <div
                  ref={outcome}
                  tabIndex={-1}
                  role="alert"
                  className="space-y-3 rounded-xl border border-destructive/40 p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <p>
                    {failure.reason === 'denied'
                      ? m.catalogue_create_denied({}, options)
                      : failure.reason === 'signed-out'
                        ? m.catalogue_create_signed_out({}, options)
                        : failure.reason === 'conflict'
                          ? m.catalogue_create_conflict({}, options)
                          : failure.reason === 'invalid'
                            ? m.catalogue_create_invalid({}, options)
                            : m.catalogue_create_uncertain({}, options)}
                  </p>
                  {failure.reason === 'signed-out' && (
                    <a
                      className="underline"
                      href={`/auth/sign-in?return_to=${encodeURIComponent(profile?.href ?? `/${locale}/catalogue/new`)}`}
                    >
                      {m.account_sign_in({}, options)}
                    </a>
                  )}
                  {errors.length > 0 && (
                    <ul className="flex min-w-0 list-inside list-disc flex-col gap-2">
                      {[...corrections].map(([key, { id, label, errors: fieldErrors }]) => (
                        <li key={key}>
                          <CreationCorrection
                            id={id}
                            label={label ?? (id ? profile?.errorLabel?.(id) : undefined)}
                            pointer={fieldErrors[0]!.pointer}
                            locale={locale}
                          />
                          <details className="min-w-0 text-sm">
                            <summary className="min-h-11 cursor-pointer content-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                              {m.catalogue_creation_technical_details({}, options)}
                            </summary>
                            {fieldErrors.map((error, index) => (
                              <dl key={index} className="flex min-w-0 flex-col gap-1 py-2">
                                <dt>{m.catalogue_creation_pointer({}, options)}</dt>
                                <dd>
                                  <code className="select-all break-all">
                                    {error.pointer === '' ? '""' : error.pointer}
                                  </code>
                                </dd>
                                <dt>{m.catalogue_creation_error_code({}, options)}</dt>
                                <dd>
                                  <code className="select-all break-all">{error.code}</code>
                                </dd>
                              </dl>
                            ))}
                          </details>
                        </li>
                      ))}
                    </ul>
                  )}
                  {failure.refreshDefinitions && <p>{m.catalogue_create_refresh({}, options)}</p>}
                  {failure.reason === 'conflict' && !unresolvedDelivery.current && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        request.current = null;
                        setFailure(undefined);
                      }}
                    >
                      {m.catalogue_create_review_new({}, options)}
                    </Button>
                  )}
                </div>
              )}
              <div>
                <Button
                  type="submit"
                  disabled={busy || session !== 'signed-in' || failure?.reason === 'conflict' || definitionsBlocked}
                >
                  {busy
                    ? m.catalogue_create_saving({}, options)
                    : uncertain
                      ? m.catalogue_create_retry({}, options)
                      : m.catalogue_create_submit({}, options)}
                </Button>
              </div>
            </form>
          )}
          {!profile && (
            <details className="rounded-xl border border-border p-4">
              <summary className="min-h-11 cursor-pointer content-center font-medium">
                {m.facts_other_editors({}, options)}
              </summary>
              <nav
                aria-label={m.facts_other_editors({}, options)}
                className="mt-3 flex flex-wrap gap-2 [&>a]:h-auto [&>a]:max-w-full [&>a]:min-h-11 [&>a]:min-w-11 [&>a]:whitespace-normal"
              >
                <LiteraryProfileEntry locale={locale} />
                <GameProfileEntry locale={locale} />
                <RecipeEditorEntry locale={locale} />
                <CharacterProfileEntry locale={locale} />
                <ScreenProfileEntry locale={locale} />
                <MangaProfileEntry locale={locale} />
                <PeopleProfileEntry locale={locale} />
                <AlbumProfileEntry locale={locale} />
                <MusicContextCreateEntry locale={locale} />
              </nav>
            </details>
          )}
        </>
      )}
    </article>
  );
}
