import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { albumCreateCorrections, type AlbumCorrection, type AlbumRow } from './album-create-guidance';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { CreateSubjectLanguageRemove } from './create-subject-language-remove';
import { useSpecialistLanguageAddFocus } from './specialist-language-add-focus';
import {
  albumDraft,
  albumFields,
  albumTarget,
  albumType,
  type AlbumCommand,
  type AlbumTransport,
} from './album-profile';
import type { CreateFailure, CreateResult, TermDraft } from './create-subject';
import { QualifierInput } from './relation-editor';
import type { StatementInput } from './statement-editor';
import { ScalarControl } from './statement-editor-view';
import { DefinitionMeaning } from './definition-meaning';
import { InitialFieldChoice } from './initial-field-choice';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';

type Row = AlbumRow;
type StatementEdit = (current: StatementInput) => StatementInput | undefined;

// Semantic form owners retain their native controls; the lower family supplies only presentation.
const panelClassName =
  'min-w-0 max-w-full space-y-4 p-4 sm:p-5 [overflow-wrap:anywhere] [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-ring [&_select:focus-visible]:outline-2 [&_select:focus-visible]:outline-offset-2 [&_select:focus-visible]:outline-ring [&_textarea:focus-visible]:outline-2 [&_textarea:focus-visible]:outline-offset-2 [&_textarea:focus-visible]:outline-ring';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal [overflow-wrap:anywhere] py-2 md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';
// NativeSelect accepts the wrapper class; size the actual native target as well.
const selectClassName = 'w-full min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
// QualifierInput has no class prop. Keep its caller's input/label sizing local to these rows.
const qualifierClassName =
  'min-w-0 w-full sm:w-auto sm:basis-64 sm:flex-1 [&_input]:min-h-11 md:pointer-fine:[&_input]:min-h-8 [&_[data-slot=field-label]]:min-w-0 [&_[data-slot=field-label]]:max-w-full [&_[data-slot=field-label]]:flex-wrap [&_[data-slot=field-label]]:[overflow-wrap:anywhere]';

/** Initial facts only. Every optional assertion begins with the reader explicitly adding its field. */
export const AlbumProfileCreate = catalogueEditor(AlbumProfileCreateBoundary);

function AlbumProfileCreateBoundary(props: Parameters<typeof AlbumProfileCreateLive>[0]) {
  return (
    <AuthoringDepartureBoundary>
      <AlbumProfileCreateLive {...props} />
    </AuthoringDepartureBoundary>
  );
}

