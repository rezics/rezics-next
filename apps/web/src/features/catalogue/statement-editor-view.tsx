import { catalogueEditor, useEditorLifetime } from './editor-lifetime';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import type { MouseEvent, ReactNode } from 'react';
import type { PropertyDefinition } from '@rezics/definitions';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { useId, useLayoutEffect, useRef, useState } from 'react';
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
import { CandidateValue, pageText } from '../pages/data';
import { isRecord } from '../pages/shared';
import { m } from '../../paraglide/messages.js';
import { DefinitionGuideLink } from './definition-guide-view';
import { DefinitionMeaning } from './definition-meaning';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { ContributionLifecycle } from './contribution-lifecycle-view';
import type { ContributionAddress, ContributionTransport } from './contribution-lifecycle';
import {
  correctionProperty,
  editableScalar,
  statementInput,
  validateStatement,
  type EditorRead,
  type EditorTransport,
  type ProposalCommand,
  type ProposalResult,
  type SnakInput,
  type StatementInput,
} from './statement-editor';
import { quantityUnitLabel, unitSymbols } from '../../subject/quantity-presentation';

import {
  controlId,
  presentStatementViolations,
  type ScalarFeedback,
  type ScalarField,
  type StatementFeedback,
} from './statement-validation-presentation';
import { statementDraftChanged } from './statement-editor-navigation';

type Current = Extract<EditorRead, { ok: true }>;
type ScalarRead = Pick<Current, 'release'> & { public: Pick<Current['public'], 'related'> };
type StatementRemovalKind = 'qualifier' | 'reference' | 'part';
/** Creation has no subject DTO or invented identity; controls need only its chosen Type and related summaries. */
export type StatementFieldsRead = ScalarRead & {
  source: Current['source'];
  public: ScalarRead['public'] & { subject: Pick<Current['public']['subject'], 'type'> };
};
const gregorian = 'http://www.wikidata.org/entity/Q1985727';

