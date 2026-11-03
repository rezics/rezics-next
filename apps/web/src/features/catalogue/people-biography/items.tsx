import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { coverSrc } from '../../../media/cover-src';
import { m } from '../../../paraglide/messages.js';
import { subjectHref } from '../../../subject/subject-href';
import { CandidateReview, type CandidateTransport } from '../../../subject/candidate-review';
import { pageText } from '../../pages/data';
import { useCurrentReadingActive, useCurrentReadingVisible } from '../editor-lifetime';
import { factChanged, factLocked, sealFacts, sendFacts, type FactDraft, type FactsCurrent, type FactsTransport } from '../subject-facts';
import { statementInput, type StatementInput } from '../statement-editor';
import { PartValue, StatementFields } from '../statement-editor-view';
import { peopleSelectedFact, peopleRelationHref, type PeopleBiographyField } from './index';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:min-w-0 md:pointer-fine:py-1';

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  if (value == null) return false;
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}

function populated(statement: StatementInput): boolean {
  const part = (item: { value: { type: string; content?: unknown } }) =>
    item.value.type !== 'value' || hasContent(item.value.content);
  return part(statement) || statement.qualifiers?.some(part) === true || statement.references.some((reference) => reference.parts.some(part));
}

/** Independently selected admitted occupation or language items; a stale choice must be reselected. */
export function PeopleSelectedItems({
  field,
  read,
  locale,
  search,
  transport,
  review,
  returnHref,
}: {
  field: PeopleBiographyField;
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  returnHref: string;
}) {
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const o = { locale: locale as never };
  const definition = read.release.properties[field.id];
  const admitted =
    field.editor === 'item' &&
    !!definition &&
    definition.datatype === 'wikibase-item' &&
    !!read.release.types[read.public.subject.type]?.properties.includes(field.id);
  const selected = read.public.subject.statements[field.id] ?? [];
  const chooser = useId();
  const [source, setSource] = useState('');
  const sourceChoice = peopleSelectedFact(source, field.facts) ? source : '';
  useLayoutEffect(() => {
    if (source && !selected.some((statement) => statement.id === source)) setSource('');
  }, [selected, source]);
  const [draft, setDraft] = useState<FactDraft>();
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const latest = useRef({ draft, admitted, active });
  latest.current = { draft, admitted, active };
  const label = admitted ? pageText(definition.labels, locale) : field.label;
  const usable = () => active() && latest.current.admitted === admitted;
  function stage(id: string | null) {
    if (!usable() || !admitted || (draft && factLocked(draft))) return;
    const selectedSource = id ? selected.find((statement) => statement.id === id) : undefined;
    if (id && !selectedSource) return;
    const baseline = selectedSource ? statementInput(selectedSource) : null;
    setPicked([]);
    setDraft({
      property: field.id,
      source: id,
      baseline,
      included: true,
      statement: baseline
        ? structuredClone(baseline)
        : { property: { id: field.id }, value: { type: 'value', content: '' }, qualifiers: [], references: [], rank: 'normal' },
    });
  }
  function change(statement: StatementInput) {
    if (!usable() || !admitted || !draft || factLocked(draft)) return false;
    setDraft({ ...draft, statement, command: undefined, result: undefined, submission: undefined });
    return true;
  }
  async function submit() {
    if (!usable() || !draft || running.current) return;
    const sealed = draft.command ? draft : sealFacts(read.public.subject.id, read.release, [draft])[0];
    if (!sealed) return;
    setDraft(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts([sealed], transport.propose, (_property, result) => {
        if (usable() && latest.current.draft?.property === sealed.property) setDraft({ ...sealed, result });
      });
    } finally {
      running.current = false;
      if (usable()) setBusy(false);
    }
  }
  const result = draft?.result;
  const reviewTransport = useMemo(
    () => review(field.id, result?.ok ? result.session : undefined),
    [review, field.id, result],
  );
  const value = draft?.statement.value;
  const target = value?.type === 'value' && typeof value.content === 'string' ? value.content : '';
  const title = Object.values(read.public.subject.labels)[0] ?? '';
  if (!visible) return null;
  if (field.editor === 'relation') {
    return (
      <ContentItemFrame as="article" data-slot="people-selected-items" className="min-w-0 space-y-3 py-3 sm:py-4">
        <ContentItemHeading level={3} className="text-lg font-semibold" lang={label.lang ?? undefined}>
          {label.text}
        </ContentItemHeading>
        <a className={actionClass + ' inline-flex items-center underline'} href={peopleRelationHref(read.public.subject.id, title, locale)}>
          {m.people_biography_edit({}, o)}
        </a>
      </ContentItemFrame>
    );
  }
  return (
    <ContentItemFrame as="article" data-slot="people-selected-items" className="min-w-0 space-y-3 py-3 sm:py-4">
      <ContentItemHeading level={3} className="text-lg font-semibold" lang={label.lang ?? undefined}>
        {label.text}
      </ContentItemHeading>
      {field.status === 'unsupported' ? <p role="status">{m.people_biography_unsupported({}, o)}</p> : null}
      {field.status === 'absent' && !draft ? <p role="status">{m.people_biography_absent({}, o)}</p> : null}
      {field.status === 'unreadable' ? <p role="status">{m.people_biography_unreadable({}, o)}</p> : null}
      {field.facts.map((fact, index) => (
        <article key={fact.id} className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{m.facts_selected_value({ number: index + 1 }, o)}</p>
          {fact.target ? (
            <a
              className={actionClass + ' inline-flex items-center underline'}
              lang={fact.target.lang ?? undefined}
              href={subjectHref({ id: fact.target.id, label: fact.target.label }, locale).href}
            >
              {fact.target.label || m.subject_value_unlabelled({}, o)}
            </a>
          ) : (
            <PartValue part={fact.statement} read={read} locale={locale} />
          )}
        </article>
      ))}
      {admitted && !draft ? (
        <div className="flex flex-wrap items-end gap-3">
          {!!selected.length && (
            <Field className="min-w-0 flex-1 basis-full sm:basis-56">
              <FieldLabel htmlFor={chooser}>{m.facts_choose_value({}, o)}</FieldLabel>
              <NativeSelect
                id={chooser}
                className="w-full [&_select]:min-h-11 md:pointer-fine:[&_select]:min-h-8"
                value={sourceChoice}
                onChange={(event) => usable() && setSource(event.target.value)}
              >
                <NativeSelectOption value="">{m.correction_choose({}, o)}</NativeSelectOption>
                {selected.map((statement, index) => (
                  <NativeSelectOption key={statement.id} value={statement.id}>
                    {m.facts_selected_value({ number: index + 1 }, o)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Button
            className={actionClass}
            variant="outline"
            disabled={!!selected.length && !sourceChoice}
            onClick={() => stage(sourceChoice || null)}
          >
            {m.facts_edit_field({}, o)}
          </Button>
          {definition?.multivalued ? (
            <Button className={actionClass} variant="outline" onClick={() => stage(null)}>
              {m.facts_add_value({}, o)}
            </Button>
          ) : null}
        </div>
      ) : null}
      {draft ? (
        <fieldset disabled={busy || factLocked(draft)} className="min-w-0 space-y-3">
          <p className="text-sm text-muted-foreground">{m.facts_private({}, o)}</p>
          {admitted && !result?.ok ? (
            <StatementFields
              draft={draft.statement}
              current={{ ...read, source: selected.find((statement) => statement.id === draft.source) ?? null }}
              locale={locale}
              change={change}
              valueControl={
                <EntityPicker
                  label={label.text}
                  src={coverSrc}
                  value={
                    picked[0]?.id === target
                      ? picked
                      : target
                        ? [
                            {
                              id: target,
                              title:
                                field.facts.find((fact) => fact.target?.id === target)?.target?.label ||
                                m.subject_value_unlabelled({}, o),
                              types: [],
                              typeLabel: '',
                              cover: null,
                            },
                          ]
                        : []
                  }
                  search={search}
                  onValueChange={(items) => {
                    if (!change) return;
                    setPicked(items);
                    change({ ...draft.statement, value: { type: 'value', content: items[0]?.id ?? '' } });
                  }}
                />
              }
            />
          ) : null}
          {result?.ok ? (
            <p role="status">
              {m.facts_result_proposed({}, o)} <code className="break-all">{result.candidate}</code>
            </p>
          ) : null}
          {result?.ok ? (
            <CandidateReview
              id={read.public.subject.id}
              locale={locale}
              initialProperty={field.id}
              exactCandidate={result.candidate}
              transport={reviewTransport}
            />
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button className={actionClass} type="button" disabled={!factChanged(draft) || !populated(draft.statement)} onClick={() => void submit()}>
              {m.correction_submit({}, o)}
            </Button>
            <Button className={actionClass} type="button" variant="outline" onClick={() => usable() && setDraft(undefined)}>
              {m.candidate_cancel({}, o)}
            </Button>
          </div>
        </fieldset>
      ) : null}
      <a className={actionClass + ' inline-flex items-center underline'} href={returnHref}>
        {m.people_biography_return({}, o)}
      </a>
    </ContentItemFrame>
  );
}

