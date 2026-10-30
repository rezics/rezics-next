import type { PropertyDefinition } from '@rezics/definitions';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { useRef, useState } from 'react';
import { CandidateValue, pageText } from '../pages/data';
import { isRecord } from '../pages/shared';
import { m } from '../../paraglide/messages.js';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { subjectHref } from '../../subject/subject-href';
import { ContributionLifecycle } from './contribution-lifecycle-view';
import type { ContributionAddress, ContributionTransport } from './contribution-lifecycle';
import {
  editableScalar,
  statementInput,
  unitSymbols,
  validateStatement,
  type EditorRead,
  type EditorTransport,
  type ProposalCommand,
  type ProposalResult,
  type SnakInput,
  type StatementInput,
} from './statement-editor';

type Current = Extract<EditorRead, { ok: true }>;
const gregorian = 'http://www.wikidata.org/entity/Q1985727';

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
function PartValue({ part, read, locale }: { part: SnakInput; read: Current; locale: string }) {
  const definition = read.release.properties[part.property.id];
  if (!definition) return <span>{m.candidate_value_unavailable({}, { locale: locale as never })}</span>;
  const content = part.value.type === 'value' && isRecord(part.value.content) ? part.value.content : undefined;
  const unit = typeof content?.unit === 'string' ? content.unit : '';
  const symbol = unitSymbols[unit];
  const related = symbol
    ? { ...read.public.related, [unit]: { labels: { en: symbol } } as Current['public']['related'][string] }
    : read.public.related;
  return (
    <CandidateValue
      snak={{ property: { ...part.property, data_type: definition?.datatype ?? '' }, value: part.value }}
      related={related}
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
}: {
  part: SnakInput;
  definition: PropertyDefinition | undefined;
  read: Current;
  locale: string;
  onChange: (value: SnakInput['value']) => void;
}) {
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
  const field = (label: string, value: string, update: (value: string) => void, type = 'text') => (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input aria-label={label} type={type} value={value} onChange={(event) => update(event.target.value)} />
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
    id === '1'
      ? m.correction_unitless({}, o)
      : (unitSymbols[id] ?? pageText(read.public.related[id]?.labels, locale).text);
  const units = (
    definition.units?.includes('*') ? ['1', ...Object.keys(unitSymbols)] : (definition.units ?? [])
  ).filter((id) => !!unitName(id));
  return (
    <div className="space-y-3">
      <Field>
        <FieldLabel>{m.correction_value_state({}, o)}</FieldLabel>
        <NativeSelect
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
            {field(m.correction_amount({}, o), typeof record.amount === 'string' ? record.amount : '', (value) =>
              patch('amount', value),
            )}
            <Field>
              <FieldLabel>{m.correction_unit({}, o)}</FieldLabel>
              <NativeSelect
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
                  <NativeSelectOption value={record.unit}>{m.correction_unit_preserved({}, o)}</NativeSelectOption>
                )}
              </NativeSelect>
            </Field>
            {!isRecord(properties.lowerBound) && !isRecord(properties.upperBound) ? null : (
              <div className="grid gap-3 sm:grid-cols-2">
                {field(
                  m.correction_lower({}, o),
                  typeof record.lowerBound === 'string' ? record.lowerBound : '',
                  (value) => patch('lowerBound', value),
                )}
                {field(
                  m.correction_upper({}, o),
                  typeof record.upperBound === 'string' ? record.upperBound : '',
                  (value) => patch('upperBound', value),
                )}
              </div>
            )}
          </>
        ) : definition.datatype === 'time' ? (
          <>
            <Field>
              <FieldLabel>{m.correction_precision({}, o)}</FieldLabel>
              <NativeSelect
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
              {field(m.correction_year({}, o), date?.[1]?.replace(/^\+/, '') ?? '', (value) => setDate(0, value))}
              {precision !== undefined &&
                precision >= 10 &&
                field(
                  m.correction_month({}, o),
                  date?.[2] === '00' ? '' : (date?.[2] ?? ''),
                  (value) => setDate(1, value),
                  'number',
                )}
              {precision === 11 &&
                field(
                  m.correction_day({}, o),
                  date?.[3] === '00' ? '' : (date?.[3] ?? ''),
                  (value) => setDate(2, value),
                  'number',
                )}
            </div>
            <p className="text-sm text-muted-foreground">{m.correction_calendar({}, o)}</p>
          </>
        ) : definition.datatype === 'monolingualtext' ? (
          <>
            {field(m.correction_value({}, o), typeof record.text === 'string' ? record.text : '', (value) =>
              patch('text', value),
            )}
            {field(m.correction_language({}, o), typeof record.language === 'string' ? record.language : '', (value) =>
              patch('language', value),
            )}
          </>
        ) : (
          field(
            m.correction_value({}, o),
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
}: {
  part: SnakInput;
  read: Current;
  locale: string;
  onChange: (value: SnakInput['value']) => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="font-medium">
        {pageText(read.release.properties[part.property.id]?.labels, locale).text ||
          m.subject_value_unlabelled({}, { locale: locale as never })}
      </p>
      <ScalarControl
        part={part}
        definition={read.release.properties[part.property.id]}
        read={read}
        locale={locale}
        onChange={onChange}
      />
    </div>
  );
}

