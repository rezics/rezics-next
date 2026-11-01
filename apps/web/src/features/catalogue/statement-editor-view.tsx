import type { ReactNode } from 'react';
import type { PropertyDefinition } from '@rezics/definitions';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useId, useRef, useState } from 'react';
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

type Current = Extract<EditorRead, { ok: true }>;
type ScalarRead = Pick<Current, 'release'> & { public: Pick<Current['public'], 'related'> };
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
const labelClassName = 'min-w-0 max-w-full flex-wrap [overflow-wrap:anywhere]';
const linkClassName =
  'inline-flex min-h-11 min-w-11 max-w-full items-center underline underline-offset-4 md:pointer-fine:min-h-8';
// Scope the composed review/recovery controls here without changing the other review callers.
const reviewControlsClassName = [
  'min-w-0 space-y-4',
  '[&_[data-slot=button]]:h-auto [&_[data-slot=button]]:min-h-11 [&_[data-slot=button]]:min-w-11',
  '[&_[data-slot=button]]:max-w-full [&_[data-slot=button]]:whitespace-normal [&_[data-slot=button]]:py-2',
  'md:pointer-fine:[&_[data-slot=button]]:min-h-8 md:pointer-fine:[&_[data-slot=button]]:py-1',
  '[&_[data-slot=native-select-wrapper]]:w-full [&_[data-slot=native-select-wrapper]]:min-w-0',
  '[&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8 [&_label]:min-w-0 [&_label]:flex-wrap',
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
}: {
  feedback?: ScalarFeedback | undefined;
  control?: ((part: SnakInput, change: (value: SnakInput['value']) => void) => ReactNode) | undefined;
  part: SnakInput;
  read: StatementFieldsRead;
  locale: string;
  onChange: (value: SnakInput['value']) => void;
}) {
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <p className="font-medium">
        {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
          m.subject_value_unlabelled({}, { locale: locale as never })}
      </p>
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
    </div>
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
  onAdd: (id: string) => void;
}) {
  const [property, setProperty] = useState('');
  const choices = ids.flatMap((id) => {
    const definition = read.release.properties[id];
    const name = pageText(definition?.labels, locale).text;
    const supportedItem = allowItems && definition?.datatype === 'wikibase-item' && !!definition.targets?.length;
    return (supportedItem || editableScalar(definition)) && name ? [{ id, name }] : [];
  });
  if (!choices.length) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="min-w-0 flex-1 basis-full sm:basis-48">
        <FieldLabel className={labelClassName}>{label}</FieldLabel>
        <NativeSelect
          className={selectClassName}
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
        onClick={() => {
          onAdd(property);
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
  const definition = current.release.properties[draft.property.id];
  const section = (name: string) => ({ id: feedback ? `${feedback.id}-${name}` : undefined, tabIndex: -1 });
  const scalarFeedback = (address: string) => (feedback ? { ...feedback, address } : undefined);
  return (
    <>
      <section {...section('fact')} className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
        <Heading className="font-semibold">{m.correction_replacement({}, o)}</Heading>
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
      </section>
      <section {...section('qualifiers')} className="space-y-3">
        <Heading className="font-semibold">{m.correction_qualifiers({}, o)}</Heading>
        {(draft.qualifiers ?? []).map((part, index) => (
          <PartEditor
            control={partControl}
            feedback={scalarFeedback(`qualifier-${index}`)}
            key={index}
            part={part}
            read={current}
            locale={locale}
            onChange={(value) =>
              change({
                ...draft,
                qualifiers: draft.qualifiers!.map((item, i) => (i === index ? { ...item, value } : item)),
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
          onAdd={(id) =>
            change({
              ...draft,
              qualifiers: [...(draft.qualifiers ?? []), { property: { id }, value: { type: 'value', content: '' } }],
            })
          }
        />
      </section>
      <section {...section('references')} className="space-y-4">
        <Heading className="font-semibold">{m.correction_references({}, o)}</Heading>
        <p className="text-sm text-muted-foreground">{m.correction_citation_hint({}, o)}</p>
        {draft.references.map((reference, index) => (
          <fieldset key={index} className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
            <legend className="px-1 text-sm font-medium">
              {m.correction_references({}, o)} {index + 1}
            </legend>
            {reference.parts.map((part, partIndex) => (
              <PartEditor
                control={partControl}
                feedback={scalarFeedback(`reference-${index}-part-${partIndex}`)}
                key={partIndex}
                part={part}
                read={current}
                locale={locale}
                onChange={(value) =>
                  change({
                    ...draft,
                    references: draft.references.map((item, i) =>
                      i !== index
                        ? item
                        : { parts: item.parts.map((snak, n) => (n === partIndex ? { ...snak, value } : snak)) },
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
              onAdd={(id) =>
                change({
                  ...draft,
                  references: draft.references.map((item, i) =>
                    i !== index
                      ? item
                      : { parts: [...item.parts, { property: { id }, value: { type: 'value', content: '' } }] },
                  ),
                })
              }
            />
          </fieldset>
        ))}
        <Button
          className={actionClassName}
          type="button"
          variant="outline"
          disabled={draft.references.length >= 16}
          onClick={() => change({ ...draft, references: [...draft.references, { parts: [] }] })}
        >
          {m.correction_add_reference({}, o)}
        </Button>
      </section>
    </>
  );
}

export function StatementEditor({
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
  const o = { locale: locale as never };
  const feedbackId = useId();
  const [read, setRead] = useState(initial);
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
  const guideReturn =
    href && draft
      ? `${href}/edit?${new URLSearchParams({ property: draft.property.id, ...(current?.source ? { statement: current.source.id } : {}) })}`
      : undefined;
  const change = (next: StatementInput) => {
    if (!pending.current) {
      setDraft(next);
      setFailure(null);
    }
  };
  async function reload() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.read();
      if (next.ok) {
        setRead(next);
        if (!draft && next.source) setDraft(statementInput(next.source));
        setFailure(null);
      } else setFailure(next);
    } catch {
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function submit() {
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
      setFailure({ ok: false, reason: 'unavailable' });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="mx-auto min-w-0 w-full max-w-4xl space-y-6 p-4 [overflow-wrap:anywhere] sm:p-6" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.correction_title({}, o)}</h1>
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
      {!read.ok && !result && <EditorFailure reason={read.reason} locale={locale} />}
      {failure && (
        <div className="space-y-3 rounded-lg border border-destructive/50 p-4">
          <EditorFailure reason={failure.reason} locale={locale} />
          {!!feedback.errors.length && (
            <ul className="list-disc space-y-2 ps-5 text-sm" aria-label={m.correction_errors({}, o)}>
              {feedback.errors.map((error) => (
                <li key={error.id} id={error.id}>
                  <a
                    className={`${linkClassName} font-medium`}
                    href={`#${error.target}`}
                    onClick={(event) => {
                      event.preventDefault();
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
          )}
        </div>
      )}
      {busy && <p role="status">{m.correction_saving({}, o)}</p>}
      {result ? (
        <section className={reviewControlsClassName}>
          {!cleared && <p role="status">{m.correction_proposed({}, o)}</p>}
          <div className="flex flex-wrap gap-3">
            {!cleared && (
              <Button className={actionClassName} type="button" onClick={() => setReviewing(true)}>
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
                setCleared(true);
                setReviewing(false);
                setDraft(null);
                setRead({ ok: false, reason: 'unavailable' });
                setFailure(null);
                pending.current = null;
                await onLifecycleClear?.();
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
            <section className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/30 p-4">
              <h2 className="font-semibold">
                {m.candidate_current({}, o)} · {pageText(definition?.labels, locale).text}
              </h2>
              <PartValue part={current.source} read={current} locale={locale} />
              {current.source.qualifiers.map((part, index) => (
                <div key={index}>
                  <span className="text-sm text-muted-foreground">
                    {pageText(current.release.properties[part.property.id]?.labels, locale).text ||
                      m.subject_value_unlabelled({}, o)}
                    :{' '}
                  </span>
                  <PartValue part={part} read={current} locale={locale} />
                </div>
              ))}
              {current.source.references.map((reference, index) => (
                <div key={index} className="border-s-2 border-border ps-3">
                  {reference.parts.map((part, partIndex) => (
                    <div key={partIndex}>
                      <PartValue part={part} read={current} locale={locale} />
                    </div>
                  ))}
                </div>
              ))}
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
                onClick={() => void reload()}
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
          <p>{m.correction_empty({}, o)}</p>
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
            onClick={() => void reload()}
          >
            {m.correction_reload({}, o)}
          </Button>
        </div>
      )}
    </article>
  );
}
