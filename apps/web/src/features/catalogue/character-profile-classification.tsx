import { useId, useMemo, useRef, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
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

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

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
  const selectedValueId = useId();
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
    <section className="min-w-0">
      <ContentItemFrame as="div" className="min-w-0 space-y-4 rounded-xl bg-card p-4 [overflow-wrap:anywhere] sm:p-6">
        <ContentItemHeading
          level={3}
          className="min-w-0 text-lg font-semibold leading-snug"
          lang={label.lang}
          dir="auto"
        >
          {label.text}
        </ContentItemHeading>
        {!draft ? (
          <div className="flex flex-wrap items-end gap-3">
            {!!selected.length && (
              <Field className="min-w-0 flex-1 basis-full sm:basis-56">
                <FieldLabel htmlFor={selectedValueId} className="max-w-full flex-wrap whitespace-normal">
                  {m.facts_choose_value({}, o)}
                </FieldLabel>
                <NativeSelect
                  id={selectedValueId}
                  className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select:focus-visible]:outline-2 [&_select:focus-visible]:outline-offset-2 [&_select:focus-visible]:outline-ring md:pointer-fine:[&_select]:min-h-8"
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
            <Button
              className={actionClassName}
              variant="outline"
              disabled={!!selected.length && !source}
              onClick={() => stage(source || null)}
            >
              {m.facts_edit_field({}, o)}
            </Button>
            {definition.multivalued && !!selected.length && (
              <Button className={actionClassName} variant="outline" onClick={() => stage(null)}>
                {m.facts_add_value({}, o)}
              </Button>
            )}
          </div>
        ) : (
          <>
            <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">{m.facts_private({}, o)}</p>
            {!result?.ok && (
              <fieldset disabled={busy || factLocked(draft)} className="min-w-0 space-y-4">
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
                <Button className={actionClassName} onClick={() => setReviewing(true)}>
                  {m.correction_review({}, o)}
                </Button>
                {reviewing && (
                  <div className="min-w-0 [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:py-2 [&_button]:[overflow-wrap:anywhere] [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring [&_[data-slot=native-select-wrapper]]:w-full [&_select]:min-h-11 [&_label]:flex-wrap [&_label]:whitespace-normal">
                    <CandidateReview
                      id={read.public.subject.id}
                      locale={locale}
                      initialProperty={property}
                      exactCandidate={result.candidate}
                      transport={reviewTransport}
                    />
                  </div>
                )}
              </>
            ) : (
              <Button className={actionClassName} disabled={busy || !factChanged(draft)} onClick={() => void submit()}>
                {draft.command ? m.correction_retry({}, o) : m.correction_submit({}, o)}
              </Button>
            )}
          </>
        )}
      </ContentItemFrame>
    </section>
  );
}