function AddPart({
  ids,
  read,
  locale,
  label,
  onAdd,
}: {
  ids: string[];
  read: Current;
  locale: string;
  label: string;
  onAdd: (id: string) => void;
}) {
  const [property, setProperty] = useState('');
  const choices = ids.flatMap((id) => {
    const definition = read.release.properties[id];
    const name = pageText(definition?.labels, locale).text;
    return editableScalar(definition) && name ? [{ id, name }] : [];
  });
  if (!choices.length) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field className="min-w-0 flex-1">
        <FieldLabel>{label}</FieldLabel>
        <NativeSelect aria-label={label} value={property} onChange={(event) => setProperty(event.target.value)}>
          <NativeSelectOption value="">{m.correction_choose({}, { locale: locale as never })}</NativeSelectOption>
          {choices.map(({ id, name }) => (
            <NativeSelectOption key={id} value={id}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button
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
    <article className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6" aria-busy={busy}>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{m.correction_title({}, o)}</h1>
        {subject && (
          <p>
            <a className="underline underline-offset-4" href={href}>
              {label || m.subject_value_unlabelled({}, o)}
            </a>
            <span className="ms-2 text-muted-foreground">
              {pageText(current?.release.types[subject.type]?.labels, locale).text}
            </span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{m.correction_intro({}, o)}</p>
        <p className="text-sm text-muted-foreground">{m.correction_global({}, o)}</p>
      </header>
      {!read.ok && !result && <EditorFailure reason={read.reason} locale={locale} />}
      {failure && (
        <div className="space-y-3 rounded-lg border border-destructive/50 p-4">
          <EditorFailure reason={failure.reason} locale={locale} />
          {!!failure.errors?.length && (
            <ul className="list-disc space-y-1 ps-5 text-sm">
              {failure.errors.map((error, index) => (
                <li key={index}>
                  {m.correction_invalid_part({}, o)}{' '}
                  <span className="break-all">
                    {error.pointer.replaceAll(
                      /schema:[A-Za-z]+/g,
                      () => pageText(definition?.labels, locale).text || m.correction_value({}, o),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {busy && <p role="status">{m.correction_saving({}, o)}</p>}
      {result ? (
        <section className="space-y-4">
          {!cleared && <p role="status">{m.correction_proposed({}, o)}</p>}
          {!cleared && (
            <Button type="button" onClick={() => setReviewing(true)}>
              {m.correction_review({}, o)}
            </Button>
          )}
          {submitted?.href && (
            <a className={`${buttonVariants({ variant: 'outline' })} ms-2`} href={submitted.href}>
              {m.candidate_view_public({}, o)}
            </a>
          )}
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
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {current.source && (
            <section className="space-y-3 rounded-xl border border-border bg-muted/30 p-4">
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
          <fieldset disabled={busy || !!pending.current} className="space-y-6">
            <section className="space-y-3 rounded-xl border border-border bg-card p-4">
              <h2 className="font-semibold">{m.correction_replacement({}, o)}</h2>
              {definition?.descriptions && (
                <p className="text-sm text-muted-foreground">{pageText(definition.descriptions, locale).text}</p>
              )}
              <ScalarControl
                part={draft}
                definition={definition}
                read={current}
                locale={locale}
                onChange={(value) => change({ ...draft, value })}
              />
              <p className="text-sm text-muted-foreground">
                {definition?.multivalued ? m.correction_multiple({}, o) : m.correction_single({}, o)}
              </p>
            </section>
            <section className="space-y-3">
              <h2 className="font-semibold">{m.correction_qualifiers({}, o)}</h2>
              {(draft.qualifiers ?? []).map((part, index) => (
                <PartEditor
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
                ids={definition?.qualifiers ?? []}
                read={current}
                locale={locale}
                label={m.correction_add_qualifier({}, o)}
                onAdd={(id) =>
                  change({
                    ...draft,
                    qualifiers: [
                      ...(draft.qualifiers ?? []),
                      { property: { id }, value: { type: 'value', content: '' } },
                    ],
                  })
                }
              />
            </section>
            <section className="space-y-4">
              <h2 className="font-semibold">{m.correction_references({}, o)}</h2>
              <p className="text-sm text-muted-foreground">{m.correction_citation_hint({}, o)}</p>
              {draft.references.map((reference, index) => (
                <fieldset key={index} className="space-y-3 rounded-xl border border-border bg-card p-4">
                  <legend className="px-1 text-sm font-medium">
                    {m.correction_references({}, o)} {index + 1}
                  </legend>
                  {reference.parts.map((part, partIndex) => (
                    <PartEditor
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
                type="button"
                variant="outline"
                disabled={draft.references.length >= 16}
                onClick={() => change({ ...draft, references: [...draft.references, { parts: [] }] })}
              >
                {m.correction_add_reference({}, o)}
              </Button>
            </section>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy}>
              {pending.current ? m.correction_retry({}, o) : m.correction_submit({}, o)}
            </Button>
            {!pending.current && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
                {m.correction_reload({}, o)}
              </Button>
            )}
            {href && (
              <a className={buttonVariants({ variant: 'ghost' })} href={`${href}/details`}>
                {m.correction_back({}, o)}
              </a>
            )}
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <p>{m.correction_empty({}, o)}</p>
          {href && (
            <a className="underline" href={`${href}/details`}>
              {m.correction_back({}, o)}
            </a>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={() => void reload()}>
            {m.correction_reload({}, o)}
          </Button>
        </div>
      )}
    </article>
  );
}
