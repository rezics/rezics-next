import {
  CatalogueCurrentReading,
  catalogueEditor,
  useEditorLifetime,
  useCurrentReadingActive,
} from './editor-lifetime';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickText } from '@rezics/composition';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import { ViewHeading } from '../pages/view-heading';
import { subjectHref } from '../../subject/subject-href';
import type { CandidateTransport } from '../../subject/candidate-review';
import { createTypes, type CreateTransport, type InitialSubject } from './create-subject';
import { CreateSubjectForm } from './create-subject-form';
import { EditorFailure, ScalarControl } from './statement-editor-view';
import { controlId, presentStatementViolations } from './statement-validation-presentation';
import type { EditorRead, StatementInput } from './statement-editor';
import { SubjectFacts } from './subject-facts-view';
import type { FactsTransport } from './subject-facts';
import { isLiteraryType, literaryFields, literaryInitialItem, type LiteraryRead } from './literary-profile';

export type LiteraryTransport = Pick<CreateTransport, 'submit' | 'read'> & { load: () => Promise<LiteraryRead> };
type Ready = Extract<LiteraryRead, { ok: true }>;
type InitialRow = { id: string; statement: StatementInput };
const editableInitialFacts = () => true;
const coarseTarget = 'max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const wrappingLink = `${coarseTarget} max-w-full whitespace-normal break-words`;
const keyboardFocus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const touchAction = `${coarseTarget} max-md:w-full pointer-coarse:w-full`;
const disclosureSummary = `min-h-8 min-w-0 cursor-pointer break-words text-xl font-semibold max-md:min-h-11 pointer-coarse:min-h-11 ${keyboardFocus} [overflow-wrap:anywhere]`;

const initialAction = `h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 [overflow-wrap:anywhere] ${keyboardFocus} max-md:w-full pointer-coarse:w-full`;
const initialPropertySelect = `w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11 [&_select]:max-w-full [&_select]:whitespace-normal [&_select]:[overflow-wrap:anywhere] [&_select:focus-visible]:outline-2 [&_select:focus-visible]:outline-offset-2 [&_select:focus-visible]:outline-ring [&_select]:ps-3 [&_select]:pe-8 rtl:[&_[data-slot=native-select-icon]]:right-auto rtl:[&_[data-slot=native-select-icon]]:left-2.5`;

/** Resolve native ordinals once; retained feedback must never follow a removed row's neighbour. */
function initialFactControl(pointer: string, rows: InitialRow[], read: Ready, type: string, locale: string) {
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return;
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [kind, property, ordinal, ...nested] = segments;
  if (kind !== 'statements' || !property || !ordinal || !/^(0|[1-9]\d*)$/.test(ordinal)) return;
  const index = Number(ordinal);
  const siblings = rows.filter((row) => row.statement.property.id === property);
  if (!Number.isSafeInteger(index) || index >= siblings.length) return;
  const row = siblings[index]!;
  if (!literaryFields(read.release, type, locale).scalars.includes(property)) return;
  let address = 'fact';
  let part: Pick<StatementInput, 'property'> = row.statement;
  let path = nested;
  // Initial facts render exactly one URL citation, with no qualifier or additional reference editors.
  if (nested.slice(0, 4).join('/') === 'references/0/parts/0') {
    const citation = row.statement.references[0]?.parts[0];
    if (citation?.property.id !== 'schema:url') return;
    part = citation;
    address = 'reference-0-part-0';
    path = nested.slice(4);
  }
  // Re-encode decoded segments so an escaped slash cannot become a supported nested address.
  const suffix = '/' + path.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
  const tail = address === 'fact' ? suffix : `/references/0/parts/0${suffix}`;
  const id = `literary-fact-${row.id}`;
  const presented = presentStatementViolations(
    [{ pointer: `/statement${tail}`, code: 'invalid_format' }],
    row.statement,
    read.release,
    locale,
    id,
  )[0]!;
  if (!presented.target.startsWith(`${id}-${address}-`)) return;
  let target = presented.target;
  // The shared editor groups dates; native time and precision errors can name its actual inputs.
  if (read.release.properties[part.property.id]?.datatype === 'time') {
    if (suffix === '/value/content/precision') target = controlId(id, address, 'precision');
    else if (suffix === '/value/content/time') target = controlId(id, address, 'year');
  }
  return {
    id: target,
    label: `${pickText(read.release.properties[property]!.labels, locale).text} ${index + 1} · ${presented.label}`,
  };
}

