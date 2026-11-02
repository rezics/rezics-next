import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { statementInput, type StatementInput } from './statement-editor';
import { EditorFailure, StatementFields } from './statement-editor-view';
import { useCurrentReadingActive, useCurrentReadingVisible } from './editor-lifetime';

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return !!value.trim();
  if (value == null) return false;
  if (typeof value === 'object') return Object.values(value).some(hasContent);
  return true;
}

function hasAuthoredFactContent(statement: StatementInput): boolean {
  const populated = (part: { value: { type: string; content?: unknown } }) =>
    part.value.type !== 'value' || hasContent(part.value.content);
  return (
    populated(statement) ||
    statement.qualifiers?.some(populated) === true ||
    statement.references.some((reference) => reference.parts.some(populated))
  );
}

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
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const selectedValueId = useId();
  const o = { locale: locale as never };
  const definition = read.release.properties[property]!;
  const selected = read.public.subject.statements[property] ?? [];
  const [source, setSource] = useState(selected.length === 1 ? selected[0]!.id : '');
  const [draft, setDraft] = useState<FactDraft>();
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [confirmation, setConfirmation] = useState<{ draft: FactDraft; active: () => boolean }>();
  const running = useRef(false);
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible) {
      setPicked([]);
      setConfirmation(undefined);
    }
    if (!visible)
      setDraft((previous) =>
        previous?.command && !previous.result ? { ...previous, result: { ok: false, reason: 'uncertain' } } : previous,
      );
  }
  const chooser = useRef<HTMLDivElement>(null);
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const restoreDiscardFocus = useRef(false);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (draft || !returnFocus.current) return;
    returnFocus.current = false;
    // Discard removes the focused button; return to the source choice in this instance.
    const control = chooser.current?.querySelector<HTMLElement>('select, button');
    control?.focus();
  }, [draft]);
  const current = useRef({ draft, confirmation, busy, active });
  current.current = { draft, confirmation, busy, active };
  const confirming =
    !!draft &&
    confirmation?.draft === draft &&
    confirmation.active() &&
    active() &&
    !busy &&
    !running.current &&
    !factLocked(draft);
  const discardTitle = m.candidate_confirm_title({ action: m.curation_view_discard({}, o) }, o);
  useLayoutEffect(() => {
    if (confirming) cancelConfirmation.current?.focus();
    else if (restoreDiscardFocus.current) {
      restoreDiscardFocus.current = false;
      discardTrigger.current?.focus();
    }
  }, [confirming]);
  const result = draft?.result;
  const reviewTransport = useMemo(
    () => review(property, result?.ok ? result.session : undefined),
    [review, property, result],
  );
  const label = pageText(definition.labels, locale);
  const current = selected.find((statement) => statement.id === draft?.source);
  const stage = (id: string | null) => {
    if (!active()) return;
    if (running.current || (draft && factLocked(draft))) return;
    const source = selected.find((statement) => statement.id === id);
    if (id && !source) return;
    const baseline = source ? statementInput(source) : null;
    setConfirmation(undefined);
    setPicked([]);
    setReviewing(false);
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
  const closeDraft = (original: FactDraft, pending?: { draft: FactDraft; active: () => boolean }) => {
    const latest = current.current;
    if (
      !latest.active() ||
      latest.draft !== original ||
      latest.busy ||
      running.current ||
      factLocked(original) ||
      (pending &&
        (latest.confirmation !== pending || pending.draft !== original || !pending.active() || !latest.active()))
    )
      return;
    returnFocus.current = true;
    setConfirmation(undefined);
    setDraft(undefined);
    setPicked([]);
    setReviewing(false);
    setSource(selected.length === 1 ? selected[0]!.id : '');
  };
  const discard = () => {
    if (!active() || !draft || running.current || busy || factLocked(draft)) return;
    if (factChanged(draft) && (draft.baseline !== null || hasAuthoredFactContent(draft.statement))) {
      setConfirmation({ draft, active });
      return;
    }
    closeDraft(draft);
  };
  const cancelDiscard = () => {
    const latest = current.current;
    if (
      !latest.active() ||
      !latest.confirmation ||
      latest.confirmation.draft !== latest.draft ||
      !latest.confirmation.active()
    )
      return;
    restoreDiscardFocus.current = true;
    setConfirmation(undefined);
  };
  const confirmDiscard = (pending: { draft: FactDraft; active: () => boolean }) =>
    closeDraft(pending.draft, pending);
  const change = (statement: StatementInput) => {
    if (!active()) return;
    if (!draft || running.current || factLocked(draft)) return;
    setDraft({ ...draft, statement, command: undefined, result: undefined });
  };
  async function submit() {
    if (!active()) return;
    if (!draft || running.current) return;
    const [sealed] = sealFacts(read.public.subject.id, read.release, [draft]);
    if (!sealed) return;
    setDraft(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts([sealed], transport.propose, (_property, result) => {
        if (active()) setDraft({ ...sealed, result });
      });
    } finally {
      if (!active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  const value = draft?.statement.value;
  const target = value?.type === 'value' && typeof value.content === 'string' ? value.content : '';
  if (!visible) return null;
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
          <div ref={chooser} className="flex flex-wrap items-end gap-3">
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
                  onChange={(event) => {
                    if (active()) setSource(event.target.value);
                  }}
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
                    picked[0]?.id === target
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
                    if (!active() || running.current || factLocked(draft)) return;
                    setPicked(items);
                    change({
                      ...draft.statement,
                      value: { type: 'value', content: items[0]?.id ?? '' },
                    });
                  }}
                />
                <StatementFields
                  heading="h4"
                  draft={draft.statement}
                  current={{ ...read, source: current ?? null }}
                  locale={locale}
                  change={change}
                />
              </fieldset>
            )}
            {result && !result.ok && <EditorFailure reason={result.reason} locale={locale} />}
            {result && !result.ok && factLocked(draft) && (
              <p className="text-sm text-muted-foreground">{m.facts_uncertain({}, o)}</p>
            )}
            {result?.ok ? (
              <>
                <p role="status">{m.correction_proposed({}, o)}</p>
                <Button
                  className={actionClassName}
                  onClick={() => {
                    if (active()) setReviewing(true);
                  }}
                >
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
              <div className="flex flex-wrap gap-3">
                <Button
                  className={actionClassName}
                  disabled={busy || !factChanged(draft)}
                  onClick={() => void submit()}
                >
                  {draft.command ? m.correction_retry({}, o) : m.correction_submit({}, o)}
                </Button>
                {confirming && confirmation ? (
                  <div
                    role="group"
                    aria-label={discardTitle}
                    className="space-y-2"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelDiscard();
                      }
                    }}
                  >
                    <p>{discardTitle}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        ref={cancelConfirmation}
                        className={actionClassName}
                        type="button"
                        variant="outline"
                        onClick={cancelDiscard}
                      >
                        {m.candidate_cancel({}, o)}
                      </Button>
                      <Button
                        className={actionClassName}
                        type="button"
                        variant="destructive"
                        disabled={busy || running.current || factLocked(draft)}
                        onClick={() => confirmDiscard(confirmation)}
                      >
                        {m.curation_view_discard({}, o)}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    ref={discardTrigger}
                    className={actionClassName}
                    variant="outline"
                    disabled={busy || factLocked(draft)}
                    onClick={discard}
                  >
                    {m.curation_view_discard({}, o)}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </ContentItemFrame>
    </section>
  );
}
