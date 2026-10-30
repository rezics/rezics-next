import { useMemo, useRef, useState } from 'react';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { pageText } from '../pages/data';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import {
  factChanged,
  factLocked,
  sealFacts,
  sendFacts,
  type FactDraft,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { statementInput } from './statement-editor';
import { EditorFailure, StatementFields } from './statement-editor-view';

/** Classification uses field-wide native review, with the same sealed per-field command and reference controls. */
export function CharacterClassification({
  property,
  read,
  locale,
  search,
  transport,
  review,
}: {
  property: string;
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const o = { locale: locale as never };
  const definition = read.release.properties[property]!;
  const selected = read.public.subject.statements[property] ?? [];
  const [source, setSource] = useState(selected.length === 1 ? selected[0]!.id : '');
  const [draft, setDraft] = useState<FactDraft>();
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const running = useRef(false);
  const result = draft?.result;
  const reviewTransport = useMemo(
    () => review(property, result?.ok ? result.session : undefined),
    [review, property, result],
  );
  const label = pageText(definition.labels, locale);
  const current = selected.find((statement) => statement.id === draft?.source);
  const stage = (id: string | null) => {
    const source = selected.find((statement) => statement.id === id);
    const baseline = source ? statementInput(source) : null;
    setDraft({
      property,
      source: id,
      baseline,
      included: true,
      statement: baseline
        ? structuredClone(baseline)
        : {
            property: { id: property },
            value: { type: 'value', content: '' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
    });
  };
  async function submit() {
    if (!draft || running.current) return;
    const [sealed] = sealFacts(read.public.subject.id, read.release, [draft]);
    if (!sealed) return;
    setDraft(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts([sealed], transport.propose, (_property, result) => setDraft({ ...sealed, result }));
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  const value = draft?.statement.value;
  const target = value?.type === 'value' && typeof value.content === 'string' ? value.content : '';
  return (
    <section className="space-y-4 rounded-xl border border-border p-4">
      <h3 className="font-semibold" lang={label.lang}>
        {label.text}
      </h3>
      {!draft ? (
        <div className="flex flex-wrap items-end gap-3">
          {!!selected.length && (
            <Field>
              <FieldLabel>{m.facts_choose_value({}, o)}</FieldLabel>
              <NativeSelect
                aria-label={m.facts_choose_value({}, o)}
                value={source}
                onChange={(event) => setSource(event.target.value)}
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
          <Button variant="outline" disabled={!!selected.length && !source} onClick={() => stage(source || null)}>
            {m.facts_edit_field({}, o)}
          </Button>
          {definition.multivalued && !!selected.length && (
            <Button variant="outline" onClick={() => stage(null)}>
              {m.facts_add_value({}, o)}
            </Button>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm">{m.facts_private({}, o)}</p>
          {!result?.ok && (
            <fieldset disabled={busy || factLocked(draft)} className="space-y-4">
              <EntityPicker
                label={label.text}
                disabled={busy || factLocked(draft)}
                src={coverSrc}
                value={
                  picked.length
                    ? picked
                    : target
                      ? [
                          {
                            id: target,
                            title:
                              pageText(read.public.related[target]?.labels, locale).text ||
                              m.subject_value_unlabelled({}, o),
                            types: [],
                            typeLabel: '',
                            cover: null,
                          },
                        ]
                      : []
                }
                search={async (text, signal) =>
                  (await search(text, signal)).filter((entry) =>
                    entry.types.some((type) =>
                      definition.targets?.some(
                        (base) => type === base || read.release.types[type]?.bases.includes(base),
                      ),
                    ),
                  )
                }
                onValueChange={(items) => {
                  setPicked(items);
                  setDraft({
                    ...draft,
                    command: undefined,
                    result: undefined,
                    statement: { ...draft.statement, value: { type: 'value', content: items[0]?.id ?? '' } },
                  });
                }}
              />
              <StatementFields
                heading="h4"
                draft={draft.statement}
                current={{ ...read, source: current ?? null }}
                locale={locale}
                change={(statement) => setDraft({ ...draft, statement, command: undefined, result: undefined })}
              />
            </fieldset>
          )}
          {result && !result.ok && <EditorFailure reason={result.reason} locale={locale} />}
          {result?.ok ? (
            <>
              <p role="status">{m.correction_proposed({}, o)}</p>
              <Button onClick={() => setReviewing(true)}>{m.correction_review({}, o)}</Button>
              {reviewing && (
                <CandidateReview
                  id={read.public.subject.id}
                  locale={locale}
                  initialProperty={property}
                  exactCandidate={result.candidate}
                  transport={reviewTransport}
                />
              )}
            </>
          ) : (
            <Button disabled={busy || !factChanged(draft)} onClick={() => void submit()}>
              {draft.command ? m.correction_retry({}, o) : m.correction_submit({}, o)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