function AlbumProfileCreateLive({
  release,
  metadataCurrent,
  onReload,
  locale,
  transport,
  search,
  enabled,
}: {
  release: Release;
  metadataCurrent: (release: Release) => boolean;
  onReload: () => Promise<void>;
  locale: string;
  transport: AlbumTransport;
  search: EntityPickerSearch;
  enabled: boolean;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const metadataReady = metadataCurrent(release);
  const termsId = useId();
  const nextTermId = useRef(1);
  const focusAddedLanguage = useSpecialistLanguageAddFocus();
  const currentRelease = useRef(release);
  currentRelease.current = release;
  const [terms, setTerms] = useState<(TermDraft & { id: number })[]>([
    { id: 0, language: locale, label: '', description: '', aliases: '' },
  ]);
  const termIds = useRef<ReadonlySet<number>>(new Set());
  termIds.current = new Set(terms.map((term) => term.id));
  const [rows, setRows] = useState<Row[]>([]);
  const currentRows = useRef(rows);
  const replaceRows = (next: Row[]) => {
    currentRows.current = next;
    setRows(next);
  };
  const [failure, setFailure] = useState<CreateFailure>();
  const [corrections, setCorrections] = useState<AlbumCorrection[]>([]);
  const [created, setCreated] = useState<Extract<CreateResult, { ok: true }>>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AlbumCommand | null>(null);
  const running = useRef(false);
  const fields = albumFields(release);
  const choices = metadataReady ? [...fields.scalar, ...fields.relations, ...fields.classifications] : [];
  const locked = busy || !!pending.current || !enabled || !metadataReady;
  const admission = useRef({ locked, created });
  admission.current = { locked, created };
  const editable = () =>
    lifetime.active() &&
    !admission.current.locked &&
    !admission.current.created &&
    !running.current &&
    !pending.current &&
    metadataCurrent(release);
  const definiteFailure = failure && failure.reason !== 'unavailable';
  const [departed, setDeparted] = useState(false);
  const termEditingAdmitted = useRef<() => boolean>(() => false);
  termEditingAdmitted.current = () =>
    lifetime.active() &&
    !departed &&
    !created &&
    !busy &&
    !running.current &&
    !pending.current &&
    enabled &&
    metadataCurrent(release);
  const updateTerm = (id: number, field: keyof TermDraft, value: string) => {
    const admitted = () => termEditingAdmitted.current() && termIds.current.has(id);
    if (!admitted()) return;
    setTerms((previous) => {
      if (!admitted() || !previous.some((row) => row.id === id)) return previous;
      return previous.map((row) => (row.id === id ? { ...row, [field]: value } : row));
    });
  };
  // Observe the producer's retained state, including rows whose metadata is unavailable.
  // The default language and an extra blank language scaffold are not authored terms.
  const dirty =
    rows.length > 0 ||
    terms.some(
      (term) =>
        !!(term.label || term.description || term.aliases) ||
        (term.id === 0 ? term.language !== locale : !!term.language),
    );
  const departure = useAuthoringDeparture(
    () => lifetime.active() && !created && (dirty || !!pending.current),
    () => !!pending.current,
    String(lifetime.generation),
    undefined,
    () => {
      // Retire local recovery before the router starts destination reads. A sent create
      // still belongs to the native producer and is neither cancelled nor reversed.
      lifetime.retire();
      pending.current = null;
      running.current = false;
      setTerms([]);
      replaceRows([]);
      setFailure(undefined);
      setCorrections([]);
      setDeparted(true);
    },
    undefined,
    {
      title: m.thread_authoring_leave_title({}, o),
      unsaved: m.thread_authoring_leave_unsaved({}, o),
      pending: m.thread_authoring_leave_pending({}, o),
    },
  );

  async function submit() {
    if (!lifetime.active()) return;
    if (running.current || created || !enabled || (pending.current && definiteFailure)) return;
    if (!pending.current) {
      if (!metadataCurrent(release)) return;
      const draft = albumDraft(
        release,
        terms,
        rows.map((row) => row.statement),
      );
      if (draft.errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors: draft.errors });
        setCorrections(albumCreateCorrections(draft.errors, terms, rows, release, locale, termsId));
        return;
      }
      pending.current = { item: draft.item, key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await transport.create(pending.current);
      if (!lifetime.active()) return;
      if (result.ok) {
        // Native success releases departure protection before exposing its returned reader.
        departure.release();
        setCreated(result);
      } else {
        setFailure(result);
        setCorrections(albumCreateCorrections(result.errors ?? [], terms, rows, release, locale, termsId));
        if (result.refreshDefinitions) await onReload();
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

  if (departed) return null;

  if (created)
    return (
      <section className="min-w-0">
        <ContentItemFrame as="div" className={panelClassName}>
          <ContentItemHeading className="text-xl font-semibold">
            <span role="status">{m.catalogue_create_created({}, o)}</span>
          </ContentItemHeading>
          <div data-content-item-slot="preview" className="min-w-0 space-y-4">
            <code className="block min-w-0 max-w-full whitespace-normal break-all text-sm" dir="ltr">
              {created.id}
            </code>
            {created.reader.state === 'ready' ? (
              <a className={buttonVariants({ className: actionClassName })} href={created.reader.href}>
                {m.catalogue_create_open({}, o)}
              </a>
            ) : (
              <>
                <p>
                  {created.reader.state === 'concealed'
                    ? m.catalogue_create_concealed({}, o)
                    : m.catalogue_create_reader_unavailable({}, o)}
                </p>
                <Button
                  className={actionClassName}
                  disabled={busy}
                  onClick={async () => {
                    if (!lifetime.active() || running.current) return;
                    running.current = true;
                    setBusy(true);
                    try {
                      const reader = await transport.read(created.id);
                      if (!lifetime.active()) return;
                      setCreated({ ...created, reader });
                    } catch {
                      if (!lifetime.active()) return;
                      setCreated({ ...created, reader: { state: 'unavailable' } });
                    } finally {
                      if (!lifetime.active()) return;
                      running.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  {m.catalogue_create_retry({}, o)}
                </Button>
              </>
            )}
          </div>
        </ContentItemFrame>
      </section>
    );

  return (
    <form
      className="min-w-0 space-y-6"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <a
        className={buttonVariants({ variant: 'outline', className: actionClassName })}
        href={`/${locale}/search${terms[0]?.label.trim() ? `?q=${encodeURIComponent(terms[0].label.trim())}` : ''}`}
      >
        {m.catalogue_create_search({}, o)}
      </a>
      <fieldset id="album-terms" disabled={locked} className="min-w-0">
        <legend className="sr-only">{m.catalogue_create_terms({}, o)}</legend>
        <ContentItemFrame as="div" className={panelClassName}>
          <ContentItemHeading className="text-xl font-semibold">{m.catalogue_create_terms({}, o)}</ContentItemHeading>
          <div data-content-item-slot="preview" className="min-w-0 space-y-5">
            {terms.map((term, index) => (
              <fieldset key={term.id} id={`${termsId}-${term.id}`} className="grid min-w-0 gap-3 pb-4 sm:grid-cols-2">
                <legend className="sr-only">{term.language || m.catalogue_create_language({}, o)}</legend>
                {(['language', 'label', 'description', 'aliases'] as const).map((field) => {
                  const label = {
                    language: m.catalogue_create_language({}, o),
                    label: m.catalogue_create_label({}, o),
                    description: m.catalogue_create_description({}, o),
                    aliases: m.catalogue_create_aliases({}, o),
                  }[field];
                  const update = (value: string) => updateTerm(term.id, field, value);
                  return (
                    <Field key={field} className="min-w-0">
                      <FieldLabel className={labelClassName} htmlFor={`${termsId}-${field}-${term.id}`}>
                        {label}
                      </FieldLabel>
                      {field === 'aliases' ? (
                        <Textarea
                          className="min-w-0"
                          id={`${termsId}-${field}-${term.id}`}
                          value={term[field]}
                          onChange={(event) => update(event.target.value)}
                        />
                      ) : (
                        <Input
                          className={inputClassName}
                          id={`${termsId}-${field}-${term.id}`}
                          value={term[field]}
                          onChange={(event) => update(event.target.value)}
                        />
                      )}
                    </Field>
                  );
                })}
                {index > 0 && (
                  <CreateSubjectLanguageRemove
                    locale={locale}
                    populated={!!(term.language || term.label || term.description || term.aliases)}
                    rowId={`${termsId}-${term.id}`}
                    focusId={terms[index + 1] ? `${termsId}-language-${terms[index + 1]!.id}` : `${termsId}-add`}
                    disabled={locked}
                    onRemove={() => {
                      if (locked || running.current || pending.current || !metadataCurrent(release)) return false;
                      setTerms((previous) => previous.filter((row) => row.id !== term.id));
                      setFailure(undefined);
                      return true;
                    }}
                  />
                )}
              </fieldset>
            ))}
            <Button
              id={`${termsId}-add`}
              className="h-auto min-h-11 max-w-full whitespace-normal"
              type="button"
              variant="outline"
              disabled={locked}
              onClick={(event) => {
                if (!termEditingAdmitted.current() || currentRelease.current !== release) return;
                const id = nextTermId.current++;
                setTerms((previous) => [...previous, { id, language: '', label: '', description: '', aliases: '' }]);
                focusAddedLanguage(
                  event,
                  `${termsId}-language-${id}`,
                  () => termEditingAdmitted.current() && currentRelease.current === release && termIds.current.has(id),
                );
              }}
            >
              {m.catalogue_create_add_language({}, o)}
            </Button>
          </div>
        </ContentItemFrame>
      </fieldset>
      <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-label={m.album_initial_facts({}, o)}>
        <ContentItemHeading className="text-xl font-semibold">{m.album_initial_facts({}, o)}</ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.album_initial_help({}, o)}</p>
        {rows.map((row) => (
          <AlbumInitialField
            key={row.id}
            row={row}
            release={release}
            metadataReady={metadataReady}
            locale={locale}
            search={search}
            disabled={locked}
            change={(update) => {
              if (!editable()) return false;
              const item = currentRows.current.find((item) => item.id === row.id);
              if (!item) return false;
              const statement = update(item.statement);
              if (!statement) return false;
              const before = item.statement.qualifiers ?? [];
              if (statement.qualifiers?.length !== item.statement.qualifiers?.length) setFailure(undefined);
              let nextQualifierId = item.nextQualifierId ?? before.length;
              const qualifierIds = (statement.qualifiers ?? []).map((part) => {
                const at = before.findIndex((old) => old.property.id === part.property.id);
                return at < 0 ? nextQualifierId++ : (item.qualifierIds?.[at] ?? at);
              });
              replaceRows(
                currentRows.current.map((current) =>
                  current === item ? { ...item, statement, qualifierIds, nextQualifierId } : current,
                ),
              );
              return true;
            }}
            remove={() => {
              if (!editable()) return;
              replaceRows(currentRows.current.filter((item) => item.id !== row.id));
            }}
          />
        ))}
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
          <InitialFieldChoice
            id="album-field"
            groups={[{ properties: choices }]}
            release={release}
            occupied={rows.map((row) => row.statement.property.id)}
            locale={locale}
            disabled={locked}
            fieldClassName="w-full min-w-0 sm:flex-1"
            labelClassName={labelClassName}
            selectClassName="w-full [&>select]:min-h-11"
            buttonClassName="h-auto min-h-11 max-w-full whitespace-normal"
            add={(property) => {
              if (!editable()) return false;
              const id = crypto.randomUUID();
              replaceRows([
                ...currentRows.current,
                {
                  id,
                  statement: {
                    property: { id: property },
                    value: { type: 'value', content: '' },
                    qualifiers: [],
                    references: [],
                    rank: 'normal',
                  },
                },
              ]);
              return {
                targetId: `album-row-${id}-value`,
                current: () => editable() && currentRows.current.some((row) => row.id === id),
              };
            }}
          />
        </fieldset>
      </section>
      <div className="space-y-3">
        {!metadataReady && <p role="alert">{m.album_missing({}, o)}</p>}
        <Button
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void onReload()}
        >
          {m.correction_reload({}, o)}
        </Button>
      </div>
      {failure && (
        <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 p-4">
          <p>
            {failure.reason === 'invalid'
              ? m.catalogue_create_invalid({}, o)
              : failure.reason === 'conflict'
                ? m.catalogue_create_conflict({}, o)
                : failure.reason === 'denied'
                  ? m.catalogue_create_denied({}, o)
                  : failure.reason === 'signed-out'
                    ? m.catalogue_create_signed_out({}, o)
                    : m.catalogue_create_uncertain({}, o)}
          </p>
          {corrections.map((correction, index) => (
            <p key={index}>
              {metadataReady &&
              correction.target &&
              (terms.some((term) =>
                ['language', 'label', 'description', 'aliases'].some(
                  (field) => correction.target === `${termsId}-${field}-${term.id}`,
                ),
              ) ||
                rows.some(
                  (row) =>
                    correction.target === `album-citation-${row.id}` ||
                    correction.target === `album-row-${row.id}` ||
                    correction.target!.startsWith(`album-row-${row.id}-`),
                )) ? (
                <a
                  className="inline-flex min-h-11 min-w-11 max-w-full items-center underline [overflow-wrap:anywhere] md:pointer-fine:min-h-8"
                  href={`#${correction.target}`}
                  onClick={(event) => {
                    event.preventDefault();
                    if (!lifetime.active()) return;
                    // Following an invalid-field correction explicitly reviews a new command.
                    if (failure.reason === 'invalid' && !busy && metadataCurrent(release)) {
                      flushSync(() => {
                        pending.current = null;
                        setFailure({ ...failure });
                      });
                    }
                    const target = document.getElementById(correction.target!);
                    const input = target?.matches('input,textarea,select')
                      ? target
                      : target?.querySelector<HTMLElement>(
                          'input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[role="combobox"]',
                        );
                    (input ?? target)?.focus();
                  }}
                >
                  {correction.label}: {correction.advice}
                </a>
              ) : (
                <span>
                  {correction.label}: {correction.advice}
                </span>
              )}
              <code className="block break-all" dir="ltr">
                {correction.pointer} ({correction.code})
              </code>
            </p>
          ))}
          {pending.current && definiteFailure && (
            <Button
              className={actionClassName}
              type="button"
              variant="outline"
              onClick={() => {
                pending.current = null;
                setFailure({ ...failure });
              }}
            >
              {m.catalogue_create_review_new({}, o)}
            </Button>
          )}
        </div>
      )}
      <Button
        className={actionClassName}
        type="submit"
        disabled={busy || !enabled || (!pending.current && !metadataReady) || (!!pending.current && !!definiteFailure)}
      >
        {busy
          ? m.catalogue_create_saving({}, o)
          : pending.current
            ? m.catalogue_create_retry({}, o)
            : m.album_create({}, o)}
      </Button>
    </form>
  );
}

function AlbumInitialField({
  row,
  release,
  metadataReady,
  locale,
  search,
  disabled,
  change,
  remove,
}: {
  row: Row;
  release: Release;
  metadataReady: boolean;
  locale: string;
  search: EntityPickerSearch;
  disabled: boolean;
  change: (update: StatementEdit) => boolean;
  remove: () => void;
}) {
  const o = { locale: locale as never };
  const [picked, setPicked] = useState<Record<string, EntityPickerSubject>>({});
  const statement = row.statement;
  const definition = release.properties[statement.property.id];
  const qualifiers = statement.qualifiers ?? [];
  const qualifierIsAdmitted = (current: StatementInput, currentRelease: Release, qualifier: string) => {
    const parent = currentRelease.properties[current.property.id];
    const parts = current.qualifiers ?? [];
    return (
      !!qualifier &&
      !!parent?.qualifiers.includes(qualifier) &&
      !!currentRelease.types[albumType]?.properties.includes(current.property.id) &&
      !!currentRelease.properties[qualifier] &&
      parts.length < 16 &&
      !parts.some((part) => part.property.id === qualifier)
    );
  };
  const qualifierOptions = definition?.qualifiers.filter((id) => qualifierIsAdmitted(statement, release, id)) ?? [];
  const [qualifierChoice, setQualifierChoice] = useState('');
  const qualifierAllowed = qualifierOptions.includes(qualifierChoice);
  const qualifierState = useRef({ row, release, metadataReady, disabled, choice: qualifierChoice, qualifierOptions });
  qualifierState.current = { row, release, metadataReady, disabled, choice: qualifierChoice, qualifierOptions };
  const lifetime = useEditorLifetime();
  const section = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const qualifierFocus = useRef<{ cancel: () => void }>();
  const [confirming, setConfirming] = useState(false);
  const current = useRef({ disabled, remove });
  current.current = { disabled, remove };
  const editable = () => lifetime.active() && !current.current.disabled;
  useLayoutEffect(() => {
    if (qualifierChoice && !qualifierAllowed) setQualifierChoice('');
  }, [qualifierChoice, qualifierAllowed]);
  useLayoutEffect(() => () => qualifierFocus.current?.cancel(), []);
  useLayoutEffect(() => {
    if (!editable()) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };
  const removeRow = () => {
    if (!editable() || !section.current?.isConnected) return;
    const root = section.current;
    const controls = [
      ...(root
        .closest('form')
        ?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"], [contenteditable="true"]') ??
        []),
    ];
    const first = controls.findIndex((control) => root.contains(control));
    const last = controls.findLastIndex((control) => root.contains(control));
    const survivor = [...controls.slice(last + 1), ...controls.slice(0, first).reverse()].find(
      (control) =>
        !control.matches(':disabled, [aria-disabled="true"], [type="hidden"]') && !control.closest('[hidden], [inert]'),
    );
    current.current.remove();
    survivor?.focus();
  };
  const hasValue = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value === null || value === undefined) return false;
    if (typeof value === 'object') return Object.values(value).some(hasValue);
    return true;
  };
  const meaningful = (part: StatementInput | NonNullable<StatementInput['qualifiers']>[number]) =>
    part.value.type !== 'value' || hasValue(part.value.content);
  const populated =
    meaningful(statement) ||
    statement.qualifiers?.some(meaningful) ||
    statement.references.some((reference) => reference.parts.some(meaningful));
  const removal = confirming ? (
    <div
      role="group"
      aria-label={m.candidate_confirm_title({ action: m.recipe_remove_field({}, o) }, o)}
      className="space-y-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelRemoval();
        }
      }}
    >
      <p>{m.candidate_confirm_title({ action: m.recipe_remove_field({}, o) }, o)}</p>
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
        <Button className={actionClassName} type="button" variant="destructive" disabled={disabled} onClick={removeRow}>
          {m.recipe_remove_field({}, o)}
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
        if (editable()) populated ? setConfirming(true) : removeRow();
      }}
    >
      {m.recipe_remove_field({}, o)}
    </Button>
  );
  // Retired metadata cannot describe private values as current. Keep the complete assertion
  // inspectable, including qualifiers and citations, until it can be reconciled deliberately.
  if (!metadataReady || !definition || !release.types[albumType]?.properties.includes(statement.property.id))
    return (
      <fieldset
        ref={section}
        id={`album-row-${row.id}`}
        tabIndex={-1}
        disabled={disabled}
        className="min-w-0 space-y-3"
      >
        <legend>{statement.property.id}</legend>
        <p role="status">{m.correction_preserved({}, o)}</p>
        <pre className="whitespace-pre-wrap break-all text-sm" dir="ltr">
          {JSON.stringify(statement, null, 2)}
        </pre>
        {removal}
      </fieldset>
    );
  const qualifierId = (at: number) => row.qualifierIds?.[at] ?? at;
  const qualifierControlId = (at: number) => `album-row-${row.id}-qualifier-${qualifierId(at)}`;
  const named = (id: string) => pickText(release.properties[id]?.labels ?? {}, locale).text;
  const target = (value: unknown): EntityPickerSubject[] =>
    typeof value === 'string' && value
      ? [
          picked[value] ?? {
            id: value,
            title: m.subject_value_unlabelled({}, o),
            types: [],
            typeLabel: '',
            cover: null,
          },
        ]
      : [];
  const remember = (items: EntityPickerSubject[]) =>
    setPicked((previous) => ({ ...previous, ...Object.fromEntries(items.map((item) => [item.id, item])) }));
  // Admission happens before either private values or picker descriptors change. Each
  // callback compares only its own part, then patches the latest surviving statement.
  const edit = (update: StatementEdit, items?: EntityPickerSubject[]) => {
    if (!editable() || !section.current?.isConnected || !change(update)) return false;
    if (items) remember(items);
    return true;
  };
  const deferQualifierFocus = (button: HTMLButtonElement, qualifier: string) => {
    qualifierFocus.current?.cancel();
    const document = button.ownerDocument;
    const view = document.defaultView;
    if (!view) return;
    let active = true;
    let frame = 0;
    const cancel = () => {
      if (!active) return;
      active = false;
      view.cancelAnimationFrame(frame);
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', tabbed, true);
      view.removeEventListener('blur', cancel);
      if (qualifierFocus.current?.cancel === cancel) qualifierFocus.current = undefined;
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== button) cancel();
    };
    const tabbed = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    qualifierFocus.current = { cancel };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', tabbed, true);
    view.addEventListener('blur', cancel);
    frame = view.requestAnimationFrame(() => {
      const state = qualifierState.current;
      const latest = state.row.statement;
      const parent = state.release.properties[latest.property.id];
      const parts = latest.qualifiers ?? [];
      const group = [...(section.current?.querySelectorAll<HTMLElement>('[data-album-qualifier]') ?? [])].find(
        (element) => element.dataset.albumQualifier === qualifier,
      );
      const target = group?.querySelector<HTMLElement>('input:not([type="hidden"]), select, textarea');
      const admitted =
        active &&
        state.metadataReady &&
        editable() &&
        state.release.types[albumType]?.properties.includes(latest.property.id) &&
        !!parent?.qualifiers.includes(qualifier) &&
        !!state.release.properties[qualifier] &&
        parts.length <= 16 &&
        parts.filter((part) => part.property.id === qualifier).length === 1 &&
        section.current?.isConnected &&
        button.isConnected &&
        !button.disabled &&
        document.activeElement === button;
      if (!admitted || !target?.isConnected || target.matches(':disabled')) {
        cancel();
        return;
      }
      cancel();
      target.focus();
    });
  };
  const addQualifier = (button: HTMLButtonElement, keyboard: boolean) => {
    const state = qualifierState.current;
    const qualifier = state.choice;
    if (
      !qualifier ||
      !state.qualifierOptions.includes(qualifier) ||
      !state.metadataReady ||
      !editable() ||
      !section.current?.isConnected
    )
      return;
    const added = edit((latest) => {
      const currentState = qualifierState.current;
      if (
        currentState.choice !== qualifier ||
        !currentState.metadataReady ||
        latest.qualifiers !== currentState.row.statement.qualifiers ||
        !qualifierIsAdmitted(latest, currentState.release, qualifier)
      )
        return undefined;
      return {
        ...latest,
        qualifiers: [
          ...(latest.qualifiers ?? []),
          { property: { id: qualifier }, value: { type: 'value', content: '' } },
        ],
      };
    });
    if (!added) return;
    setQualifierChoice('');
    if (keyboard && button.ownerDocument.activeElement === button) deferQualifierFocus(button, qualifier);
  };
  const editValue = (value: StatementInput['value'], items?: EntityPickerSubject[]) =>
    edit((latest) => (latest.value === statement.value ? { ...latest, value } : undefined), items);
  const targetSearch =
    (property: string): EntityPickerSearch =>
    async (text, signal) =>
      (await search(text, signal)).filter((item) => albumTarget(release, property, item.types));
  return (
    <fieldset ref={section} id={`album-row-${row.id}`} tabIndex={-1} disabled={disabled} className="min-w-0">
      <legend className="sr-only">
        <DefinitionMeaning values={definition?.labels} locale={locale} />
      </legend>
      <ContentItemFrame as="div" className={panelClassName}>
        <ContentItemHeading level={3} className="text-lg font-semibold">
          <DefinitionMeaning values={definition?.labels} locale={locale} />
        </ContentItemHeading>
        <div data-content-item-slot="preview" className="min-w-0 space-y-4">
          {(!definition || !release.types[albumType]?.properties.includes(statement.property.id)) && (
            <p role="alert">{m.correction_stale({}, o)}</p>
          )}
          <p className="text-sm text-muted-foreground">
            <DefinitionMeaning values={definition?.descriptions} locale={locale} />
          </p>
          <div id={`album-row-${row.id}-value`} tabIndex={-1}>
            {definition?.datatype === 'wikibase-item' ? (
              <EntityPicker
                label={named(statement.property.id)}
                search={targetSearch(statement.property.id)}
                src={coverSrc}
                disabled={disabled}
                value={statement.value.type === 'value' ? target(statement.value.content) : []}
                onValueChange={(items) => {
                  editValue({ type: 'value', content: items[0]?.id ?? '' }, items);
                }}
              />
            ) : (
              <ScalarControl
                feedback={{ id: `album-row-${row.id}`, address: 'fact', errors: [] }}
                part={statement}
                definition={definition}
                read={{ release, public: { related: {} } }}
                locale={locale}
                onChange={(value) => editValue(value)}
              />
            )}
          </div>
          {definition?.datatype === 'url' && statement.value.type === 'value' && (
            <p
              dir="ltr"
              className="min-w-0 max-w-full whitespace-normal text-sm text-muted-foreground [overflow-wrap:anywhere]"
            >
              {String(statement.value.content)}
            </p>
          )}
          {qualifiers.map((part, at) => {
            const metadata = release.properties[part.property.id];
            const identity = qualifierId(at);
            const editQualifier = (value: typeof part.value, items?: EntityPickerSubject[]) =>
              edit(
                (latest) =>
                  latest.qualifiers?.includes(part)
                    ? {
                        ...latest,
                        qualifiers: latest.qualifiers.map((item) => (item === part ? { ...item, value } : item)),
                      }
                    : undefined,
                items,
              );
            return (
              <div
                key={identity}
                data-album-qualifier={part.property.id}
                className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <div id={qualifierControlId(at)} tabIndex={-1} className={qualifierClassName}>
                  {metadata?.datatype === 'wikibase-item' ? (
                    <Field className="gap-2">
                      <FieldTitle>{named(part.property.id)}</FieldTitle>
                      <EntityPicker
                        label={named(part.property.id)}
                        search={targetSearch(part.property.id)}
                        src={coverSrc}
                        disabled={disabled}
                        value={part.value.type === 'value' ? target(part.value.content) : []}
                        onValueChange={(items) => editQualifier({ type: 'value', content: items[0]?.id ?? '' }, items)}
                      />
                    </Field>
                  ) : (
                    <QualifierInput
                      definition={
                        metadata
                          ? {
                              id: part.property.id,
                              label: named(part.property.id),
                              datatype: metadata.datatype,
                              targets: metadata.targets ?? [],
                            }
                          : undefined
                      }
                      snak={{ ...part, property: { ...part.property, data_type: metadata?.datatype ?? 'string' } }}
                      index={identity}
                      label={named(part.property.id)}
                      search={targetSearch(part.property.id)}
                      target={target}
                      remember={() => {}}
                      disabled={disabled}
                      onChange={(value) => editQualifier(value)}
                    />
                  )}
                </div>
                <AlbumQualifierRemoval
                  locale={locale}
                  label={named(part.property.id)}
                  populated={meaningful(part)}
                  disabled={disabled}
                  onRemove={() =>
                    edit((latest) =>
                      latest.qualifiers?.includes(part)
                        ? {
                            ...latest,
                            qualifiers: latest.qualifiers.filter((item) => item !== part),
                          }
                        : undefined,
                    )
                  }
                  focusId={
                    qualifiers.length > 1
                      ? qualifierControlId(at + 1 < qualifiers.length ? at + 1 : at - 1)
                      : `album-qualifier-${row.id}`
                  }
                />
              </div>
            );
          })}
          {!!definition?.qualifiers.length && (
            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
              <Field className="min-w-0 basis-full sm:basis-48 sm:flex-1">
                <FieldLabel className={labelClassName} htmlFor={`album-qualifier-${row.id}`}>
                  {m.relation_qualifier({}, o)}
                </FieldLabel>
                <NativeSelect
                  className={selectClassName}
                  id={`album-qualifier-${row.id}`}
                  value={qualifierAllowed ? qualifierChoice : ''}
                  disabled={disabled || qualifiers.length >= 16}
                  onChange={(event) => {
                    const selected = event.target.value;
                    const state = qualifierState.current;
                    if (!editable() || !state.metadataReady) return;
                    if (!selected) setQualifierChoice('');
                    else if (state.qualifierOptions.includes(selected)) setQualifierChoice(selected);
                  }}
                >
                  <NativeSelectOption value="">{m.relation_add_qualifier({}, o)}</NativeSelectOption>
                  {qualifierOptions.map((id) => (
                    <NativeSelectOption key={id} value={id}>
                      {named(id)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Button
                className={actionClassName}
                type="button"
                variant="outline"
                disabled={disabled || !qualifierAllowed}
                onClick={(event) =>
                  addQualifier(
                    event.currentTarget,
                    event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget,
                  )
                }
              >
                {m.relation_add_qualifier({}, o)}
              </Button>
            </div>
          )}
          <Field className="min-w-0">
            <FieldLabel className={labelClassName} htmlFor={`album-citation-${row.id}`}>
              {m.relation_citation({}, o)}
            </FieldLabel>
            <Input
              className={inputClassName}
              id={`album-citation-${row.id}`}
              type="url"
              value={
                statement.references[0]?.parts[0]?.value.type === 'value'
                  ? String(statement.references[0].parts[0].value.content)
                  : ''
              }
              onChange={(event) =>
                edit((latest) =>
                  latest.references === statement.references
                    ? {
                        ...latest,
                        references: event.target.value
                          ? [
                              {
                                parts: [
                                  {
                                    property: { id: 'schema:url' },
                                    value: { type: 'value', content: event.target.value },
                                  },
                                ],
                              },
                            ]
                          : [],
                      }
                    : undefined,
                )
              }
            />
            <p
              dir="ltr"
              className="min-w-0 max-w-full whitespace-normal text-sm text-muted-foreground [overflow-wrap:anywhere]"
            >
              {statement.references[0]?.parts[0]?.value.type === 'value'
                ? String(statement.references[0].parts[0].value.content)
                : ''}
            </p>
          </Field>
          {removal}
        </div>
      </ContentItemFrame>
    </fieldset>
  );
}

/** Each mounted qualifier owns its pending choice; sibling edits cannot redirect it. */
function AlbumQualifierRemoval({
  locale,
  label,
  populated,
  disabled,
  onRemove,
  focusId,
}: {
  locale: string;
  label: string;
  populated: boolean;
  disabled: boolean;
  onRemove: () => void;
  focusId: string;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const action = `${m.relation_remove({}, o)}: ${label}`;
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const current = useRef({ disabled, onRemove, focusId });
  current.current = { disabled, onRemove, focusId };
  const editable = () => lifetime.active() && !current.current.disabled;
  useLayoutEffect(() => {
    if (!editable()) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirming(false);
  };
  const confirmRemoval = () => {
    if (!editable() || !trigger.current?.isConnected) return;
    const destination = current.current.focusId;
    flushSync(() => current.current.onRemove());
    const target = document.getElementById(destination);
    (
      target?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),button:not(:disabled)') ?? target
    )?.focus();
  };
  return (
    <div className="space-y-2">
      <Button
        ref={trigger}
        className={actionClassName}
        type="button"
        variant="outline"
        aria-label={action}
        disabled={disabled}
        hidden={confirming}
        onClick={() => {
          if (editable()) populated ? setConfirming(true) : confirmRemoval();
        }}
      >
        {m.relation_remove({}, o)}
      </Button>
      {confirming && (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action }, o)}</p>
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
              aria-label={action}
              disabled={disabled}
              onClick={confirmRemoval}
            >
              {m.relation_remove({}, o)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