// Caller sizing keeps native controls usable on phones and coarse pointers, with dense fine-pointer desktops.
const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2 text-center md:pointer-fine:min-h-8 md:pointer-fine:py-1';
const inputClassName = 'min-w-0 min-h-11 md:pointer-fine:min-h-8';
// NativeSelect's className belongs to its wrapper; the target is the select itself.
const selectClassName = 'w-full min-w-0 max-w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8';
const labelClassName = 'min-w-0 max-w-full flex-wrap whitespace-normal [overflow-wrap:anywhere]';
const sectionClassName =
  'min-w-0 space-y-3 [overflow-wrap:anywhere] rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const headingClassName = 'min-w-0 text-lg font-semibold leading-snug [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal underline underline-offset-4 rounded-sm [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8';
// Scope the composed review/recovery controls here without changing the other review callers.
const reviewControlsClassName = [
  'min-w-0 space-y-4 [overflow-wrap:anywhere]',
  '[&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11',
  '[&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:py-2',
  'md:pointer-fine:[&_[data-slot=button]]:min-h-8 md:pointer-fine:[&_[data-slot=button]]:py-1',
  '[&_[data-slot=native-select-wrapper]]:w-full [&_[data-slot=native-select-wrapper]]:min-w-0',
  '[&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8 [&_label]:min-w-0 [&_label]:flex-wrap',
  '[&_label]:max-w-full [&_label]:whitespace-normal [&_label]:[overflow-wrap:anywhere]',
  '[&_[data-slot=button]]:[overflow-wrap:anywhere]',
  '[&_[role=status]_a]:inline-flex [&_[role=status]_a]:min-h-11 [&_[role=status]_a]:min-w-11',
  '[&_[role=status]_a]:max-w-full [&_[role=status]_a]:items-center md:pointer-fine:[&_[role=status]_a]:min-h-8',
].join(' ');

export { ScalarControl };

export function EditorFailure({ reason, locale }: { reason: string; locale: string }) {
  const o = { locale: locale as never };
  return (
    <p role="alert">
      {reason === 'denied'
        ? m.correction_denied({}, o)
        : reason === 'stale'
          ? m.correction_stale({}, o)
          : reason === 'invalid'
            ? m.correction_invalid({}, o)
            : m.correction_unavailable({}, o)}
    </p>
  );
}

export function StatementViolationLinks({
  feedback,
  locale,
  active,
}: {
  feedback: StatementFeedback;
  locale: string;
  active: () => boolean;
}) {
  if (!feedback.errors.length) return null;
  const o = { locale: locale as never };
  return (
    <ul className="list-disc space-y-2 ps-5 text-sm" aria-label={m.correction_errors({}, o)}>
      {feedback.errors.map((error) => (
        <li key={error.id} id={error.id}>
          <a
            className={`${linkClassName} font-medium`}
            href={`#${error.target}`}
            onClick={(event) => {
              event.preventDefault();
              if (!active()) return;
              const target = event.currentTarget.ownerDocument.getElementById(error.target);
              target?.focus();
              target?.scrollIntoView?.({ block: 'center' });
            }}
          >
            {error.label}
          </a>
          <p>{error.instruction}</p>
        </li>
      ))}
    </ul>
  );
}

function StatementEditorNavigation({ dirty, pending }: { dirty: boolean; pending: boolean }) {
  const lifetime = useEditorLifetime();
  useAuthoringDeparture(
    () => lifetime.active() && (dirty || pending),
    () => pending,
    JSON.stringify([dirty, pending]),
    undefined,
    lifetime.retire,
    undefined,
    {
      title: m.thread_authoring_discard_title(),
      unsaved: m.thread_authoring_discard_unsaved(),
      pending: m.thread_authoring_discard_pending(),
    },
  );
  return null;
}

/** A read-only part still participates in the submitted statement. It is never filtered away. */
export function PartValue({ part, read, locale }: { part: SnakInput; read: ScalarRead; locale: string }) {
  const definition = read.release.properties[part.property.id];
  if (!definition) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  return (
    <CandidateValue
      snak={{ property: { ...part.property, data_type: definition?.datatype ?? '' }, value: part.value }}
      related={read.public.related}
      locale={locale}
    />
  );
}

function ScalarControl({
  part,
  definition,
  read,
  locale,
  onChange,
  feedback,
}: {
  feedback?: ScalarFeedback | undefined;
  part: SnakInput;
  definition: PropertyDefinition | undefined;
  read: ScalarRead;
  locale: string;
  onChange: (value: SnakInput['value']) => void;
}) {
  const localId = useId();
  const id = (field: string) => controlId(feedback?.id ?? localId, feedback?.address ?? 'scalar', field);
  const invalid = (field: ScalarField) => {
    const compound = definition?.datatype === 'quantity' || definition?.datatype === 'monolingualtext';
    const errors =
      feedback?.errors.filter(
        (error) => error.target === id(field) || (compound && field !== 'state' && error.target === id('value')),
      ) ?? [];
    return {
      'aria-invalid': errors.length ? (true as const) : undefined,
      'aria-describedby': errors.length ? errors.map((error) => error.id).join(' ') : undefined,
    };
  };
  const control = (field: ScalarField) => ({ id: id(field), ...invalid(field) });
  const o = { locale: locale as never };
  const content = part.value.type === 'value' ? part.value.content : undefined;
  const record = isRecord(content) ? content : {};
  const schema = definition && isRecord(definition.value) ? definition.value : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const calendar = isRecord(properties.calendarmodel) ? properties.calendarmodel.const : undefined;
  // Unknown compound datatypes and unsupported calendar models remain intact and visible.
  if (!editableScalar(definition) || (definition?.datatype === 'time' && calendar !== gregorian))
    return (
      <div className="space-y-1 text-sm">
        <PartValue part={part} read={read} locale={locale} />
        <p className="text-muted-foreground">{m.correction_preserved({}, o)}</p>
      </div>
    );
  const field = (
    key: ScalarField | 'year' | 'month' | 'day',
    label: string,
    value: string,
    update: (value: string) => void,
    type = 'text',
  ) => (
    <Field className="min-w-0">
      <FieldLabel className={labelClassName} htmlFor={id(key)}>
        {label}
      </FieldLabel>
      <Input
        className={inputClassName}
        {...(key === 'year' || key === 'month' || key === 'day' ? { id: id(key), ...invalid('date') } : control(key))}
        aria-label={label}
        type={type}
        value={value}
        onChange={(event) => update(event.target.value)}
      />
    </Field>
  );
  const patch = (key: string, value: unknown) => {
    const next = { ...record, [key]: value };
    if (value === '') delete next[key];
    onChange({ type: 'value', content: next });
  };
  const date = typeof record.time === 'string' ? /^([+-]\d*)-(\d{2})-(\d{2})T00:00:00Z$/.exec(record.time) : null;
  const precision = typeof record.precision === 'number' ? record.precision : undefined;
  const setDate = (index: number, value: string, nextPrecision = precision) => {
    const parts = [date?.[1] ?? '', date?.[2] ?? '00', date?.[3] ?? '00'];
    parts[index] =
      index === 0 ? (value.startsWith('-') || value.startsWith('+') ? value : `+${value}`) : value.padStart(2, '0');
    if (nextPrecision === 9) {
      parts[1] = '00';
      parts[2] = '00';
    }
    if (nextPrecision === 10) parts[2] = '00';
    onChange({
      type: 'value',
      content: {
        ...record,
        time: `${parts.join('-')}T00:00:00Z`,
        ...(nextPrecision ? { precision: nextPrecision } : {}),
        calendarmodel: calendar,
      },
    });
  };
  const unitName = (id: string) =>
    id === '1' ? m.correction_unitless({}, o) : quantityUnitLabel(id, read.public.related, locale);
  const units = (
    definition.units?.includes('*') ? ['1', ...Object.keys(unitSymbols)] : (definition.units ?? [])
  ).filter((id) => !!unitName(id));
  return (
    <div
      id={id(definition.datatype === 'quantity' || definition.datatype === 'monolingualtext' ? 'value' : 'value-group')}
      role="group"
      aria-label={m.correction_value({}, o)}
      tabIndex={-1}
      {...invalid('value')}
      className="min-w-0 space-y-3"
    >
      <Field className="min-w-0">
        <FieldLabel className={labelClassName} htmlFor={id('state')}>
          {m.correction_value_state({}, o)}
        </FieldLabel>
        <NativeSelect
          className={selectClassName}
          {...control('state')}
          aria-label={m.correction_value_state({}, o)}
          value={part.value.type}
          onChange={(event) => {
            const type = event.target.value;
            if (type === 'somevalue' || type === 'novalue') onChange({ type });
            else
              onChange({
                type: 'value',
                content:
                  definition.datatype === 'monolingualtext' ||
                  definition.datatype === 'time' ||
                  definition.datatype === 'quantity'
                    ? {}
                    : '',
              });
          }}
        >
          <NativeSelectOption value="value">{m.correction_known({}, o)}</NativeSelectOption>
          <NativeSelectOption value="somevalue">{m.subject_value_unknown({}, o)}</NativeSelectOption>
          <NativeSelectOption value="novalue">{m.subject_value_none({}, o)}</NativeSelectOption>
        </NativeSelect>
      </Field>
      {part.value.type === 'value' &&
        (definition.datatype === 'quantity' ? (
          <>
            {field(
              'amount',
              m.correction_amount({}, o),
              typeof record.amount === 'string' ? record.amount : '',
              (value) => patch('amount', value),
            )}
            <Field className="min-w-0">
              <FieldLabel className={labelClassName} htmlFor={id('unit')}>
                {m.correction_unit({}, o)}
              </FieldLabel>
              <NativeSelect
                className={selectClassName}
                {...control('unit')}
                aria-label={m.correction_unit({}, o)}
                value={typeof record.unit === 'string' ? record.unit : ''}
                onChange={(event) => patch('unit', event.target.value)}
              >
                <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                {units.map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {unitName(id)}
                  </NativeSelectOption>
                ))}
                {typeof record.unit === 'string' && !units.includes(record.unit) && (
                  <NativeSelectOption value={record.unit}>
                    {unitName(record.unit) ?? m.quantity_unit_unavailable({}, o)}
                  </NativeSelectOption>
                )}
              </NativeSelect>
            </Field>
            {!isRecord(properties.lowerBound) && !isRecord(properties.upperBound) ? null : (
              <div className="grid gap-3 sm:grid-cols-2">
                {field(
                  'lowerBound',
                  m.correction_lower({}, o),
                  typeof record.lowerBound === 'string' ? record.lowerBound : '',
                  (value) => patch('lowerBound', value),
                )}
                {field(
                  'upperBound',
                  m.correction_upper({}, o),
                  typeof record.upperBound === 'string' ? record.upperBound : '',
                  (value) => patch('upperBound', value),
                )}
              </div>
            )}
          </>
        ) : definition.datatype === 'time' ? (
          <div
            id={id('date')}
            role="group"
            aria-labelledby={id('date-label')}
            tabIndex={-1}
            {...invalid('date')}
            className="space-y-3"
          >
            <p id={id('date-label')} className="font-medium">
              {m.correction_date({}, o)}
            </p>
            <Field className="min-w-0">
              <FieldLabel className={labelClassName} htmlFor={id('precision')}>
                {m.correction_precision({}, o)}
              </FieldLabel>
              <NativeSelect
                className={selectClassName}
                id={id('precision')}
                {...invalid('date')}
                aria-label={m.correction_precision({}, o)}
                value={precision ?? ''}
                onChange={(event) => setDate(0, date?.[1] ?? '', Number(event.target.value))}
              >
                <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                {[9, 10, 11]
                  .filter(
                    (value) =>
                      !isRecord(properties.precision) ||
                      !Array.isArray(properties.precision.enum) ||
                      properties.precision.enum.includes(value),
                  )
                  .map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {value === 9
                        ? m.correction_year({}, o)
                        : value === 10
                          ? m.correction_month({}, o)
                          : m.correction_day({}, o)}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              {field('year', m.correction_year({}, o), date?.[1]?.replace(/^\+/, '') ?? '', (value) =>
                setDate(0, value),
              )}
              {precision !== undefined &&
                precision >= 10 &&
                field(
                  'month',
                  m.correction_month({}, o),
                  date && date[2] !== '00' ? String(Number(date[2])) : '',
                  (value) => setDate(1, value),
                  'number',
                )}
              {precision === 11 &&
                field(
                  'day',
                  m.correction_day({}, o),
                  date && date[3] !== '00' ? String(Number(date[3])) : '',
                  (value) => setDate(2, value),
                  'number',
                )}
            </div>
            <p className="text-sm text-muted-foreground">{m.correction_calendar({}, o)}</p>
          </div>
        ) : definition.datatype === 'monolingualtext' ? (
          <>
            {field('text', m.correction_value({}, o), typeof record.text === 'string' ? record.text : '', (value) =>
              patch('text', value),
            )}
            {field(
              'language',
              m.correction_language({}, o),
              typeof record.language === 'string' ? record.language : '',
              (value) => patch('language', value),
            )}
          </>
        ) : (
          field(
            'value',
            definition.datatype === 'url' ? m.correction_url({}, o) : m.correction_value({}, o),
            typeof content === 'string' ? content : '',
            (value) => onChange({ type: 'value', content: value }),
            definition.datatype === 'url' ? 'url' : 'text',
          )
        ))}
    </div>
  );
}

function PartEditor({
  part,
  read,
  locale,
  onChange,
  control,
  feedback,
  removal,
  localKey,
}: {
  localKey: number;
  removal?: ReactNode;
  feedback?: ScalarFeedback | undefined;
  control?: ((part: SnakInput, change: (value: SnakInput['value']) => void) => ReactNode) | undefined;
  part: SnakInput;
  read: StatementFieldsRead;
  locale: string;
  onChange: (value: SnakInput['value']) => void;
}) {
  return (
    <ContentItemFrame
      as="div"
      data-statement-addition={localKey}
      className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-3 [overflow-wrap:anywhere] md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:items-start"
    >
      <p className="min-w-0 font-medium leading-snug">
        {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
          m.subject_value_unlabelled({}, { locale: locale as never })}
      </p>
      <div className="min-w-0 max-w-full">
        {control?.(part, onChange) ?? (
          <ScalarControl
            part={part}
            feedback={feedback}
            definition={read.release.properties[part.property.id]}
            read={read}
            locale={locale}
            onChange={onChange}
          />
        )}
        {removal}
      </div>
    </ContentItemFrame>
  );
}

function AddPart({
  ids,
  read,
  locale,
  label,
  onAdd,
  allowItems,
}: {
  allowItems?: boolean;
  ids: string[];
  read: StatementFieldsRead;
  locale: string;
  label: string;
  onAdd: (id: string, event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const selectId = useId();
  const [property, setProperty] = useState('');
  const choices = ids.flatMap((id) => {
    const definition = read.release.properties[id];
    const name = pageText(definition?.labels, locale).text;
    const supportedItem = allowItems && definition?.datatype === 'wikibase-item' && !!definition.targets?.length;
    return (supportedItem || editableScalar(definition)) && name ? [{ id, name }] : [];
  });
  if (!choices.length) return null;
  return (
    <div data-add-part className="flex min-w-0 flex-wrap items-end gap-3">
      <Field className="min-w-0 flex-1 basis-full sm:basis-48">
        <FieldLabel className={labelClassName} htmlFor={selectId}>
          {label}
        </FieldLabel>
        <NativeSelect
          className={selectClassName}
          id={selectId}
          aria-label={label}
          value={property}
          onChange={(event) => setProperty(event.target.value)}
        >
          <NativeSelectOption value="">{m.correction_choose({}, { locale: locale as never })}</NativeSelectOption>
          {choices.map(({ id, name }) => (
            <NativeSelectOption key={id} value={id}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button
        className={actionClassName}
        type="button"
        variant="outline"
        disabled={!property}
        onClick={(event) => {
          onAdd(property, event);
          setProperty('');
        }}
      >
        {m.correction_add({}, { locale: locale as never })}
      </Button>
    </div>
  );
}

/** Shared native scalar, qualifier and citation controls for single and multi-field proposals. */
export function StatementFields({
  draft,
  current,
  locale,
  change,
  guideReturn,
  heading: Heading = 'h2',
  valueControl,
  partControl,
  feedback,
}: {
  feedback?: StatementFeedback | undefined;
  draft: StatementInput;
  current: StatementFieldsRead;
  locale: string;
  change: (next: StatementInput) => void;
  guideReturn?: string | undefined;
  partControl?: (part: SnakInput, change: (value: SnakInput['value']) => void) => ReactNode;
  valueControl?: ReactNode;
  heading?: 'h2' | 'h4';
}) {
  const o = { locale: locale as never };
  const lifetime = useEditorLifetime();
  const additionFocus = useRef<{
    key: number;
    scope: HTMLElement;
    active: () => boolean;
    cancel: () => void;
  } | null>(null);
  useLayoutEffect(() => () => additionFocus.current?.cancel(), []);
  useLayoutEffect(() => {
    const intent = additionFocus.current;
    if (!intent) return;
    const admitted = lifetime.active() && intent.active();
    intent.cancel();
    if (!admitted) return;
    const group = intent.scope.querySelector<HTMLElement>(`[data-statement-addition="${intent.key}"]`);
    if (!group?.isConnected || group.closest('[hidden], [inert]')) return;
    // A scalar's state selector or custom picker is its first editing control. An empty
    // citation starts at its property chooser, falling back to its labelled fieldset.
    const target =
      [...group.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select, [role="combobox"]')].find(
        (control) => !control.matches(':disabled, [aria-disabled="true"]') && !control.closest('[hidden], [inert]'),
      ) ??
      group.querySelector<HTMLElement>('[role="group"][tabindex="-1"]') ??
      (group.tagName === 'FIELDSET' ? group : null);
    target?.focus();
  });
  const addReference = useRef<HTMLButtonElement>(null);
  const removalFocus = useRef<{ focus: () => void; isConnected: boolean } | null>(null);
  const cancelFocus = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    key: number;
    kind: StatementRemovalKind;
    trigger: HTMLButtonElement;
  } | null>(null);
  const pendingRemovalRef = useRef<typeof pendingRemoval>(null);
  useLayoutEffect(() => () => (pendingRemovalRef.current = null), []);
  useLayoutEffect(() => {
    const target = removalFocus.current;
    removalFocus.current = null;
    if (lifetime.active() && target?.isConnected) {
      pendingFocus.current = null;
      target.focus();
    } else if (pendingRemoval && pendingFocus.current !== pendingRemoval.key && pendingRemoval.trigger.isConnected) {
      pendingFocus.current = pendingRemoval.key;
      cancelFocus.current?.focus();
    } else if (!pendingRemoval) pendingFocus.current = null;
  });
  // UI identity and local provenance never become native statement fields. Existing parts,
  // including unsupported values, are protected even when definitions or values change.
  const [identities] = useState(() => new WeakMap<object, { key: number; added: boolean }>());
  const sequence = useRef(0);
  function identity(value: object, added = false) {
    let entry = identities.get(value);
    if (!entry) {
      entry = { key: sequence.current++, added };
      identities.set(value, entry);
    }
    return entry;
  }
  function holderExists(decision: NonNullable<typeof pendingRemoval>) {
    if (decision.kind === 'qualifier')
      return (draft.qualifiers ?? []).some((part) => identity(part).key === decision.key && identity(part).added);
    if (decision.kind === 'reference')
      return draft.references.some((reference) => identity(reference).key === decision.key && identity(reference).added);
    return draft.references.some((reference) =>
      reference.parts.some((part) => identity(part).key === decision.key && identity(part).added),
    );
  }
  useLayoutEffect(() => {
    const decision = pendingRemovalRef.current;
    if (!decision || holderExists(decision)) return;
    pendingRemovalRef.current = null;
    if (pendingRemoval === decision) setPendingRemoval(null);
  });
  function addition<T extends object>(value: T, event: MouseEvent<HTMLButtonElement>): T {
    const entry = identity(value, true);
    additionFocus.current?.cancel();
    const trigger = event.currentTarget;
    const document = trigger.ownerDocument;
    const scope = trigger.closest('section');
    if (
      event.detail !== 0 ||
      !lifetime.active() ||
      !trigger.isConnected ||
      trigger.matches(':disabled') ||
      document.activeElement !== trigger ||
      !scope
    )
      return value;
    const cancel = () => {
      document.removeEventListener('focusin', cancel);
      document.removeEventListener('pointerdown', cancel, true);
      additionFocus.current = null;
    };
    document.addEventListener('focusin', cancel);
    document.addEventListener('pointerdown', cancel, true);
    additionFocus.current = {
      key: entry.key,
      scope,
      active: () =>
        lifetime.active() &&
        trigger.isConnected &&
        (document.activeElement === trigger ||
          (trigger.matches(':disabled') && document.activeElement === document.body)),
      cancel,
    };
    return value;
  }
  function revision<T extends object>(previous: T, next: T): T {
    identities.set(next, identity(previous));
    return next;
  }
  function removalTarget(button: HTMLButtonElement, kind: StatementRemovalKind) {
    const scope = button.closest<HTMLElement>(kind === 'part' ? 'fieldset' : 'section');
    return kind === 'reference'
      ? addReference.current
      : ((scope?.querySelector('[data-add-part] select') as HTMLSelectElement | null) ?? scope);
  }
  function hasContent(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some(hasContent);
    if (value && typeof value === 'object') return Object.values(value).some(hasContent);
    return false;
  }
  function meaningful(part: SnakInput) {
    return part.value.type !== 'value' || hasContent(part.value.content);
  }
  function removeCurrent(
    key: number,
    button: HTMLButtonElement,
    kind: StatementRemovalKind,
    decision?: NonNullable<typeof pendingRemoval>,
  ) {
    if (!lifetime.active() || !button.isConnected || button.matches(':disabled')) return;
    if (decision && pendingRemovalRef.current !== decision) return;
    if (decision || pendingRemovalRef.current?.key === key) {
      pendingRemovalRef.current = null;
      setPendingRemoval(null);
    }
    let next: StatementInput | undefined;
    if (kind === 'qualifier') {
      const parts = draft.qualifiers ?? [];
      const index = parts.findIndex((part) => {
        const entry = identity(part);
        return entry.key === key && entry.added;
      });
      if (index >= 0) next = { ...draft, qualifiers: parts.filter((_, i) => i !== index) };
    } else if (kind === 'reference') {
      const index = draft.references.findIndex((reference) => {
        const entry = identity(reference);
        return entry.key === key && entry.added;
      });
      if (index >= 0) next = { ...draft, references: draft.references.filter((_, i) => i !== index) };
    } else {
      for (let referenceIndex = 0; referenceIndex < draft.references.length; referenceIndex++) {
        const reference = draft.references[referenceIndex]!;
        const partIndex = reference.parts.findIndex((part) => {
          const entry = identity(part);
          return entry.key === key && entry.added;
        });
        if (partIndex < 0) continue;
        next = {
          ...draft,
          references: draft.references.map((item, i) =>
            i === referenceIndex ? revision(item, { parts: item.parts.filter((_, n) => n !== partIndex) }) : item,
          ),
        };
        break;
      }
    }
    if (!next) return;
    // Wait for removal to re-enable Add reference when the draft was at its group limit.
    // Stable keys keep surviving custom controls and unfinished selections mounted.
    removalFocus.current = removalTarget(button, kind) ?? null;
    change(next);
  }
  function remove(button: HTMLButtonElement, holder: object, kind: StatementRemovalKind) {
    if (!lifetime.active() || button.matches(':disabled')) return;
    const entry = identity(holder);
    if (!entry.added) return;
    const requiresChoice =
      kind === 'reference'
        ? (holder as { parts: SnakInput[] }).parts.some(meaningful)
        : meaningful(holder as SnakInput);
    if (requiresChoice) {
      const decision = { key: entry.key, kind, trigger: button };
      pendingRemovalRef.current = decision;
      setPendingRemoval(decision);
    } else removeCurrent(entry.key, button, kind);
  }
  function cancelRemoval(decision: NonNullable<typeof pendingRemoval>) {
    if (pendingRemovalRef.current !== decision) return;
    pendingRemovalRef.current = null;
    setPendingRemoval(null);
    if (lifetime.active() && decision.trigger.isConnected && !decision.trigger.matches(':disabled'))
      decision.trigger.focus();
  }
  function choice(key: number, kind: StatementRemovalKind) {
    const decision = pendingRemoval;
    if (decision?.key !== key || decision.kind !== kind) return null;
    const action =
      kind === 'qualifier'
        ? m.correction_remove_qualifier({}, o)
        : kind === 'reference'
          ? m.correction_remove_reference({}, o)
          : m.correction_remove_reference_part({}, o);
    const title = m.candidate_confirm_title({ action }, o);
    return (
      <div
        role="group"
        aria-label={title}
        className="mt-2 min-w-0 space-y-2 rounded-md border border-border p-3 [overflow-wrap:anywhere]"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          cancelRemoval(decision);
        }}
      >
        <p>{title}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            ref={cancelFocus}
            className={actionClassName}
            type="button"
            variant="outline"
            onClick={() => cancelRemoval(decision)}
          >
            {m.candidate_cancel({}, o)}
          </Button>
          <Button
            className={actionClassName}
            type="button"
            variant="destructive"
            onClick={() => removeCurrent(key, decision.trigger, kind, decision)}
          >
            {m.contribution_confirm({}, o)}
          </Button>
        </div>
      </div>
    );
  }
  const definition = current.release.properties[draft.property.id];
  const section = (name: string) => ({ id: feedback ? `${feedback.id}-${name}` : undefined, tabIndex: -1 });
  const scalarFeedback = (address: string) => (feedback ? { ...feedback, address } : undefined);
  return (
    <>
      <section {...section('fact')} className={sectionClassName}>
        <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
          <ContentItemHeading level={Heading === 'h4' ? 4 : 2} className={headingClassName}>
            {m.correction_replacement({}, o)}
          </ContentItemHeading>
          <p className="min-w-0 font-medium">
            {pageText(definition?.labels, locale).text || m.subject_value_unlabelled({}, o)}
          </p>
          <DefinitionGuideLink
            locale={locale}
            field
            address={{
              type: current.public.subject.type,
              property: draft.property.id,
              release: current.source?.rezics.release,
              returnTo: guideReturn,
            }}
          />
          <p className="text-sm text-muted-foreground">
            <DefinitionMeaning values={definition?.descriptions} locale={locale} />
          </p>
          {valueControl ?? (
            <ScalarControl
              part={draft}
              feedback={scalarFeedback('fact')}
              definition={definition}
              read={current}
              locale={locale}
              onChange={(value) => change({ ...draft, value })}
            />
          )}
          <p className="text-sm text-muted-foreground">
            {definition?.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
          </p>
        </ContentItemFrame>
      </section>
      <section {...section('qualifiers')} className={sectionClassName}>
        <ContentItemHeading level={Heading === 'h4' ? 4 : 2} className={headingClassName}>
          {m.correction_qualifiers({}, o)}
        </ContentItemHeading>
        {(draft.qualifiers ?? []).map((part, index) => (
          <PartEditor
            localKey={identity(part).key}
            control={partControl}
            feedback={scalarFeedback(`qualifier-${index}`)}
            key={identity(part).key}
            part={part}
            read={current}
            locale={locale}
            removal={
              identity(part).added && (
                <>
                  <Button
                    className={actionClassName}
                    type="button"
                    variant="ghost"
                    onClick={(event) => remove(event.currentTarget, part, 'qualifier')}
                  >
                    {m.correction_remove_qualifier({}, o)}
                  </Button>
                  {choice(identity(part).key, 'qualifier')}
                </>
              )
            }
            onChange={(value) =>
              change({
                ...draft,
                qualifiers: draft.qualifiers!.map((item, i) =>
                  i === index ? revision(item, { ...item, value }) : item,
                ),
              })
            }
          />
        ))}
        <AddPart
          allowItems={!!partControl}
          ids={definition?.qualifiers ?? []}
          read={current}
          locale={locale}
          label={m.correction_add_qualifier({}, o)}
          onAdd={(id, event) =>
            change({
              ...draft,
              qualifiers: [
                ...(draft.qualifiers ?? []),
                addition({ property: { id }, value: { type: 'value', content: '' } }, event),
              ],
            })
          }
        />
      </section>
      <section {...section('references')} className={`${sectionClassName} space-y-4`}>
        <ContentItemHeading level={Heading === 'h4' ? 4 : 2} className={headingClassName}>
          {m.correction_references({}, o)}
        </ContentItemHeading>
        <p className="text-sm text-muted-foreground">{m.correction_citation_hint({}, o)}</p>
        {draft.references.map((reference, index) => (
          <fieldset
            key={identity(reference).key}
            data-statement-addition={identity(reference).key}
            tabIndex={-1}
            className={`${sectionClassName} border border-border bg-card p-4`}
          >
            <legend className="max-w-full whitespace-normal px-1 text-sm font-medium [overflow-wrap:anywhere]">
              {m.correction_references({}, o)} {index + 1}
            </legend>
            {reference.parts.map((part, partIndex) => (
              <PartEditor
                localKey={identity(part).key}
                control={partControl}
                feedback={scalarFeedback(`reference-${index}-part-${partIndex}`)}
                key={identity(part).key}
                part={part}
                read={current}
                locale={locale}
                removal={
                  identity(part).added && (
                    <>
                      <Button
                        className={actionClassName}
                        type="button"
                        variant="ghost"
                        onClick={(event) => remove(event.currentTarget, part, 'part')}
                      >
                        {m.correction_remove_reference_part({}, o)}
                      </Button>
                      {choice(identity(part).key, 'part')}
                    </>
                  )
                }
                onChange={(value) =>
                  change({
                    ...draft,
                    references: draft.references.map((item, i) =>
                      i !== index
                        ? item
                        : revision(item, {
                            parts: item.parts.map((snak, n) =>
                              n === partIndex ? revision(snak, { ...snak, value }) : snak,
                            ),
                          }),
                    ),
                  })
                }
              />
            ))}
            <AddPart
              allowItems={!!partControl}
              ids={Object.keys(current.release.properties)}
              read={current}
              locale={locale}
              label={m.correction_add_part({}, o)}
              onAdd={(id, event) =>
                change({
                  ...draft,
                  references: draft.references.map((item, i) =>
                    i !== index
                      ? item
                      : revision(item, {
                          parts: [
                            ...item.parts,
                            addition({ property: { id }, value: { type: 'value', content: '' } }, event),
                          ],
                        }),
                  ),
                })
              }
            />
            {identity(reference).added && (
              <>
                <Button
                  className={actionClassName}
                  type="button"
                  variant="ghost"
                  onClick={(event) => remove(event.currentTarget, reference, 'reference')}
                >
                  {m.correction_remove_reference({}, o)}
                </Button>
                {choice(identity(reference).key, 'reference')}
              </>
            )}
          </fieldset>
        ))}
        <Button
          ref={addReference}
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={draft.references.length >= 16}
          onClick={(event) => change({ ...draft, references: [...draft.references, addition({ parts: [] }, event)] })}
        >
          {m.correction_add_reference({}, o)}
        </Button>
      </section>
    </>
  );
}

export const StatementEditor = catalogueEditor(StatementEditorWorkspace);

function StatementEditorWorkspace(props: Parameters<typeof StatementEditorLive>[0]) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <StatementEditorLive {...props} />
    </AuthoringDepartureBoundary>
  );
}

function StatementEditorLive({
  initial,
  locale,
  transport,
  review,
  lifecycle,
  onLifecycleClear,
}: {
  initial: EditorRead;
  locale: string;
  transport: EditorTransport;
  review: (session: string | undefined) => CandidateTransport;
  lifecycle?: ContributionTransport;
  onLifecycleClear?: () => void | Promise<void>;
}) {
  const mount = useEditorLifetime();
  const o = { locale: locale as never };
  const feedbackId = useId();
  const [read, setRead] = useState(initial);
  const [baseline, setBaseline] = useState<StatementInput | null>(() =>
    initial.ok && initial.source ? statementInput(initial.source) : null,
  );
  const [draft, setDraft] = useState<StatementInput | null>(() =>
    initial.ok && initial.source ? statementInput(initial.source) : null,
  );
  const [failure, setFailure] = useState<Extract<ProposalResult, { ok: false }> | null>(null);
  const [result, setResult] = useState<Extract<ProposalResult, { ok: true }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [submitted, setSubmitted] = useState<{ address: ContributionAddress; href?: string }>();
  const [cleared, setCleared] = useState(false);
  const pending = useRef<ProposalCommand | null>(null);
  const running = useRef(false);
  const draftRevision = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const recovery = useRef<HTMLDivElement>(null);
  const address = useRef(initial.ok ? initial : undefined);
  const reloadIntent = useRef<{ opener: HTMLButtonElement; completed: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    const cancel = (event: Event) => {
      const intent = reloadIntent.current;
      if (
        intent &&
        (event.type === 'pointerdown' ||
          (event.target !== intent.opener &&
            event.target !== document.body &&
            event.target !== document.documentElement))
      )
        reloadIntent.current = undefined;
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
    };
  }, []);
  useLayoutEffect(() => {
    const intent = reloadIntent.current;
    if (!intent?.completed || busy) return;
    reloadIntent.current = undefined;
    if (!mount.active()) return;
    const active = document.activeElement;
    if (intent.opener.isConnected && active === intent.opener) return;
    if (active && active !== document.body && active !== document.documentElement) return;
    (read.ok ? heading.current : recovery.current)?.focus();
  }, [busy, read, mount]);
  const lifetime = useCatalogueLifetime(JSON.stringify([draftRevision.current, draft?.property.id]), mount);
  const current = read.ok ? read : undefined;
  const subject = current?.public.subject;
  const label = subject ? pageText(subject.labels, locale).text : '';
  const href = subject ? subjectHref({ id: subject.id, label }, locale).href : undefined;
  const definition = draft && current ? current.release.properties[draft.property.id] : undefined;
  const feedback: StatementFeedback = {
    id: feedbackId,
    errors:
      draft && current
        ? presentStatementViolations(failure?.errors ?? [], draft, current.release, locale, feedbackId)
        : [],
  };
  const dirty = !result && statementDraftChanged(baseline, draft);
  const guideReturn =
    href && draft
      ? `${href}/edit?${new URLSearchParams({ property: draft.property.id, ...(current?.source ? { statement: current.source.id } : {}) })}`
      : undefined;
  const change = (next: StatementInput) => {
    if (!lifetime.active() || !current) return;
    if (!pending.current) {
      lifetime.retire();
      draftRevision.current++;
      running.current = false;
      setBusy(false);
      setDraft(next);
      setFailure(null);
    }
  };
  function matching(next: EditorRead): EditorRead {
    if (!next.ok) return next;
    const original = address.current;
    const subject = next.public?.subject;
    if (
      !subject ||
      !subject.labels ||
      !subject.statements ||
      !next.public.related ||
      !next.release?.types ||
      !next.release.properties ||
      !next.release.types[subject.type]
    )
      return { ok: false, reason: 'unavailable' };
    if (
      original &&
      (subject.id !== original.public.subject.id ||
        subject.type !== original.public.subject.type ||
        next.source?.id !== original.source?.id ||
        next.source?.property.id !== original.source?.property.id)
    )
      return { ok: false, reason: 'stale' };
    if (next.source) {
      if (!correctionProperty(next.release, subject.type, next.source.property.id))
        return { ok: false, reason: 'invalid' };
      if (validateStatement(statementInput(next.source)).length) return { ok: false, reason: 'unavailable' };
    }
    return next;
  }
  async function reload(event: MouseEvent<HTMLButtonElement>) {
    if (!lifetime.active() || running.current || pending.current || result) return;
    reloadIntent.current =
      event.detail === 0 && event.currentTarget === document.activeElement && event.currentTarget.isConnected
        ? { opener: event.currentTarget, completed: false }
        : undefined;
    // Retire callbacks synchronously; the holder and its native command remain independent of this read.
    lifetime.retire();
    const revision = ++draftRevision.current;
    running.current = true;
    setRead({ ok: false, reason: 'unavailable' });
    setFailure(null);
    setBusy(true);
    const active = () => mount.active() && draftRevision.current === revision;
    try {
      const next = matching(await transport.read());
      if (!active()) return;
      setRead(next);
      if (next.ok) {
        address.current ??= next;
        if (!draft && next.source) {
          const nextDraft = statementInput(next.source);
          setBaseline(nextDraft);
          setDraft(nextDraft);
        }
      }
    } catch {
      if (!active()) return;
      setRead({ ok: false, reason: 'unavailable' });
    } finally {
      if (!active()) return;
      if (reloadIntent.current) reloadIntent.current.completed = true;
      running.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (!lifetime.active()) return;
    if (!draft || !subject || running.current) return;
    if (!pending.current) {
      const errors = validateStatement(draft, current?.release);
      if (errors.length) {
        setFailure({ ok: false, reason: 'invalid', errors });
        return;
      }
      pending.current = { id: subject.id, statement: structuredClone(draft), key: crypto.randomUUID() };
    }
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const next = await transport.propose(pending.current);
      if (!lifetime.active()) return;
      if (next.ok) {
        setResult(next);
        setSubmitted({
          address: {
            id: pending.current.id,
            property: pending.current.statement.property.id,
            candidate: next.candidate,
            ...(next.session ? { session: next.session } : {}),
          },
          ...(href ? { href } : {}),
        });
        pending.current = null;
      } else {
        setFailure(next);
        if (next.reason !== 'unavailable') pending.current = null;
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
  return (
    <article
      className="mx-auto min-w-0 w-full max-w-4xl space-y-6 p-4 [overflow-wrap:anywhere] [&_[tabindex='-1']:focus]:outline-2 [&_[tabindex='-1']:focus]:outline-offset-2 [&_[tabindex='-1']:focus]:outline-ring sm:p-6"
      aria-busy={busy}
    >
      <StatementEditorNavigation dirty={dirty} pending={pending.current !== null} />
      <header className="space-y-2">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">
          {m.correction_title({}, o)}
        </h1>
        {subject && (
          <p>
            <a className={linkClassName} href={href}>
              {label || m.subject_value_unlabelled({}, o)}
            </a>
            <span className="ms-2 text-muted-foreground">
              {pageText(current?.release.types[subject.type]?.labels, locale).text}
            </span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{m.correction_intro({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.correction_global({}, o)}</p>
        {subject && <DefinitionGuideLink locale={locale} address={{ type: subject.type, returnTo: guideReturn }} />}
      </header>
      {!read.ok && !result && !busy && (
        <div ref={recovery} tabIndex={-1}>
          <EditorFailure reason={read.reason} locale={locale} />
        </div>
      )}
      {failure && (
        <div className="space-y-3 rounded-lg border border-destructive/50 p-4">
          <EditorFailure reason={failure.reason} locale={locale} />
          <StatementViolationLinks feedback={feedback} locale={locale} active={() => lifetime.active()} />
        </div>
      )}
      {busy && <p role="status">{m.correction_saving({}, o)}</p>}
      {result ? (
        <section className={reviewControlsClassName}>
          {!cleared && <p role="status">{m.correction_proposed({}, o)}</p>}
          <div className="flex flex-wrap gap-3">
            {!cleared && (
              <Button className={actionClassName} type="button" onClick={() => lifetime.active() && setReviewing(true)}>
                {m.correction_review({}, o)}
              </Button>
            )}
            {submitted?.href && (
              <a className={buttonVariants({ variant: 'outline', className: actionClassName })} href={submitted.href}>
                {m.candidate_view_public({}, o)}
              </a>
            )}
          </div>
          {lifecycle && submitted && (
            <ContributionLifecycle
              address={submitted.address}
              locale={locale}
              transport={lifecycle}
              onClear={async () => {
                if (!lifetime.active()) return;
                setCleared(true);
                setReviewing(false);
                setDraft(null);
                setRead({ ok: false, reason: 'unavailable' });
                setFailure(null);
                pending.current = null;
                await onLifecycleClear?.();
                if (!lifetime.active()) return;
              }}
            />
          )}
          {!cleared && reviewing && draft && subject && (
            <CandidateReview
              id={subject.id}
              locale={locale}
              initialProperty={draft.property.id}
              exactCandidate={result.candidate}
              transport={review(result.session)}
            />
          )}
        </section>
      ) : draft && current ? (
        <form
          ref={form}
          id={`${feedbackId}-fields`}
          tabIndex={-1}
          aria-label={m.correction_title({}, o)}
          className="min-w-0 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {current.source && (
            <section className="min-w-0 [overflow-wrap:anywhere]">
              <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/30 p-4">
                <ContentItemHeading level={2} className={headingClassName}>
                  {m.candidate_current({}, o)} · {pageText(definition?.labels, locale).text}
                </ContentItemHeading>
                <PartValue part={current.source} read={current} locale={locale} />
                {current.source.qualifiers.map((part, index) => (
                  <div key={index} className="grid min-w-0 gap-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-3">
                    <span className="text-sm text-muted-foreground">
                      {pageText(current.release.properties[part.property.id]?.labels, locale).text ||
                        m.subject_value_unlabelled({}, o)}
                      :{' '}
                    </span>
                    <div className="min-w-0">
                      <PartValue part={part} read={current} locale={locale} />
                    </div>
                  </div>
                ))}
                {current.source.references.map((reference, index) => (
                  <div key={index} className="min-w-0 space-y-2 border-s-2 border-border ps-3">
                    {reference.parts.map((part, partIndex) => (
                      <div
                        key={partIndex}
                        className="grid min-w-0 gap-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-3"
                      >
                        <span className="min-w-0 text-sm text-muted-foreground">
                          {pageText(current.release.properties[part.property.id]?.labels, locale).text ||
                            m.subject_value_unlabelled({}, o)}
                        </span>
                        <div className="min-w-0">
                          <PartValue part={part} read={current} locale={locale} />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </ContentItemFrame>
            </section>
          )}
          <fieldset disabled={busy || !!pending.current} className="min-w-0 space-y-6">
            <StatementFields
              draft={draft}
              current={current}
              locale={locale}
              change={change}
              guideReturn={guideReturn}
              feedback={feedback}
            />
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button className={actionClassName} type="submit" disabled={busy}>
              {pending.current ? m.correction_retry({}, o) : m.correction_submit({}, o)}
            </Button>
            {!pending.current && (
              <Button
                className={actionClassName}
                type="button"
                variant="outline"
                disabled={busy}
                onClick={(event) => void reload(event)}
              >
                {m.correction_reload({}, o)}
              </Button>
            )}
            {href && (
              <a className={buttonVariants({ variant: 'ghost', className: actionClassName })} href={`${href}/details`}>
                {m.correction_back({}, o)}
              </a>
            )}
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          {draft ? (
            <section className="min-w-0 space-y-3 rounded-xl bg-card p-4">
              <h2 className={headingClassName}>{m.facts_private({}, o)}</h2>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(draft, null, 2)}
              </pre>
            </section>
          ) : (
            <p>{m.correction_empty({}, o)}</p>
          )}
          {href && (
            <a className={linkClassName} href={`${href}/details`}>
              {m.correction_back({}, o)}
            </a>
          )}
          <Button
            className={actionClassName}
            type="button"
            variant="outline"
            disabled={busy}
            onClick={(event) => void reload(event)}
          >
            {m.correction_reload({}, o)}
          </Button>
        </div>
      )}
    </article>
  );
}
