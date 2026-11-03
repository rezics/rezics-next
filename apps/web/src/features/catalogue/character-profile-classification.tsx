import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Release } from '@rezics/definitions';
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
  advanceChangedSetReview,
  changedSetFingerprint,
  factChanged,
  factHolder,
  factLocked,
  sealFacts,
  sendFacts,
  type ChangedSetReview,
  type FactDraft,
  type FactsCurrent,
  type FactsTransport,
} from './subject-facts';
import { type EditorRead, type StatementInput } from './statement-editor';
import {
  beginClassificationDraftReturn,
  claimClassificationReturn,
  classificationCreateHref,
  classificationCreatedTypeAdmitted,
  classificationMissingConceptAdmitted,
  classificationMissingConceptTargets,
  classificationStatementInput,
  classificationTargetUnchosen,
  createClassificationCreateHandoff,
  currentEditorReturnPath,
  discardClassificationCreateHandoff,
  readClassificationCreateHandoff,
  restoreClassificationDrafts,
  snapshotClassificationDrafts,
  type CreatedClassificationIdentity,
} from './classification-create-return';
import { candidateContext } from '../../subject/candidates';
import { EditorFailure, StatementFields } from './statement-editor-view';
import {
  catalogueEditor,
  useCurrentReadingActive,
  useCurrentReadingVisible,
  useEditorLifetime,
} from './editor-lifetime';
import { factStatementFeedback, StatementViolationFeedback } from './fact-violation-feedback';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import {
  bindClassificationReview,
  classificationAdmitted,
  classificationConfirmable,
  classificationNeedsDeparture,
  focusableClassificationHolder,
  hasAuthoredClassificationContent,
  retainOrphanedClassificationDiagnostic,
  type RemovedHolderDiagnostic,
} from './character-classification-review';
import { ClassificationReviewWorkspace, ClassificationSelectedValues } from './character-classification-review-view';

/** Native definition grouping owns admission; callers only choose which emitted fields to present. */
export function classificationFields(
  release: Release,
  type: string,
  properties: readonly string[] = release.types[type]?.properties ?? [],
): string[] {
  return [...new Set(properties)].filter(
    (property) =>
      release.properties[property]?.datatype === 'wikibase-item' &&
      release.properties[property]?.relation?.group === 'classification' &&
      !!release.types[type]?.properties.includes(property),
  );
}

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1';

export type CharacterClassificationProps = {
  onHold?: (property: string, holding: boolean) => void;
  property: string;
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
  draft?: FactDraft | undefined;
  onDraft?: (draft: FactDraft | undefined) => void;
  parentBusy?: boolean;
  reviewChangedSet?: boolean;
  onReuse?: (index: number) => void;
  focusReference?: { index: number; nonce: number } | undefined;
  onReadCurrent?: () => void;
  handoffToken?: string;
  handoffReader?: string;
  handoffReaderLive?: () => boolean;
  missingCreate?: {
    identity?: CreatedClassificationIdentity;
    blocked?: 'sealed' | 'edited' | 'unadmitted' | 'invalid';
    onCreate?: () => void;
    onChoose?: () => void;
    onCancel?: () => void;
  };
};

/** A property leaving the release removes admission, while its private work keeps its keyed holder. */
export function CharacterClassifications({
  properties,
  changedSetReview = false,
  ...props
}: Omit<CharacterClassificationProps, 'property' | 'onHold' | 'draft' | 'onDraft' | 'missingCreate'> & {
  properties: string[];
  changedSetReview?: boolean;
}) {
  if (changedSetReview) return <CharacterClassificationSet properties={properties} {...props} />;
  return <IndependentClassifications properties={properties} {...props} />;
}