/** Keep confirmation attached to the private row, including when its definition retires. */
function InitialFactRemoval({
  row,
  disabled,
  locale,
  onRemove,
}: {
  row: InitialRow;
  disabled: boolean;
  locale: string;
  onRemove: () => void;
}) {
  const o = { locale: locale as never };
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [confirmingId, setConfirmingId] = useState<string>();
  const confirming = confirmingId === row.id;
  const current = useRef({ disabled, id: row.id, onRemove });
  current.current = { disabled, id: row.id, onRemove };
  const editable = () => !current.current.disabled && current.current.id === row.id;
  useLayoutEffect(() => {
    if (disabled) return;
    if (confirming) cancel.current?.focus();
    else if (restoreFocus.current) {
      trigger.current?.focus();
      restoreFocus.current = false;
    }
  }, [confirming, disabled]);
  const cancelRemoval = () => {
    restoreFocus.current = true;
    setConfirmingId(undefined);
  };
  const remove = () => {
    const section = holder.current?.closest('section');
    if (!editable() || !section?.isConnected) return;
    const controls = [
      ...((section.closest('form') ?? section.closest('fieldset'))?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [tabindex="0"], [contenteditable="true"]',
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
  };
  const hasContent = (value: unknown): boolean => {
    if (typeof value === 'string') return !!value.trim();
    if (value == null) return false;
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const populatedPart = (part: StatementInput | StatementInput['references'][number]['parts'][number]) =>
    part.value.type !== 'value' || hasContent(part.value.content);
  const populated =
    populatedPart(row.statement) ||
    row.statement.qualifiers?.some(populatedPart) ||
    row.statement.references.some((reference) => reference.parts.some(populatedPart));
  return (
    <div ref={holder}>
      {confirming ? (
        <div
          role="group"
          aria-label={m.candidate_confirm_title({ action: m.literary_remove_fact({}, o) }, o)}
          className="space-y-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRemoval();
            }
          }}
        >
          <p>{m.candidate_confirm_title({ action: m.literary_remove_fact({}, o) }, o)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancel}
              className={initialAction}
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={cancelRemoval}
            >
              {m.candidate_cancel({}, o)}
            </Button>
            <Button className={initialAction} type="button" variant="destructive" disabled={disabled} onClick={remove}>
              {m.literary_remove_fact({}, o)}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          ref={trigger}
          className={initialAction}
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (editable()) populated ? setConfirmingId(row.id) : remove();
          }}
        >
          {m.literary_remove_fact({}, o)}
        </Button>
      )}
    </div>
  );
}

