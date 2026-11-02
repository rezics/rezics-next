import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { EntityPicker, type EntityPickerSearch, type EntityPickerSubject } from '@rezics/ui/entity-picker';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { pageText } from '../pages/data';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { CandidateReview, type CandidateTransport } from '../../subject/candidate-review';
import { useAuthoringDeparture } from '../../threads/authoring-departure';
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

/** A property leaving the release removes admission, while its private work keeps its keyed holder. */
export function CharacterClassifications({
  properties,
  ...props
}: Omit<Parameters<typeof CharacterClassification>[0], 'property' | 'onHold'> & {
  properties: string[];
}) {
  const [held, setHeld] = useState<string[]>([]);
  const onHold = useCallback((property: string, holding: boolean) => {
    setHeld((previous) =>
      previous.includes(property) === holding
        ? previous
        : holding
          ? [...previous, property]
          : previous.filter((item) => item !== property),
    );
  }, []);
  return [...new Set([...properties, ...held])].map((property) => (
    <CharacterClassification key={property} {...props} property={property} onHold={onHold} />
  ));
}

/** Classification uses field-wide native review, with the same sealed per-field command and reference controls. */
export function CharacterClassification({
  property,
  read,
  locale,
  search,
  transport,
  review,
  onHold,
}: {
  onHold?: (property: string, holding: boolean) => void;
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
  const definition = read.release.properties[property];
  const admitted =
    !!definition &&
    definition.datatype === 'wikibase-item' &&
    definition.relation?.group === 'classification' &&
    !!read.release.types[read.public.subject.type]?.properties.includes(property);
  // A successful new release fences old controls even when the outer reading stays visible.
  const observation = useMemo(() => ({}), [read.release, admitted]);
  const latestObservation = useRef(observation);
  latestObservation.current = observation;
  const rememberedLabel = useRef<ReturnType<typeof pageText> | undefined>(undefined);
  if (admitted) rememberedLabel.current = pageText(definition.labels, locale);
  const selected = read.public.subject.statements[property] ?? [];
  const latestRead = useRef(read);
  latestRead.current = read;
  const [source, setSource] = useState(selected.length === 1 ? selected[0]!.id : '');
  const sourceChoice = selected.some((statement) => statement.id === source) ? source : '';
  useLayoutEffect(() => {
    if (source && !selected.some((statement) => statement.id === source)) setSource('');
  }, [selected, source]);
  const [draft, setDraftState] = useState<FactDraft>();
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  // Retire deliveries immediately, including a second callback before React renders.
  const setDraft = (next: Parameters<typeof setDraftState>[0]) => {
    const value = typeof next === 'function' ? next(currentDraft.current) : next;
    currentDraft.current = value;
    setDraftState(value);
  };
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [confirmation, setConfirmation] = useState<{ draft: FactDraft; active: () => boolean }>();
  const running = useRef(false);
  const retired = useRef(false);
  const usable = () => !retired.current && active() && latestObservation.current === observation;
  const wasVisible = useRef(visible);
  const previousObservation = useRef(observation);
  if (wasVisible.current !== visible || previousObservation.current !== observation) {
    wasVisible.current = visible;
    previousObservation.current = observation;
    running.current = false;
    setBusy(false);
    setConfirmation(undefined);
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
  const unresolved = (value: FactDraft | undefined) =>
    !!value?.command &&
    (!value.result ||
      (!value.result.ok && (value.result.reason === 'uncertain' || value.result.reason === 'unavailable')));
  const needsDeparture = (value: FactDraft | undefined) =>
    !!value &&
    !value.result?.ok &&
    ((factChanged(value) && (value.baseline !== null || hasAuthoredFactContent(value.statement))) || unresolved(value));
  const holding = !!draft && (!!draft.command || needsDeparture(draft));
  useEffect(() => onHold?.(property, holding), [onHold, property, holding]);
  useAuthoringDeparture(
    () => !retired.current && needsDeparture(draft),
    () => !retired.current && unresolved(draft),
    `${read.public.subject.id}:${property}`,
    undefined,
    () => {
      retired.current = true;
      running.current = false;
      setBusy(false);
      setDraft(undefined);
      setPicked([]);
      setConfirmation(undefined);
      setReviewing(false);
      setSource(selected.length === 1 ? selected[0]!.id : '');
    },
  );
  const latestState = useRef({ draft, confirmation, busy, active: usable });
  latestState.current = { draft, confirmation, busy, active: usable };
  const confirming =
    !!draft &&
    confirmation?.draft === draft &&
    confirmation.active() &&
    active() &&
    !busy &&
    !running.current &&
    !factLocked(draft) &&
    (admitted || !draft.command);
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
  const label = admitted
    ? pageText(definition.labels, locale)
    : (rememberedLabel.current ?? { text: property, lang: undefined });
  const current = selected.find((statement) => statement.id === draft?.source);
  const stage = (id: string | null) => {
    if (!usable() || !admitted) return;
    if (currentDraft.current !== draft) return;
    if (running.current || (draft && factLocked(draft))) return;
    const currentRead = latestRead.current;
    const currentDefinition = currentRead.release.properties[property];
    if (
      !currentRead.release.types[currentRead.public.subject.type]?.properties.includes(property) ||
      currentDefinition?.datatype !== 'wikibase-item' ||
      currentDefinition.relation?.group !== 'classification'
    )
      return;
    const currentSelected = currentRead.public.subject.statements[property] ?? [];
    const selectedSource = currentSelected.find((statement) => statement.id === id);
    if (id && !selectedSource) return;
    const baseline = selectedSource ? statementInput(selectedSource) : null;
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
    const latest = latestState.current;
    if (
      !latest.active() ||
      latest.draft !== original ||
      currentDraft.current !== original ||
      latest.busy ||
      running.current ||
      factLocked(original) ||
      (!admitted && !!original.command) ||
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
    if (!usable() || !draft || running.current || busy || factLocked(draft) || (!admitted && draft.command)) return;
    if (currentDraft.current !== draft) return;
    if (factChanged(draft) && (draft.baseline !== null || hasAuthoredFactContent(draft.statement))) {
      setConfirmation({ draft, active: usable });
      return;
    }
    closeDraft(draft);
  };
  const cancelDiscard = () => {
    const latest = latestState.current;
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
  const confirmDiscard = (pending: { draft: FactDraft; active: () => boolean }) => closeDraft(pending.draft, pending);
  const change = (statement: StatementInput) => {
    if (!usable() || !admitted) return false;
    if (!draft || currentDraft.current !== draft || running.current || factLocked(draft)) return false;
    setDraft({ ...draft, statement, command: undefined, result: undefined });
    return true;
  };
  async function submit() {
    if (!usable()) return;
    if (!draft || running.current || (!admitted && !draft.command)) return;
    if (currentDraft.current !== draft) return;
    const sealed = draft.command ? draft : sealFacts(read.public.subject.id, read.release, [draft])[0];
    if (!sealed) return;
    setDraft(sealed);
    running.current = true;
    setBusy(true);
    try {
      await sendFacts([sealed], transport.propose, (_property, result) => {
        if (usable() && currentDraft.current === sealed) setDraft({ ...sealed, result });
      });
    } finally {
      if (!usable()) return;
      setBusy(false);
      running.current = false;
    }
  }
  const value = draft?.statement.value;
  const target = value?.type === 'value' && typeof value.content === 'string' ? value.content : '';
  if (!visible || (!admitted && !holding)) return null;
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
        {!draft && admitted ? (
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
                  value={sourceChoice}
                  onChange={(event) => {
                    if (usable()) setSource(event.target.value);
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
              disabled={!!selected.length && !sourceChoice}
              onClick={() => stage(sourceChoice || null)}
            >
              {m.facts_edit_field({}, o)}
            </Button>
            {definition?.multivalued && !!selected.length && (
              <Button className={actionClassName} variant="outline" onClick={() => stage(null)}>
                {m.facts_add_value({}, o)}
              </Button>
            )}
          </div>
        ) : draft ? (
          <>
            <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">{m.facts_private({}, o)}</p>
            {!admitted && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(draft.statement, null, 2)}
              </pre>
            )}
            {admitted && !result?.ok && (
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
                        definition?.targets?.some(
                          (base) => type === base || read.release.types[type]?.bases.includes(base),
                        ),
                      ),
                    )
                  }
                  onValueChange={(items) => {
                    if (
                      change({
                        ...draft.statement,
                        value: { type: 'value', content: items[0]?.id ?? '' },
                      })
                    )
                      setPicked(items);
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
                    if (usable()) setReviewing(true);
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
                  disabled={busy || !factChanged(draft) || (!admitted && !draft.command)}
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
                        disabled={busy || running.current || factLocked(draft) || (!admitted && !!draft.command)}
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
                    disabled={busy || factLocked(draft) || (!admitted && !!draft.command)}
                    onClick={discard}
                  >
                    {m.curation_view_discard({}, o)}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : null}
      </ContentItemFrame>
    </section>
  );
}