function IndependentClassifications({
  properties,
  ...props
}: Omit<CharacterClassificationProps, 'property' | 'onHold' | 'draft' | 'onDraft'> & { properties: string[] }) {
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

const CharacterClassificationSet = catalogueEditor(CharacterClassificationSetLive);

function CharacterClassificationSetLive({
  properties,
  read,
  locale,
  search,
  transport,
  review,
  handoffToken,
  handoffReader = '',
  handoffReaderLive = () => false,
}: Omit<CharacterClassificationProps, 'property' | 'onHold' | 'draft' | 'onDraft' | 'missingCreate'> & {
  properties: string[];
}) {
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [changedReview, setChangedReview] = useState<ChangedSetReview>({ status: 'closed' });
  const [reuse, setReuse] = useState<{
    source: ReuseSource;
    selected: string[];
    capture: ReuseCapture;
    applied: { holder: string; property: string; index: number }[];
    refused: { holder: string; property: string; reason: ReuseRefusal }[];
    trigger: HTMLButtonElement | null;
  } | null>(null);
  const [focusCopy, setFocusCopy] = useState<{ holder: string; index: number; nonce: number } | null>(null);
  const [orphans, setOrphans] = useState<RemovedHolderDiagnostic[]>([]);
  const [overlay, setOverlay] = useState<EditorRead | null>(null);
  const running = useRef(false);
  const lifetime = useEditorLifetime();
  const reviewLive = useRef(review);
  reviewLive.current = review;
  const draftsLive = useRef(drafts);
  draftsLive.current = drafts;
  const [offered, setOffered] = useState<CreatedClassificationIdentity>();
  const [offeredHolder, setOfferedHolder] = useState<string>();
  const [offeredProperty, setOfferedProperty] = useState<string>();
  const claimed = useRef(false);
  const returning = useRef(false);
  const subjectId = read.public.subject.id;
  const subjectRef = useRef(subjectId);
  if (subjectRef.current !== subjectId) {
    subjectRef.current = subjectId;
    setDrafts([]);
    setChangedReview({ status: 'closed' });
    setReuse(null);
    setOrphans([]);
    setOverlay(null);
    setBusy(false);
    running.current = false;
    setOffered(undefined);
    setOfferedHolder(undefined);
    setOfferedProperty(undefined);
    claimed.current = false;
  }
  useEffect(() => {
    if (!handoffToken || claimed.current) return;
    claimed.current = true;
    if (!handoffReaderLive() || !lifetime.active()) {
      discardClassificationCreateHandoff(handoffToken);
      return;
    }
    const claimedHandoff = claimClassificationReturn(handoffToken, subjectId, handoffReader);
    if (!claimedHandoff) return;
    setDrafts(restoreClassificationDrafts(claimedHandoff.drafts));
    setChangedReview(
      claimedHandoff.reviewFingerprint
        ? { status: 'stale', fingerprint: claimedHandoff.reviewFingerprint }
        : { status: 'closed' },
    );
    if (claimedHandoff.phase === 'returned' && claimedHandoff.identity) {
      setOffered(claimedHandoff.identity);
      setOfferedHolder(claimedHandoff.holder);
      setOfferedProperty(claimedHandoff.propertyId);
    }
    return () => {
      if (!returning.current) discardClassificationCreateHandoff(handoffToken);
    };
  }, [handoffToken, handoffReader, handoffReaderLive, lifetime, subjectId]);
  const current: FactsCurrent = overlay && overlay.ok ? overlay : read;
  const readFailed = overlay != null && !overlay.ok;
  const admitted = new Set(properties.filter((property) => classificationAdmitted(current, property)));
  const fingerprint = changedSetFingerprint(drafts);
  const nextReview = advanceChangedSetReview(changedReview, fingerprint);
  if (
    nextReview.status !== changedReview.status ||
    (nextReview.status !== 'closed' &&
      changedReview.status !== 'closed' &&
      nextReview.fingerprint !== changedReview.fingerprint)
  )
    setChangedReview(nextReview);
  const held = drafts
    .filter((draft) => !!draft.command || classificationNeedsDeparture(draft))
    .map((draft) => draft.property);
  const fields = [...new Set([...properties, ...held])];
  const visible = useCurrentReadingVisible();
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    running.current = false;
    setBusy(false);
    if (!visible)
      setDrafts((previous) =>
        previous.map((draft) =>
          draft.command && !draft.result ? { ...draft, result: { ok: false, reason: 'uncertain' } } : draft,
        ),
      );
  }
  function assign(property: string, next: FactDraft | undefined) {
    if (!lifetime.active()) return;
    const original = drafts.find((draft) => draft.property === property);
    if (original && next === undefined) setOrphans((items) => retainOrphanedClassificationDiagnostic(original, items));
    setDrafts((previous) =>
      next
        ? [...previous.filter((draft) => draft.property !== property), next]
        : previous.filter((draft) => draft.property !== property),
    );
  }
  function openHolder(holder: string, index?: number) {
    if (index != null) setFocusCopy({ holder, index, nonce: Date.now() });
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(holder)
        : holder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const heading = document.querySelector<HTMLElement>(`[data-fact-holder="${escaped}"]`);
    heading?.focus();
    heading?.scrollIntoView?.({ block: 'center' });
  }
  function jumpTo(holder: string) {
    if (!lifetime.active()) return;
    const focusable = focusableClassificationHolder(holder, drafts, orphans);
    setChangedReview(advanceChangedSetReview(changedReview, fingerprint, true));
    if (focusable) openHolder(focusable);
  }
  async function confirm() {
    if (!lifetime.active() || running.current) return;
    if (
      !classificationConfirmable({
        drafts,
        reviewCurrent: changedReview.status === 'current',
        admitted,
        readFailed,
      })
    )
      return;
    running.current = true;
    const sealed = sealFacts(current.public.subject.id, current.release, drafts);
    setDrafts(sealed);
    setBusy(true);
    try {
      await sendFacts(
        sealed,
        (command) => {
          if (!lifetime.active()) throw new Error('Retired catalogue editor');
          return transport.propose(command);
        },
        (property, result) =>
          lifetime.active() &&
          setDrafts((previous) =>
            previous.map((draft) => (draft.property === property ? { ...draft, result } : draft)),
          ),
      );
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  async function readCurrent() {
    if (!lifetime.active() || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const next = await transport.read();
      if (!lifetime.active()) return;
      setOverlay(next);
    } catch {
      if (!lifetime.active()) return;
      setOverlay({ ok: false, reason: 'unavailable' });
    } finally {
      if (!lifetime.active()) return;
      running.current = false;
      setBusy(false);
    }
  }
  const readCurrentLive = useRef(readCurrent);
  readCurrentLive.current = readCurrent;
  const openHolderLive = useRef(openHolder);
  openHolderLive.current = openHolder;
  const boundReview = useMemo(
    () =>
      bindClassificationReview(
        (property, session) => reviewLive.current(property, session),
        () => readCurrentLive.current(),
        () => lifetime.active(),
        (property) => {
          const draft = draftsLive.current.find((item) => item.property === property);
          openHolderLive.current(draft ? factHolder(draft) : property);
        },
      ),
    [lifetime],
  );
  const success = drafts.filter((draft) => draft.result?.ok).length;
  function beginMissingCreate(property: string, draft: FactDraft) {
    if (!lifetime.active() || !handoffReaderLive() || factLocked(draft) || draft.command) return;
    if (!classificationMissingConceptAdmitted(current.release, property)) return;
    if (!classificationTargetUnchosen(draft.statement)) return;
    const snapshots = snapshotClassificationDrafts(draftsLive.current);
    if (!snapshots) return;
    const created = createClassificationCreateHandoff({
      sourceId: current.public.subject.id,
      sourceLabel: pageText(current.public.subject.labels, locale).text || current.public.subject.id,
      sourceType: current.public.subject.type,
      returnPath: currentEditorReturnPath(),
      reader: handoffReader,
      context: candidateContext,
      releaseDigest: `${current.release.catalogue.id}:${current.release.catalogue.version}`,
      propertyId: property,
      propertyLabel: pageText(current.release.properties[property]?.labels ?? {}, locale).text || property,
      holder: factHolder(draft),
      originalStatementId: draft.source,
      targets: classificationMissingConceptTargets(current.release, property),
      drafts: snapshots,
      reviewFingerprint: fingerprint,
    });
    if (!created) return;
    returning.current = true;
    window.location.assign(classificationCreateHref(locale, created.token));
  }
  function chooseCreated(property: string, draft: FactDraft) {
    if (!lifetime.active() || !offered || offeredHolder !== factHolder(draft) || offeredProperty !== property) return;
    if (factLocked(draft) || draft.command || !classificationTargetUnchosen(draft.statement)) return;
    if (
      !classificationCreatedTypeAdmitted(current.release, property, offered.type, offered.bases) ||
      current.public.subject.id !== subjectId
    )
      return;
    assign(property, {
      ...draft,
      statement: { ...draft.statement, value: { type: 'value', content: offered.id } },
    });
    setOffered(undefined);
    setOfferedHolder(undefined);
    setOfferedProperty(undefined);
    if (handoffToken) discardClassificationCreateHandoff(handoffToken);
  }
  function cancelOffered(property: string, draft: FactDraft) {
    if (!lifetime.active() || offeredHolder !== factHolder(draft) || offeredProperty !== property) return;
    setOffered(undefined);
    setOfferedHolder(undefined);
    setOfferedProperty(undefined);
    if (handoffToken) discardClassificationCreateHandoff(handoffToken);
  }
  if (!visible) return null;
  return (
    <div className="min-w-0 space-y-4">
      {fields.map((property) => {
        const draft = drafts.find((item) => item.property === property);
        return (
          <CharacterClassification
            key={property}
            property={property}
            read={current}
            locale={locale}
            search={search}
            transport={transport}
            review={boundReview}
            draft={draft}
            onDraft={(next) => assign(property, next)}
            parentBusy={busy}
            reviewChangedSet
            onReuse={(index) => {
              if (!lifetime.active() || !draft) return;
              const group = draft.statement.references[index];
              if (!group) return;
              const source = {
                holder: factHolder(draft),
                property: draft.property,
                groupIndex: index,
                snapshot: cloneReferenceGroup(group),
              };
              setReuse({
                source,
                selected: [],
                capture: captureReuse(source, drafts),
                applied: [],
                refused: [],
                trigger: document.activeElement instanceof HTMLButtonElement ? document.activeElement : null,
              });
            }}
            focusReference={
              focusCopy && draft && factHolder(draft) === focusCopy.holder
                ? { index: focusCopy.index, nonce: focusCopy.nonce }
                : undefined
            }
            onReadCurrent={() => void readCurrent()}
            {...(handoffReader
              ? (() => {
                  if (!draft) return {};
                  const holder = factHolder(draft);
                  const offeredHere = offered && offeredHolder === holder && offeredProperty === property;
                  const sealed = factLocked(draft) || !!draft.command;
                  const edited = offeredHere && !classificationTargetUnchosen(draft.statement);
                  const unadmitted =
                    offeredHere &&
                    !classificationCreatedTypeAdmitted(current.release, property, offered.type, offered.bases);
                  return {
                    missingCreate: {
                      ...(offeredHere ? { identity: offered } : {}),
                      ...(sealed
                        ? { blocked: 'sealed' as const }
                        : edited
                          ? { blocked: 'edited' as const }
                          : unadmitted
                            ? { blocked: 'unadmitted' as const }
                            : {}),
                      ...(!sealed &&
                      classificationTargetUnchosen(draft.statement) &&
                      classificationMissingConceptAdmitted(current.release, property)
                        ? { onCreate: () => beginMissingCreate(property, draft) }
                        : {}),
                      ...(offeredHere && !sealed && !edited && !unadmitted
                        ? { onChoose: () => chooseCreated(property, draft) }
                        : {}),
                      ...(offeredHere ? { onCancel: () => cancelOffered(property, draft) } : {}),
                    },
                  };
                })()
              : {})}
          />
        );
      })}
      <ClassificationReviewWorkspace
        drafts={drafts}
        read={current}
        locale={locale}
        changedReview={changedReview}
        busy={busy}
        success={success}
        readFailed={readFailed}
        reuse={reuse}
        orphans={orphans}
        onReview={() => lifetime.active() && setChangedReview({ status: 'current', fingerprint })}
        onConfirm={() => void confirm()}
        onJump={jumpTo}
        onReadCurrent={() => void readCurrent()}
        onReuseSelected={(selected) =>
          lifetime.active() && reuse && setReuse({ ...reuse, selected, applied: [], refused: [] })
        }
        onReuseRefresh={() => {
          if (!lifetime.active() || !reuse) return;
          const origin = drafts.find((draft) => factHolder(draft) === reuse.source.holder);
          const group = origin?.statement.references[reuse.source.groupIndex];
          if (!origin || !group) return;
          const source = { ...reuse.source, snapshot: cloneReferenceGroup(group) };
          setReuse({ ...reuse, source, capture: captureReuse(source, drafts), applied: [], refused: [] });
        }}
        onReuseApply={() => {
          if (!lifetime.active() || !reuse) return;
          const chosen = reuse.selected.filter((holder) => {
            const target = drafts.find((draft) => factHolder(draft) === holder);
            return !!target && admitted.has(target.property) && !factLocked(target);
          });
          const result = applyReuse(drafts, reuse.source, chosen, current.release);
          setDrafts(result.drafts);
          setReuse({ ...reuse, applied: result.applied, refused: result.refused });
          setChangedReview({ status: 'stale', fingerprint: changedSetFingerprint(result.drafts) });
          const first = result.applied[0];
          if (first) openHolder(first.holder, first.index);
        }}
        onReuseCancel={() => {
          const trigger = reuse?.trigger;
          setReuse(null);
          if (lifetime.active() && trigger?.isConnected) trigger.focus();
        }}
        onReuseOpen={(holder, index) => lifetime.active() && openHolder(holder, index)}
      />
    </div>
  );
}

/** Classification uses field-wide native review, with the same sealed per-field command and reference controls. */
export const CharacterClassification = catalogueEditor(CharacterClassificationLive);

function CharacterClassificationLive({
  property,
  read,
  locale,
  search,
  transport,
  review,
  onHold,
  draft: controlledDraft,
  onDraft,
  parentBusy = false,
  reviewChangedSet = false,
  onReuse,
  focusReference,
  onReadCurrent,
  missingCreate,
}: CharacterClassificationProps) {
  const active = useCurrentReadingActive();
  const visible = useCurrentReadingVisible();
  const selectedValueId = useId();
  const feedbackId = useId();
  const o = { locale: locale as never };
  const definition = read.release.properties[property];
  const admitted =
    !!definition &&
    definition.datatype === 'wikibase-item' &&
    definition.relation?.group === 'classification' &&
    !!read.release.types[read.public.subject.type]?.properties.includes(property);
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
  const [localDraft, setLocalDraft] = useState<FactDraft>();
  const draft = onDraft ? controlledDraft : localDraft;
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const setDraft = (next: Parameters<typeof setLocalDraft>[0]) => {
    const value = typeof next === 'function' ? next(currentDraft.current) : next;
    currentDraft.current = value;
    if (onDraft) onDraft(value);
    else setLocalDraft(value);
  };
  const [picked, setPicked] = useState<EntityPickerSubject[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const busy = parentBusy || localBusy;
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
    setLocalBusy(false);
    setConfirmation(undefined);
    if (!onDraft)
      setDraft((previous) =>
        previous?.command && !previous.result ? { ...previous, result: { ok: false, reason: 'uncertain' } } : previous,
      );
  }
  const chooser = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLFieldSetElement>(null);
  const openingFocus = useRef<
    | {
        draft: FactDraft;
        opener: HTMLButtonElement;
        active: () => boolean;
        cancel: () => void;
      }
    | undefined
  >(undefined);
  const focusScope = useMemo(() => ({}), [property, locale, read.public.subject.id]);
  const latestFocusScope = useRef(focusScope);
  latestFocusScope.current = focusScope;
  useLayoutEffect(() => () => openingFocus.current?.cancel(), []);
  useLayoutEffect(() => {
    const intent = openingFocus.current;
    if (!intent) return;
    const document = intent.opener.ownerDocument;
    const focused = document.activeElement;
    const admittedFocus =
      intent.active() &&
      draft === intent.draft &&
      currentDraft.current === intent.draft &&
      (focused === intent.opener || (!intent.opener.isConnected && (!focused || focused === document.body)));
    intent.cancel();
    const target = editor.current?.querySelector<HTMLInputElement>('input[role="combobox"]:not(:disabled)');
    if (admittedFocus && target?.isConnected && !target.closest('[hidden]')) target.focus();
  });
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const restoreDiscardFocus = useRef(false);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (draft || !returnFocus.current) return;
    returnFocus.current = false;
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
    ((factChanged(value) && (value.baseline !== null || hasAuthoredClassificationContent(value.statement))) ||
      unresolved(value));
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
      setLocalBusy(false);
      setDraft(undefined);
      setPicked([]);
      setConfirmation(undefined);
      setReviewing(false);
      setSource(selected.length === 1 ? selected[0]!.id : '');
    },
  );
  const latestState = useRef({ draft, confirmation, busy, active: usable });
  latestState.current = { draft, confirmation, busy, active: usable };
  const sameHolder = (left?: FactDraft, right?: FactDraft) =>
    !!left && !!right && factHolder(left) === factHolder(right);
  const confirming =
    !!draft &&
    !!confirmation &&
    sameHolder(confirmation.draft, draft) &&
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
  const feedback = admitted && draft ? factStatementFeedback(draft, read.release, locale, feedbackId) : undefined;
  const reviewTransport = useMemo(
    () => (reviewing && result?.ok ? review(property, result.session) : null),
    [review, property, result, reviewing],
  );
  const label = admitted
    ? pageText(definition.labels, locale)
    : (rememberedLabel.current ?? { text: property, lang: undefined });
  const current = selected.find((statement) => statement.id === draft?.source);
  const stage = (id: string | null, event: MouseEvent<HTMLButtonElement>) => {
    openingFocus.current?.cancel();
    if (!usable() || !admitted) return;
    if (draft && !sameHolder(currentDraft.current, draft)) return;
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
    const baseline = selectedSource ? classificationStatementInput(selectedSource) : null;
    setConfirmation(undefined);
    setPicked([]);
    setReviewing(false);
    const next: FactDraft = {
      holder: crypto.randomUUID(),
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
    };
    const opener = event.currentTarget;
    const document = opener.ownerDocument;
    if (event.detail === 0 && document.activeElement === opener && opener.isConnected) {
      const cancel = () => {
        document.removeEventListener('focusin', moved, true);
        document.removeEventListener('pointerdown', cancel, true);
        document.removeEventListener('keydown', tabbed, true);
        if (openingFocus.current?.cancel === cancel) openingFocus.current = undefined;
      };
      const moved = (event: FocusEvent) => {
        if (event.target !== opener) cancel();
      };
      const tabbed = (event: KeyboardEvent) => {
        if (event.key === 'Tab') cancel();
      };
      openingFocus.current = {
        draft: next,
        opener,
        active: () => usable() && latestFocusScope.current === focusScope,
        cancel,
      };
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', tabbed, true);
    }
    setDraft(next);
  };
  const closeDraft = (original: FactDraft, pending?: { draft: FactDraft; active: () => boolean }) => {
    const latest = latestState.current;
    if (
      !latest.active() ||
      !sameHolder(latest.draft, original) ||
      !sameHolder(currentDraft.current, original) ||
      latest.busy ||
      running.current ||
      factLocked(original) ||
      (!admitted && !!original.command) ||
      (pending &&
        (!sameHolder(latest.confirmation?.draft, pending.draft) ||
          !sameHolder(pending.draft, original) ||
          !pending.active() ||
          !latest.active()))
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
    if (!sameHolder(currentDraft.current, draft)) return;
    if (factChanged(draft) && (draft.baseline !== null || hasAuthoredClassificationContent(draft.statement))) {
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
      !sameHolder(latest.confirmation.draft, latest.draft) ||
      !latest.confirmation.active()
    )
      return;
    restoreDiscardFocus.current = true;
    setConfirmation(undefined);
  };
  const confirmDiscard = (pending: { draft: FactDraft; active: () => boolean }) => closeDraft(pending.draft, pending);
  const change = (statement: StatementInput) => {
    if (!usable() || !admitted) return false;
    if (!draft || !sameHolder(currentDraft.current, draft) || running.current || factLocked(draft)) return false;
    setDraft({ ...draft, statement, command: undefined, result: undefined, submission: undefined });
    return true;
  };
  async function submit() {
    if (!usable()) return;
    if (!draft || running.current || (!admitted && !draft.command)) return;
    if (!sameHolder(currentDraft.current, draft)) return;
    if (reviewChangedSet && !draft.command) return;
    const sealed = draft.command ? draft : sealFacts(read.public.subject.id, read.release, [draft])[0];
    if (!sealed) return;
    setDraft(sealed);
    running.current = true;
    setLocalBusy(true);
    try {
      await sendFacts([sealed], transport.propose, (_property, result) => {
        if (usable() && currentDraft.current === sealed) setDraft({ ...sealed, result });
      });
    } finally {
      if (!usable()) return;
      setLocalBusy(false);
      running.current = false;
    }
  }
  const value = draft?.statement.value;
  const target = value?.type === 'value' && typeof value.content === 'string' ? value.content : '';
  if (!visible || (!admitted && !holding)) return null;
  const fieldSubmit = !reviewChangedSet || !!draft?.command;
  return (
    <section className="min-w-0" data-classification-property={property}>
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
              <>
                <ClassificationSelectedValues property={property} read={read} locale={locale} />
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
              </>
            )}
            {!selected.length && <ClassificationSelectedValues property={property} read={read} locale={locale} />}
            <Button
              className={actionClassName}
              variant="outline"
              disabled={!!selected.length && !sourceChoice}
              onClick={(event) => stage(sourceChoice || null, event)}
            >
              {m.facts_edit_field({}, o)}
            </Button>
            {definition?.multivalued && !!selected.length && (
              <Button className={actionClassName} variant="outline" onClick={(event) => stage(null, event)}>
                {m.facts_add_value({}, o)}
              </Button>
            )}
          </div>
        ) : draft ? (
          <>
            <ContentItemHeading
              data-fact-holder={factHolder(draft)}
              tabIndex={-1}
              level={4}
              className="text-base font-semibold"
            >
              {m.facts_private({}, o)}
            </ContentItemHeading>
            {!admitted && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(draft.statement, null, 2)}
              </pre>
            )}
            {admitted && !result?.ok && (
              <fieldset ref={editor} disabled={busy || factLocked(draft)} className="min-w-0 space-y-4">
                <div
                  id={`${feedbackId}-fields`}
                  role="group"
                  aria-label={m.correction_title({}, o)}
                  tabIndex={-1}
                  className="space-y-4"
                >
                  <StatementFields
                    heading="h4"
                    draft={draft.statement}
                    current={{ ...read, source: current ?? null }}
                    locale={locale}
                    change={change}
                    feedback={feedback}
                    stablePartAddresses
                    reuse={onReuse && !factLocked(draft) ? { disabled: busy, onReuse } : undefined}
                    focusReference={focusReference}
                    valueControl={
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
                    }
                  />
                  {missingCreate?.identity && (
                    <p role="status">
                      {m.classification_create_created_identity(
                        { label: missingCreate.identity.label, type: missingCreate.identity.type },
                        o,
                      )}{' '}
                      <code className="break-all">{missingCreate.identity.id}</code>
                    </p>
                  )}
                  {missingCreate?.blocked === 'sealed' && (
                    <p role="status">{m.classification_create_blocked_sealed({}, o)}</p>
                  )}
                  {missingCreate?.blocked === 'edited' && (
                    <p role="status">{m.classification_create_blocked_edited({}, o)}</p>
                  )}
                  {missingCreate?.blocked === 'unadmitted' && (
                    <p role="status">{m.classification_create_blocked_unadmitted({}, o)}</p>
                  )}
                  {missingCreate?.onChoose && (
                    <Button className={actionClassName} type="button" onClick={() => missingCreate.onChoose?.()}>
                      {m.classification_create_choose({}, o)}
                    </Button>
                  )}
                  {missingCreate?.onCreate && !missingCreate.identity && (
                    <Button
                      className={actionClassName}
                      type="button"
                      variant="outline"
                      onClick={() => missingCreate.onCreate?.()}
                    >
                      {m.classification_create_missing({}, o)}
                    </Button>
                  )}
                  {missingCreate?.onCancel && (
                    <Button
                      className={actionClassName}
                      type="button"
                      variant="outline"
                      onClick={() => missingCreate.onCancel?.()}
                    >
                      {m.classification_create_cancel_return({}, o)}
                    </Button>
                  )}
                </div>
              </fieldset>
            )}
            {result && !result.ok && <EditorFailure reason={result.reason} locale={locale} />}
            <StatementViolationFeedback feedback={feedback} locale={locale} />
            {result && !result.ok && factLocked(draft) && (
              <p className="text-sm text-muted-foreground">{m.facts_uncertain({}, o)}</p>
            )}
            {result?.ok ? (
              <>
                <p role="status">{m.correction_proposed({}, o)}</p>
                <p className="text-sm text-muted-foreground">{m.classification_review_native({}, o)}</p>
                <Button
                  className={actionClassName}
                  onClick={() => {
                    if (usable()) setReviewing(true);
                  }}
                >
                  {m.correction_review({}, o)}
                </Button>
                {onReadCurrent && (
                  <Button className={actionClassName} variant="outline" onClick={() => usable() && onReadCurrent()}>
                    {m.classification_read_current({}, o)}
                  </Button>
                )}
                {reviewing && reviewTransport && (
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
                {fieldSubmit && (
                  <Button
                    className={actionClassName}
                    disabled={busy || !factChanged(draft) || (!admitted && !draft.command)}
                    onClick={() => void submit()}
                  >
                    {draft.command ? m.correction_retry({}, o) : m.correction_submit({}, o)}
                  </Button>
                )}
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