/** Optional initial facts share the scalar codecs. A row exists only after an explicit Add action. */
export function InitialFacts({
  type,
  read,
  locale,
  disabled,
  rows,
  change,
  canEdit = editableInitialFacts,
}: {
  type: string;
  read: Ready;
  locale: string;
  disabled: boolean;
  rows: InitialRow[];
  change: (rows: InitialRow[]) => void;
  canEdit?: () => boolean;
}) {
  const o = { locale: locale as never };
  const [property, setProperty] = useState('');
  const propertyId = useId();
  const latest = useRef({ rows, change });
  latest.current = { rows, change };
  const holders = useRef(new WeakMap<InitialRow, { row: object; value: object; citation: object }>());
  for (const row of rows) if (!holders.current.has(row)) holders.current.set(row, { row: {}, value: {}, citation: {} });
  const observation = useMemo(() => ({}), [type, locale, read.release, disabled, canEdit]);
  const current = useRef<object | null>(observation);
  current.current = observation;
  const addFocus = useRef<{
    observation: object;
    row: InitialRow;
    source: HTMLButtonElement;
    release: () => void;
  } | null>(null);
  const cancelAddFocus = () => {
    addFocus.current?.release();
    addFocus.current = null;
  };
  useLayoutEffect(() => {
    current.current = observation;
    return () => {
      current.current = null;
      cancelAddFocus();
    };
  }, [observation]);
  const admitted = () => current.current === observation && !disabled && canEdit();
  useLayoutEffect(() => {
    const intent = addFocus.current;
    if (!intent) return;
    // Consume once: a missing, replaced or retired row cannot regain this intent later.
    cancelAddFocus();
    const row = latest.current.rows.find((row) => row.id === intent.row.id);
    const document = intent.source.ownerDocument;
    if (
      intent.observation !== observation ||
      !admitted() ||
      !row ||
      holders.current.get(row)?.row !== holders.current.get(intent.row)?.row ||
      (document.activeElement !== intent.source && document.activeElement !== document.body)
    )
      return;
    const target = document.getElementById(controlId(`literary-fact-${row.id}`, 'fact', 'state'));
    if (target?.isConnected && !target.matches(':disabled') && !target.closest('[hidden], [inert]')) target.focus();
  });
  if (!isLiteraryType(type)) return null;
  const fields = literaryFields(read.release, type, locale).scalars;
  const context = { release: read.release, public: { related: {} } };
  const currentRow = (row: InitialRow) => {
    const holder = holders.current.get(row);
    return admitted()
      ? latest.current.rows.find(
          (candidate) => candidate.id === row.id && holders.current.get(candidate)?.row === holder?.row,
        )
      : undefined;
  };
  const update = (row: InitialRow, part: 'value' | 'citation', value: StatementInput['value']) => {
    const next = currentRow(row);
    if (!next) return;
    const citation = row.statement.references[0]?.parts[0];
    if (holders.current.get(next)![part] !== holders.current.get(row)![part]) return;
    const statement = { ...next.statement };
    if (part === 'value') statement.value = value;
    else {
      const references = [...statement.references];
      const first = references[0];
      const parts = [...(first?.parts ?? [])];
      if (value.type === 'value' && value.content === '') parts.shift();
      else parts.splice(0, 1, { ...(citation ?? { property: { id: 'schema:url' } }), value });
      if (parts.length) references.splice(0, 1, { ...first, parts });
      else references.shift();
      statement.references = references;
    }
    const replacement = { ...next, statement };
    holders.current.set(replacement, { ...holders.current.get(next)!, [part]: {} });
    const updated = latest.current.rows.map((candidate) => (candidate === next ? replacement : candidate));
    latest.current = { ...latest.current, rows: updated };
    latest.current.change(updated);
  };
  return (
    <fieldset disabled={disabled} className="min-w-0 max-w-full">
      <legend className="max-w-full px-1 font-semibold [overflow-wrap:anywhere]">
        {m.literary_bibliography({}, o)}
      </legend>
      <ContentItemFrame as="div" className="min-w-0 space-y-4 rounded-xl bg-card p-4 sm:p-6 [overflow-wrap:anywhere]">
        <p className="text-sm text-muted-foreground">{m.literary_initial_help({}, o)}</p>
        {rows.map((row) => {
          const { id, statement } = row;
          const definition = read.release.properties[statement.property.id];
          const label = pickText(definition?.labels ?? {}, locale);
          const description = pickText(definition?.descriptions ?? {}, locale);
          const citation = statement.references[0]?.parts[0] ?? {
            property: { id: 'schema:url' },
            value: { type: 'value' as const, content: '' },
          };
          return (
            <section id={`literary-fact-${id}`} key={id} aria-label={label.text} className="min-w-0">
              <ContentItemFrame
                as="div"
                className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-4 [overflow-wrap:anywhere]"
              >
                {definition ? (
                  <>
                    <ContentItemHeading
                      level={3}
                      lang={label.lang ?? undefined}
                      className="break-words font-semibold [overflow-wrap:anywhere]"
                    >
                      {label.text}
                    </ContentItemHeading>
                    {description.text && (
                      <p
                        lang={description.lang ?? undefined}
                        className="break-words text-sm text-muted-foreground [overflow-wrap:anywhere]"
                      >
                        {description.text}
                      </p>
                    )}
                    <ScalarControl
                      feedback={{ id: `literary-fact-${id}`, address: 'fact', errors: [] }}
                      part={statement}
                      definition={definition}
                      read={context}
                      locale={locale}
                      onChange={(value) => update(row, 'value', value)}
                    />
                    <h4 className="text-sm font-medium">{m.correction_references({}, o)}</h4>
                    <ScalarControl
                      feedback={{ id: `literary-fact-${id}`, address: 'reference-0-part-0', errors: [] }}
                      part={citation}
                      definition={read.release.properties['schema:url']}
                      read={context}
                      locale={locale}
                      onChange={(value) => update(row, 'citation', value)}
                    />
                  </>
                ) : (
                  <EditorFailure locale={locale} reason="stale" />
                )}
                <InitialFactRemoval
                  row={row}
                  disabled={disabled}
                  locale={locale}
                  onRemove={() => {
                    const next = currentRow(row);
                    if (!next) return;
                    const updated = latest.current.rows.filter((candidate) => candidate !== next);
                    latest.current = { ...latest.current, rows: updated };
                    latest.current.change(updated);
                  }}
                />
              </ContentItemFrame>
            </section>
          );
        })}
        <div className="flex flex-wrap items-end gap-3 max-md:flex-col max-md:items-stretch pointer-coarse:flex-col pointer-coarse:items-stretch">
          <Field className="w-full min-w-0 flex-1">
            <FieldLabel
              className="min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]"
              htmlFor={propertyId}
            >
              {m.refinement_property({}, o)}
            </FieldLabel>
            <NativeSelect
              id={propertyId}
              className={initialPropertySelect}
              value={fields.includes(property) ? property : ''}
              onChange={(event) => setProperty(event.target.value)}
            >
              <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
              {fields
                .filter(
                  (id) =>
                    read.release.properties[id]!.multivalued || !rows.some((row) => row.statement.property.id === id),
                )
                .map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {pickText(read.release.properties[id]!.labels, locale).text}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <Button
            type="button"
            variant="outline"
            className={initialAction}
            disabled={
              !fields.includes(property) ||
              rows.length >= 12 ||
              (!read.release.properties[property]?.multivalued &&
                rows.some((row) => row.statement.property.id === property))
            }
            onClick={(event) => {
              cancelAddFocus();
              const currentRows = latest.current.rows;
              if (
                !admitted() ||
                !fields.includes(property) ||
                currentRows.length >= 12 ||
                (!read.release.properties[property]?.multivalued &&
                  currentRows.some((row) => row.statement.property.id === property))
              )
                return;
              const row: InitialRow = {
                id: crypto.randomUUID(),
                statement: {
                  property: { id: property },
                  value: { type: 'value', content: '' },
                  qualifiers: [],
                  references: [],
                  rank: 'normal',
                },
              };
              holders.current.set(row, { row: {}, value: {}, citation: {} });
              const source = event.currentTarget;
              const document = source.ownerDocument;
              if (event.detail === 0 && document.activeElement === source) {
                const moved = (event: FocusEvent) => {
                  if (event.target !== source) cancelAddFocus();
                };
                document.addEventListener('focusin', moved);
                document.addEventListener('pointerdown', cancelAddFocus);
                addFocus.current = {
                  observation,
                  row,
                  source,
                  release: () => {
                    document.removeEventListener('focusin', moved);
                    document.removeEventListener('pointerdown', cancelAddFocus);
                  },
                };
              }
              const updated = [...currentRows, row];
              latest.current = { ...latest.current, rows: updated };
              latest.current.change(updated);
              setProperty('');
            }}
          >
            {m.correction_add({}, o)}
          </Button>
        </div>
      </ContentItemFrame>
    </fieldset>
  );
}

export const LiteraryProfile = catalogueEditor(LiteraryProfileLive);

function LiteraryProfileLive({
  id,
  locale,
  session,
  transport,
  facts,
  review,
  relations,
  authored,
}: {
  id?: string | undefined;
  locale: string;
  session: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  transport: LiteraryTransport;
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations?: ReactNode;
  authored?: ReactNode;
}) {
  const lifetime = useEditorLifetime();
  const o = { locale: locale as never };
  const client = useQueryClient();
  const queryKey = ['literary-profile', id, locale, lifetime.generation];
  const query = useQuery({
    queryKey,
    queryFn: transport.load,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const readingKey = JSON.stringify([id, locale, lifetime.generation]);
  const refreshSequence = useRef(0);
  const [refresh, setRefresh] = useState({ key: readingKey, sequence: 0, pending: false });
  const readingRefresh = refresh.key === readingKey ? refresh : { key: readingKey, sequence: 0, pending: false };
  const [creationRetry, setCreationRetry] = useState<'pending' | 'settled'>();
  const creationHeading = useRef<HTMLHeadingElement>(null);
  const creationOpener = useRef<HTMLButtonElement>(null);
  const creationAttempt = useRef<
    | {
        pending: boolean;
        keyboard: boolean;
        completed: boolean;
        session: string;
        release: () => void;
      }
    | undefined
  >(undefined);
  const creationSession = useRef(session);
  creationSession.current = session;
  if (creationAttempt.current && creationAttempt.current.session !== session) creationAttempt.current.keyboard = false;
  useLayoutEffect(() => () => creationAttempt.current?.release(), []);
  const creationPending = query.isPending || query.isFetching || creationRetry === 'pending';
  const creationMetadata = useRef<{ id: string | undefined; locale: string; value: Ready } | undefined>(undefined);
  if (!id && creationRetry !== 'pending' && !query.isError && query.data?.ok)
    creationMetadata.current = { id, locale, value: query.data };
  // A failed metadata refresh must not unmount the entered terms, facts or sealed create command.
  const previous = creationMetadata.current;
  const read = !id && previous?.locale === locale ? previous.value : undefined;
  const creationRecoverable = useRef(false);
  creationRecoverable.current = !id && !read && !creationPending;
  const retryCreation = (opener: HTMLButtonElement, detail: number) => {
    if (!lifetime.active() || !creationRecoverable.current || creationAttempt.current?.pending) return;
    const document = opener.ownerDocument;
    const attempt = {
      pending: true,
      keyboard: detail === 0 && document.activeElement === opener,
      completed: false,
      session,
      release: () => {
        document.removeEventListener('focusin', moved);
        document.removeEventListener('pointerdown', pointed, true);
      },
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== opener) attempt.keyboard = false;
    };
    const pointed = () => {
      attempt.keyboard = false;
    };
    creationAttempt.current = attempt;
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', pointed, true);
    const settle = () => {
      if (!lifetime.active() || creationAttempt.current !== attempt) {
        attempt.release();
        return;
      }
      attempt.keyboard &&= document.activeElement === opener && creationSession.current === session;
      attempt.pending = false;
      attempt.completed = true;
      setCreationRetry('settled');
    };
    flushSync(() => setCreationRetry('pending'));
    try {
      void query.refetch({ cancelRefetch: false }).then(settle, settle);
    } catch {
      settle();
    }
  };
  useLayoutEffect(() => {
    const attempt = creationAttempt.current;
    if (!attempt?.completed || creationPending) return;
    attempt.completed = false;
    attempt.release();
    if (attempt.keyboard && lifetime.active()) (read ? creationHeading.current : creationOpener.current)?.focus();
  });
  const [drafts, setDrafts] = useState<Record<string, InitialRow[]>>({});
  // Keep independently entered facts when switching Types; only the currently chosen Type is submitted.
  const latest = useRef(drafts);
  latest.current = drafts;
  const heading = (
    <header className="space-y-3">
      <ViewHeading
        label={m.literary_title({}, o)}
        headingClassName={!id ? `font-sans ${keyboardFocus}` : 'font-sans'}
        headingRef={!id ? creationHeading : undefined}
        headingTabIndex={!id ? -1 : undefined}
      />
      {!id && (
        <>
          <p className="text-muted-foreground">{m.literary_intro({}, o)}</p>
          <p className="text-sm text-muted-foreground">{m.literary_grain({}, o)}</p>
        </>
      )}
    </header>
  );
  if (!id && !read)
    return (
      <article className="mx-auto max-w-4xl space-y-5 py-6">
        {heading}
        {creationPending ? (
          <p role="status">{m.candidate_loading({}, o)}</p>
        ) : (
          <EditorFailure locale={locale} reason={query.data && !query.data.ok ? query.data.reason : 'unavailable'} />
        )}
        {(!query.isPending || creationRetry) && (
          <Button
            ref={creationOpener}
            variant="outline"
            className={coarseTarget}
            aria-disabled={creationPending}
            onBlur={() => {
              if (creationAttempt.current) creationAttempt.current.keyboard = false;
            }}
            onClick={(event) => retryCreation(event.currentTarget, event.detail)}
          >
            {m.correction_retry({}, o)}
          </Button>
        )}
      </article>
    );
  if (!id && read)
    return (
      <section className="mx-auto max-w-3xl space-y-6 py-6">
        {heading}
        <CreateSubjectForm
          locale={locale}
          session={session}
          onNavigate={() => {
            /* Keep the exact current-reader link visible. */
          }}
          transport={{
            ...transport,
            definitions: async (refresh) => {
              // Query errors can retain successful data. Only the result of this read can admit new intent.
              let metadata = query.isError ? undefined : query.data;
              if (refresh || query.data?.ok === false) {
                const result = await query.refetch();
                metadata = result.isError ? undefined : result.data;
              }
              if (!lifetime.active()) return { ok: false as const, reason: 'denied' as const };
              if (!metadata?.ok) return { ok: false };
              // Keep preparation in sync with this successful release before the form can submit again.
              creationMetadata.current = { id, locale, value: metadata };
              return {
                ok: true,
                types: createTypes(metadata.release, locale).filter((type) => isLiteraryType(type.id)),
              };
            },
          }}
          profile={{
            scope: 'literary',
            metadata: {
              ready: !query.isError && query.data?.ok === true && !query.isFetching,
              pending: query.isFetching,
              failure: <p>{m.catalogue_create_unavailable({}, o)}</p>,
              // Retained choices support private drafts, including a Type that was subsequently retired.
              types: createTypes(read.release, locale).filter((type) => isLiteraryType(type.id)),
            },
            title: m.literary_title({}, o),
            hideHeading: true,
            href: `/${locale}/catalogue/literary`,
            labelLanguage: (type) => pickText(read.release.types[type]?.labels ?? {}, locale).lang ?? undefined,
            descriptionLanguage: (type) =>
              pickText(read.release.types[type]?.descriptions ?? {}, locale).lang ?? undefined,
            control: (pointer, type) => initialFactControl(pointer, latest.current[type] ?? [], read, type, locale),
            fields: (type, disabled, canEdit) => (
              <InitialFacts
                type={type}
                read={read}
                locale={locale}
                disabled={disabled}
                canEdit={canEdit}
                rows={drafts[type] ?? []}
                change={(rows) => setDrafts((previous) => ({ ...previous, [type]: rows }))}
              />
            ),
            prepare: (item: InitialSubject) => {
              return literaryInitialItem(
                creationMetadata.current!.value.release,
                item,
                (latest.current[item.type] ?? []).map((row) => row.statement),
                locale,
              );
            },
          }}
        />
      </section>
    );
  // A previous successful subject read is never authority for the current public page.
  const admitted =
    !readingRefresh.pending && !query.isError && query.data?.ok && query.data.current?.public.subject.id === id
      ? query.data
      : undefined;
  const reload = () => {
    if (!id || !lifetime.active() || query.isFetching || readingRefresh.pending) return;
    const sequence = ++refreshSequence.current;
    const settle = () =>
      setRefresh((current) =>
        current.key === readingKey && current.sequence === sequence ? { ...current, pending: false } : current,
      );
    flushSync(() => setRefresh({ key: readingKey, sequence, pending: true }));
    try {
      void query.refetch().then(settle, settle);
    } catch {
      settle();
    }
  };
  return (
    <LiteraryCorrection
      read={admitted}
      locale={locale}
      session={session}
      facts={facts}
      review={review}
      relations={relations}
      authored={authored}
      heading={heading}
      failure={query.isError ? 'unavailable' : query.data && !query.data.ok ? query.data.reason : undefined}
      pending={query.isPending || readingRefresh.pending}
      fetching={query.isFetching || readingRefresh.pending}
      revision={JSON.stringify([id, readingRefresh.sequence])}
      reload={reload}
      observe={(next) => {
        if (lifetime.active())
          client.setQueryData<LiteraryRead>(
            queryKey,
            next.ok ? { ok: true, release: next.release, current: next } : next,
          );
      }}
    />
  );
}

/** Only the holders retain a previous reading, so drafts and sealed commands survive refusal. */
function LiteraryCorrection({
  read,
  locale,
  session,
  facts,
  review,
  relations,
  authored,
  heading,
  failure,
  pending,
  fetching,
  revision,
  reload,
  observe,
}: {
  read: Ready | undefined;
  locale: string;
  session: string;
  facts: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  relations: ReactNode;
  authored: ReactNode;
  heading: ReactNode;
  failure: Parameters<typeof EditorFailure>[0]['reason'] | undefined;
  pending: boolean;
  fetching: boolean;
  revision: string;
  reload: () => void;
  observe: (next: EditorRead) => void;
}) {
  const o = { locale: locale as never };
  const retained = useRef<Ready | undefined>(undefined);
  if (read) retained.current = read;
  const privateRead = retained.current;
  const [opened, setOpened] = useState({ relations: false, authored: false });
  const current = read?.current;
  const subject = current?.public.subject;
  const title = pickText(subject?.labels ?? {}, locale);
  const typeName = pickText(read?.release.types[subject?.type ?? '']?.labels ?? {}, locale);
  const href = subject ? subjectHref({ id: subject.id, label: title.text }, locale).href : '';
  const visible = !!current && session === 'signed-in';
  const lifetime = useEditorLifetime();
  const observation = useRef({ visible, token: {} });
  if (observation.current.visible !== visible) observation.current = { visible, token: {} };
  const token = observation.current.token;
  const canOpen = () => lifetime.active() && visible && observation.current.token === token;
  const privateFields = privateRead?.current
    ? literaryFields(privateRead.release, privateRead.current.public.subject.type, locale)
    : undefined;
  return (
    <CatalogueCurrentReading visible={visible} ready={visible} revision={revision}>
      <article className="mx-auto min-w-0 w-full max-w-4xl space-y-6 py-6">
        {heading}
        {pending && <p role="status">{m.candidate_loading({}, o)}</p>}
        {!current && !pending && <EditorFailure locale={locale} reason={failure ?? 'unavailable'} />}
        <Button variant="outline" className={touchAction} disabled={fetching} onClick={reload}>
          {m.correction_reload({}, o)}
        </Button>
        {subject && read && (
          <>
            <section
              aria-label={m.literary_identity({}, o)}
              className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
            >
              <h2 className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] font-sans text-2xl font-semibold">
                <a
                  lang={title.lang ?? undefined}
                  href={href}
                  className={`inline-flex min-h-8 min-w-0 items-center underline ${wrappingLink} ${keyboardFocus} [overflow-wrap:anywhere]`}
                >
                  {title.text || m.subject_value_unlabelled({}, o)}
                </a>
              </h2>
              <p
                className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere]"
                lang={typeName.lang ?? undefined}
              >
                {typeName.text || m.guide_missing({}, o)}
              </p>
              <p className="text-sm font-medium">{m.specialist_identity_scope({}, o)}</p>
              <p className="text-muted-foreground">{m.literary_intro({}, o)}</p>
              <p className="text-sm text-muted-foreground">{m.literary_grain({}, o)}</p>
              <a
                href={`${href}/terms`}
                className={buttonVariants({ variant: 'outline', className: `${wrappingLink} ${keyboardFocus}` })}
              >
                {m.catalogue_terms_title({}, o)}
              </a>
            </section>
            <nav className="flex min-w-0 flex-wrap gap-3">
              <a className={buttonVariants({ variant: 'outline', className: wrappingLink })} href={href}>
                {m.candidate_view_public({}, o)}
              </a>
              <a className={buttonVariants({ variant: 'outline', className: wrappingLink })} href={`${href}/changes`}>
                {m.changes_title({}, o)}
              </a>
            </nav>
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
            <details className="min-w-0 max-w-full whitespace-normal break-words [overflow-wrap:anywhere] space-y-3 rounded-xl border border-border p-4">
              <summary className="min-h-8 cursor-pointer whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 pointer-coarse:min-h-11">
                {m.specialist_identity_reference({}, o)}
              </summary>
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
              <p className="text-sm text-muted-foreground">{m.literary_terms_help({}, o)}</p>
            </details>
          </>
        )}
        {current && session !== 'signed-in' && (
          <EditorFailure locale={locale} reason={session === 'signed-out' ? 'denied' : 'unavailable'} />
        )}
        {session === 'signed-in' && privateRead?.current && (
          <>
            <section aria-label={visible ? m.literary_bibliography({}, o) : undefined} className="space-y-4">
              {visible && <h2 className="text-xl font-semibold">{m.literary_bibliography({}, o)}</h2>}
              <LiteraryFacts
                initial={privateRead.current}
                locale={locale}
                transport={facts}
                review={review}
                observe={observe}
              />
            </section>
            {!!privateFields?.relations.length && (
              <details
                onToggle={(event) => {
                  if (canOpen() && event.currentTarget.open)
                    setOpened((previous) => ({ ...previous, relations: true }));
                }}
                className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"
              >
                {visible && (
                  <>
                    <summary className={disclosureSummary}>{m.literary_relations({}, o)}</summary>
                    <p className="my-4 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {m.literary_relations_help({}, o)}
                    </p>
                  </>
                )}
                {opened.relations && relations}
              </details>
            )}
            {!!privateFields?.authored.length && (
              <details
                onToggle={(event) => {
                  if (canOpen() && event.currentTarget.open) setOpened((previous) => ({ ...previous, authored: true }));
                }}
                className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"
              >
                {visible && (
                  <>
                    <summary className={disclosureSummary}>{m.authored_title({}, o)}</summary>
                    <p className="my-4 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {m.literary_authored_help({}, o)}
                    </p>
                  </>
                )}
                {opened.authored && authored}
              </details>
            )}
          </>
        )}
      </article>
    </CatalogueCurrentReading>
  );
}

/** Scalar reloads observe the same subject authority as the page reload, without another read. */
function LiteraryFacts({
  observe,
  transport,
  ...props
}: {
  initial: EditorRead;
  locale: string;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  observe: (next: EditorRead) => void;
}) {
  const active = useCurrentReadingActive();
  return (
    <SubjectFacts
      {...props}
      transport={{
        ...transport,
        read: async () => {
          if (!active()) throw new Error('Retired catalogue editor');
          let next: EditorRead;
          try {
            next = await transport.read();
          } catch {
            next = { ok: false, reason: 'unavailable' };
          }
          if (!active()) throw new Error('Retired catalogue editor');
          observe(next);
          return next;
        },
      }}
    />
  );
}
