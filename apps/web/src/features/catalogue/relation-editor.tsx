import { catalogueEditor, useEditorLifetime, useCurrentReadingVisible } from './editor-lifetime';
import { useCatalogueLifetime } from '../../subject/candidate-lifetime';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MouseEvent } from 'react';
import { useId } from 'react';
import type { SubjectRead } from '@rezics/client';
import { pickText } from '@rezics/composition';
import { StatementConsentLink } from './statement-consent-view';
import { consentAddress, type ConsentAddress } from './statement-consent';
import { RelationEditorNavigation } from './relation-editor-navigation';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { EntityPicker, type EntityPickerSubject, type EntityPickerSearch } from '@rezics/ui/entity-picker';
import { CandidateValue } from '../pages/data';
import { coverSrc } from '../../media/cover-src';
import { m } from '../../paraglide/messages.js';
import { DefinitionGuideLink } from './definition-guide-view';
import { subjectHref } from '../../subject/subject-href';
import { candidateContext, type Candidate, type CandidateFailure } from '../../subject/candidates';
import {
  createCreditTargetHandoff,
  creditIdentityTypes,
  discardCreditTargetHandoff,
  type CreditTargetHandoff,
  type CreatedCreditIdentity,
} from './credit-target-handoff';
import {
  relationDraft,
  relationSlotMatches,
  validRelationSlot,
  type RelationDraft,
  type RelationRead,
  type RelationSlot,
  type RelationConfirmation,
  type RelationResult,
  type RelationProposal,
  type RelationTransport,
  type RelationQualifier,
  type RelationField,
} from '../../subject/relation-candidates';

// Presentation only: native actions keep their own targets and focus, with no stretched row action.
const relationSurface = [
  'min-w-0 space-y-6 [overflow-wrap:anywhere]',
  '[&_button]:min-h-11 [&_button]:min-w-11 [&_button]:h-auto [&_button]:whitespace-normal [&_button]:py-2',
  '[&_input:not([type=hidden])]:min-h-11 [&_select]:min-h-11 [&_select]:min-w-11',
  '[&_[data-slot=native-select-wrapper]]:w-full [&_[data-slot=input-group]]:min-h-11',
  '[&_summary]:min-h-11 [&_summary]:min-w-11 [&_summary]:cursor-pointer [&_summary]:py-2',
  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:items-center',
  '[&_label]:whitespace-normal [&_label]:[overflow-wrap:anywhere]',
  '[&_:is(a,button,input,select,summary):focus-visible]:outline-2',
  '[&_:is(a,button,input,select,summary):focus-visible]:outline-offset-2',
  '[&_:is(a,button,input,select,summary):focus-visible]:outline-ring',
].join(' ');

type Snak = RelationDraft['qualifiers'][number];
type CompositionCloseDecision = { active: () => boolean; close: () => void };
type DraftTrigger = Pick<HTMLElement, 'ownerDocument' | 'isConnected' | 'focus'>;
export { QualifierInput };
type DraftDecisionBase = {
  draftRevision: number;
  readGeneration: number;
  read: RelationRead | undefined;
  field: object | undefined;
  draft: RelationDraft;
  editorActive: () => boolean;
  trigger: DraftTrigger;
};
type DraftDecisionSpec =
  | { kind: 'remove-qualifier'; qualifierId: number; qualifier: Snak }
  | { kind: 'replace-property'; propertyName: string; replacement: RelationDraft }
  | { kind: 'edit-existing'; statement: Candidate['statement']; replacement: RelationDraft };
type DraftDecision = DraftDecisionBase & DraftDecisionSpec;
type DraftFocusTarget =
  | { kind: 'trigger' }
  | { kind: 'property' }
  | { kind: 'qualifier'; identity: number }
  | { kind: 'add-qualifier' };
type DraftFocusIntent = {
  trigger: DraftTrigger;
  active: Element | null;
  target: DraftFocusTarget;
};
const blankDraft = (property: string): RelationDraft => ({
  property: { id: property, data_type: 'wikibase-item' },
  value: { type: 'somevalue' },
  qualifiers: [],
  references: [],
});

/** One contribution and exact-slot comparison; all mutations belong to explicit confirmation events. */
export const RelationEditor = catalogueEditor(RelationEditorLive);

function RelationEditorLive({
  id,
  locale,
  transport,
  search,
  initial,
  onSelected,
  onClose,
  onOpeningFocus,
  requireCloseConfirmation = false,
  composition,
  embedded = false,
  navigation,
  creditTargetHandoff,
  handoffReader,
  handoffReaderLive,
  onCreditTargetHandoffConsumed,
}: {
  id: string;
  locale: string;
  transport: RelationTransport;
  search: EntityPickerSearch;
  initial?: RelationRead;
  onSelected?: () => void | Promise<void>;
  onClose?: () => void;
  /** An explicit containing-page opening may orient to this admitted editor. */
  onOpeningFocus?: (heading: HTMLHeadingElement) => void;
  requireCloseConfirmation?: boolean;
  embedded?: boolean;
  /** A containing profile can compose the existing dirty/pending state into one decision. */
  navigation?: (state: Parameters<typeof RelationEditorNavigation>[0]) => ReactNode;
  creditTargetHandoff?: CreditTargetHandoff;
  handoffReader?: string;
  handoffReaderLive?: () => boolean;
  onCreditTargetHandoffConsumed?: (token: string) => void;
  /** A composition correction keeps every non-order qualifier and native slot key intact. */
  composition?: {
    statement: RelationDraft;
    slot?: RelationSlot;
    positionEditable: boolean;
    session?: string | undefined;
  };
}) {
  const mount = useEditorLifetime();
  const visible = useCurrentReadingVisible();
  const openingHeading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (visible && mount.active() && openingHeading.current) onOpeningFocus?.(openingHeading.current);
  }, [onOpeningFocus, visible, mount]);
  const draftRevision = useRef(0);
  const options = { locale: locale as never };
  const formId = useId();
  const [read, setRead] = useState(initial);
  const [draft, setDraft] = useState<RelationDraft>(() => structuredClone(composition?.statement ?? blankDraft('')));
  const initialProposal = useRef(JSON.stringify([composition?.statement ?? blankDraft(''), '']));
  const [slot, setSlot] = useState<RelationSlot | undefined>(composition?.slot);
  const [candidate, setCandidate] = useState<Candidate>();
  const [rank, setRank] = useState<'normal' | 'preferred'>('normal');
  const [citation, setCitation] = useState('');
  const [qualifierChoice, setQualifierChoice] = useState<{
    field: RelationField;
    definition: RelationQualifier;
  }>();
  const [qualifierHandoff, setQualifierHandoff] = useState(false);
  const qualifierAdmission = useRef<object | null>(null);
  const admission = {};
  qualifierAdmission.current = admission;
  const qualifierFocus = useRef<{
    snak: Snak;
    field: RelationField;
    origin: HTMLButtonElement;
    active: () => boolean;
    target?: HTMLDivElement;
    dispose: () => void;
  } | null>(null);
  const cancelQualifierFocus = () => {
    qualifierFocus.current?.dispose();
    qualifierFocus.current = null;
  };
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<CandidateFailure | undefined>(initial && !initial.ok ? initial : undefined);
  const [confirmation, setConfirmation] = useState<'propose' | 'accept' | 'reject' | 'adopt'>();
  const [closeConfirmation, setCloseConfirmation] = useState<CompositionCloseDecision>();
  const closeDecision = useRef<CompositionCloseDecision | undefined>(undefined);
  const [draftDecision, setDraftDecision] = useState<DraftDecision>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreCloseFocus = useRef(false);
  const draftDecisionRef = useRef<DraftDecision | undefined>(undefined);
  const draftDecisionPanel = useRef<HTMLDivElement>(null);
  const draftFocusIntent = useRef<DraftFocusIntent | undefined>(undefined);
  const qualifierIdentities = useRef(new WeakMap<object, number>());
  const nextQualifierIdentity = useRef(0);
  const qualifierRemoveButtons = useRef(new Map<number, HTMLButtonElement>());
  const candidatePageBoundary = useRef<HTMLElement>(null);
  const candidatePageEmpty = useRef<HTMLParagraphElement>(null);
  const candidateReadFailure = useRef<HTMLDivElement>(null);
  const openingControl = useRef<HTMLSelectElement>(null);
  const openingBoundary = useRef<HTMLParagraphElement>(null);
  const openingIntent = useRef<
    | {
        opener: HTMLButtonElement;
        active: () => boolean;
        generation: number;
      }
    | undefined
  >(undefined);
  const candidateReadFocus = useRef<
    | {
        opener: HTMLButtonElement;
        active: () => boolean;
        generation: number;
        outcome: 'boundary' | 'failure' | undefined;
      }
    | undefined
  >(undefined);
  const [result, setResult] = useState<Extract<RelationResult, { ok: true }>>();
  const [proposed, setProposed] = useState(false);
  const [proposedId, setProposedId] = useState<string>();
  const [ownConsent, setOwnConsent] = useState(false);
  const [consentEntry, setConsentEntry] = useState<ConsentAddress>();
  const [createdCreditIdentity, setCreatedCreditIdentity] = useState<CreatedCreditIdentity>();
  const restoredHandoff = useRef<string | undefined>(undefined);
  const nativeSession = useRef<string | undefined>(undefined);
  if (!nativeSession.current && composition?.session) nativeSession.current = composition.session;
  const request = useRef<RelationProposal | RelationConfirmation | undefined>(undefined);
  const proposalReplay = useRef(false);
  const pageCursor = useRef<string | undefined>(undefined);
  // Keep the attempted address before I/O, independently of the last successful page.
  const reading = useRef<
    { slot: RelationSlot | undefined; cursor: string | undefined; session: string | undefined } | undefined
  >(undefined);
  const readGeneration = useRef(0);
  const running = useRef(false);
  const proposedCandidate = useRef<string | undefined>(undefined);
  const picked = useRef<Record<string, EntityPickerSubject>>({});
  const wasVisible = useRef(visible);
  const resumeRead = useRef(false);
  if (wasVisible.current !== visible) {
    wasVisible.current = visible;
    if (!visible) {
      draftDecisionRef.current = undefined;
      setDraftDecision(undefined);
      draftFocusIntent.current = undefined;
      resumeRead.current = !!(read?.ok || reading.current);
      if (request.current && 'statement' in request.current) proposalReplay.current = true;
      readGeneration.current++;
      running.current = false;
      candidateReadFocus.current = undefined;
      openingIntent.current = undefined;
      setBusy(false);
      setRead(undefined);
      setCandidate(undefined);
      setResult(undefined);
      setConsentEntry(undefined);
      picked.current = {};
      setFailure(request.current ? { ok: false, reason: 'unavailable' } : undefined);
    }
  }
  useEffect(() => {
    if (!visible || !resumeRead.current) return;
    resumeRead.current = false;
    const destination = reading.current;
    void readPage(destination?.slot ?? slot, destination?.cursor, destination?.session);
  }, [visible]);
  const lifetime = useCatalogueLifetime(
    JSON.stringify([
      draftRevision.current,
      draft.property.id,
      draft.value,
      draft.qualifiers,
      candidate?.id,
      candidate?.head,
    ]),
    mount,
  );
  const remember = (items: EntityPickerSubject[]) => {
    if (!lifetime.active()) return;
    for (const item of items) picked.current[item.id] = item;
  };
  const current = read?.ok ? read : undefined;
  const field = current?.fields.find((field) => field.id === draft.property.id);
  useEffect(() => {
    const handoff = creditTargetHandoff;
    const identity = handoff?.identity;
    if (!handoff || !identity || restoredHandoff.current === handoff.token) return;
    if (!visible || !current?.descriptor || !mount.active()) return;
    const admittedField = current.fields.find((item) => item.id === handoff.propertyId);
    const sameTargets =
      !!admittedField &&
      JSON.stringify([...admittedField.targets].sort()) === JSON.stringify([...handoff.targets].sort());
    const valid =
      handoff.workId === id &&
      handoff.reader === handoffReader &&
      handoffReaderLive?.() === true &&
      handoff.context === candidateContext &&
      handoff.releaseDigest === current.descriptor.releaseDigest &&
      current.public.subject.id === id &&
      admittedField?.group === 'credit' &&
      sameTargets &&
      handoff.draft.property.id === admittedField.id &&
      handoff.draft.qualifiers.every((snak) =>
        admittedField.qualifiers.some(
          (definition) => definition.id === snak.property.id && definition.datatype === snak.property.data_type,
        ),
      ) &&
      handoff.admittedTypes.includes(identity.type) &&
      admittedField.targets.includes(identity.type) &&
      identity.id === handoff.createdId;
    restoredHandoff.current = handoff.token;
    if (!valid || !editable()) {
      discardCreditTargetHandoff(handoff.token);
      onCreditTargetHandoffConsumed?.(handoff.token);
      return;
    }
    edit(structuredClone(handoff.draft));
    setCitation(handoff.citation);
    setCreatedCreditIdentity(identity);
  }, [
    creditTargetHandoff,
    current,
    edit,
    editable,
    handoffReader,
    handoffReaderLive,
    id,
    mount,
    onCreditTargetHandoffConsumed,
    visible,
  ]);
  const qualifierAvailable = (definition: RelationQualifier) =>
    ['string', 'external-id', 'url', 'wikibase-item'].includes(definition.datatype) &&
    draft.qualifiers.length < 16 &&
    (!composition ||
      (composition.positionEditable &&
        definition.id === 'schema:position' &&
        !draft.qualifiers.some((part) => part.property.id === 'schema:position')));
  const qualifierDefinition =
    qualifierChoice && qualifierChoice.field === field
      ? field?.qualifiers.find(
          (item) =>
            item.id === qualifierChoice.definition.id &&
            item.datatype === qualifierChoice.definition.datatype &&
            qualifierAvailable(item),
        )
      : undefined;
  useLayoutEffect(() => {
    if (qualifierChoice && (!qualifierDefinition || !visible)) setQualifierChoice(undefined);
  }, [qualifierChoice, qualifierDefinition, visible]);
  useLayoutEffect(() => {
    const intent = qualifierFocus.current;
    cancelQualifierFocus();
    if (qualifierHandoff) setQualifierHandoff(false);
    if (
      !intent ||
      !visible ||
      !intent.active() ||
      !lifetime.active() ||
      intent.field !== field ||
      !draft.qualifiers.includes(intent.snak) ||
      !intent.origin.isConnected ||
      intent.origin.ownerDocument.activeElement !== intent.origin ||
      !intent.target?.isConnected
    )
      return;
    const control = intent.target.querySelector<HTMLElement>(
      'input:not(:disabled):not([readonly]):not([type="hidden"]), select:not(:disabled), button:not(:disabled)',
    );
    (control ?? intent.target).focus();
  });
  useLayoutEffect(() => cancelQualifierFocus, []);
  const admittedRead = useRef(read);
  admittedRead.current = read;
  const admittedField = useRef(field);
  admittedField.current = field;
  const admittedDraft = useRef(draft);
  admittedDraft.current = draft;
  const visibleNow = useRef(visible);
  visibleNow.current = visible;
  const publicRead = result?.public ?? current?.public;
  const concealed = failure?.reason === 'denied' && !current;
  const uncertain = failure?.reason === 'unavailable' && !!request.current;
  const nativeFrozen = busy || !!confirmation || uncertain || failure?.reason === 'stale';
  const nativeFrozenNow = useRef(nativeFrozen);
  nativeFrozenNow.current = nativeFrozen;
  const frozen = nativeFrozen || !!draftDecision;
  const name = (property: string) =>
    pickText(current?.names[property] ?? {}, locale).text || m.subject_value_unlabelled({}, options);
  const pinnedNames = (release: string | undefined) =>
    current && current.descriptor && release === current.descriptor.releaseDigest ? current.names : {};
  const pinnedName = (property: string, release: string | undefined) =>
    pickText(pinnedNames(release)[property] ?? {}, locale).text || property;
  const target = (value: unknown): EntityPickerSubject[] =>
    typeof value === 'string'
      ? [
          picked.current[value] ?? {
            id: value,
            title:
              pickText(current?.public.related[value]?.labels ?? {}, locale).text ||
              m.subject_value_unlabelled({}, options),
            types: [],
            typeLabel: '',
            cover: null,
          },
        ]
      : [];
  const selected =
    !!candidate &&
    !!slot &&
    !!field &&
    !!publicRead?.subject.statements[slot.property]?.some(
      (statement) =>
        statement.id === candidate.id && statement.rank !== 'deprecated' && relationSlotMatches(statement, slot, field),
    );
  const dirty = !proposed && JSON.stringify([draft, citation]) !== initialProposal.current;

  function retireCompositionClose() {
    closeDecision.current = undefined;
    restoreCloseFocus.current = false;
    setCloseConfirmation(undefined);
  }
  // The existing draft/reading lifetime also retires questions when their holder is replaced.
  if (closeConfirmation && !closeConfirmation.active()) retireCompositionClose();
  function compositionCloseLocked() {
    return (
      !lifetime.active() ||
      !visible ||
      !!request.current ||
      !!draftDecisionRef.current ||
      proposed ||
      !!result ||
      failure?.reason === 'stale'
    );
  }
  function requestCompositionClose() {
    if (!composition || !onClose || compositionCloseLocked()) return;
    if (dirty || requireCloseConfirmation) {
      if (closeDecision.current) return;
      const generation = readGeneration.current;
      const decision = {
        active: () => lifetime.active() && readGeneration.current === generation,
        close: onClose,
      };
      closeDecision.current = decision;
      setCloseConfirmation(decision);
    } else onClose();
  }
  function currentCompositionClose(decision: CompositionCloseDecision) {
    return closeDecision.current === decision && decision.active();
  }
  function confirmCompositionClose(decision: CompositionCloseDecision) {
    if (!currentCompositionClose(decision) || !composition || !onClose || compositionCloseLocked()) return;
    retireCompositionClose();
    decision.close();
  }
  function cancelCompositionClose(decision: CompositionCloseDecision) {
    if (!currentCompositionClose(decision)) return;
    retireCompositionClose();
    restoreCloseFocus.current = true;
  }
  useLayoutEffect(() => {
    if (restoreCloseFocus.current) {
      restoreCloseFocus.current = false;
      closeButton.current?.focus();
      candidateReadFocus.current = undefined;
      return;
    }
    const intent = candidateReadFocus.current;
    if (!intent) return;
    if (!visible || !intent.active() || readGeneration.current !== intent.generation) {
      candidateReadFocus.current = undefined;
      return;
    }
    if (busy || !intent.outcome) return;
    candidateReadFocus.current = undefined;
    const active = document.activeElement;
    // A still-focused native action remains a meaningful place to continue reading.
    if (active === intent.opener && intent.opener.isConnected && !intent.opener.disabled) return;
    if (active !== intent.opener && active !== document.body && active !== document.documentElement) return;
    if (intent.outcome === 'failure') candidateReadFailure.current?.focus();
    else if (read?.ok && read.page && !read.page.candidates.length) candidatePageEmpty.current?.focus();
    else (candidatePageBoundary.current ?? openingBoundary.current ?? openingControl.current)?.focus();
  }, [busy, closeConfirmation, read, failure, visible]);
  const closeLocked = compositionCloseLocked();

  // Removal of the action during I/O is expected; deliberate interaction permanently
  // cancels this read's handoff, even when the reader later returns to the action.
  useEffect(() => {
    const cancel = (event: Event) => {
      const intent = candidateReadFocus.current;
      if (intent && (event.type !== 'focusin' || event.target !== intent.opener))
        candidateReadFocus.current = undefined;
    };
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      candidateReadFocus.current = undefined;
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, [mount]);

  // The initial opener disappears while reading. Only its admitted keyboard intent
  // may orient to the result; candidate-page and composition opening keep their owners.
  useEffect(() => {
    const cancel = (event: Event) => {
      const intent = openingIntent.current;
      if (!intent) return;
      if (event.type !== 'focusin' || event.target !== intent.opener) openingIntent.current = undefined;
    };
    document.addEventListener('focusin', cancel, true);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      openingIntent.current = undefined;
      document.removeEventListener('focusin', cancel, true);
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, [mount]);
  useLayoutEffect(() => {
    const intent = openingIntent.current;
    if (!intent) return;
    if (!visible || !intent.active() || readGeneration.current !== intent.generation) {
      openingIntent.current = undefined;
      return;
    }
    if (busy) return;
    openingIntent.current = undefined;
    const active = document.activeElement;
    if (active !== intent.opener && active !== document.body && active !== document.documentElement) return;
    (failure ? candidateReadFailure.current : (openingBoundary.current ?? openingControl.current))?.focus();
  }, [busy, read, failure, visible, mount]);

  function open(event: MouseEvent<HTMLButtonElement>) {
    if (!lifetime.active() || running.current || uncertain) return;
    openingIntent.current =
      !composition && event.detail === 0 && event.currentTarget === document.activeElement
        ? { opener: event.currentTarget, active: lifetime.active, generation: readGeneration.current + 1 }
        : undefined;
    void load();
  }

  function editable() {
    return (
      lifetime.active() &&
      mount.active() &&
      visible &&
      !running.current &&
      !request.current &&
      !nativeFrozen &&
      !draftDecisionRef.current
    );
  }
  function addQualifier(event: MouseEvent<HTMLButtonElement>) {
    cancelQualifierFocus();
    if (
      qualifierAdmission.current !== admission ||
      !visible ||
      !editable() ||
      !field ||
      !qualifierDefinition ||
      !qualifierAvailable(qualifierDefinition)
    )
      return;
    const snak: Snak = {
      property: { id: qualifierDefinition.id, data_type: qualifierDefinition.datatype },
      value: { type: 'value', content: '' },
    };
    edit({ ...draft, qualifiers: [...draft.qualifiers, snak] });
    setQualifierChoice(undefined);
    const origin = event.currentTarget;
    if (event.detail !== 0 || origin.ownerDocument.activeElement !== origin) return;
    setQualifierHandoff(true);
    origin.addEventListener('focusout', cancelQualifierFocus);
    qualifierFocus.current = {
      snak,
      field,
      origin,
      active: mount.active,
      dispose: () => origin.removeEventListener('focusout', cancelQualifierFocus),
    };
  }
  function qualifierIdentity(snak: Snak) {
    let identity = qualifierIdentities.current.get(snak);
    if (identity === undefined) {
      identity = nextQualifierIdentity.current++;
      qualifierIdentities.current.set(snak, identity);
    }
    return identity;
  }

  function populatedValue(value: Snak['value']) {
    return value.type === 'value' ? String(value.content) !== '' : value.type !== 'somevalue';
  }

  function hasLocalDraftWork() {
    return (
      populatedValue(draft.value) ||
      draft.qualifiers.some((snak) => populatedValue(snak.value)) ||
      draft.references.some((reference) => reference.parts.some((snak) => populatedValue(snak.value))) ||
      citation !== '' ||
      ownConsent ||
      !!candidate ||
      rank !== 'normal'
    );
  }

  function decisionIsCurrent(decision: DraftDecision) {
    return (
      draftDecisionRef.current === decision &&
      decision.editorActive() &&
      mount.active() &&
      visibleNow.current &&
      !nativeFrozenNow.current &&
      !running.current &&
      !request.current &&
      decision.draftRevision === draftRevision.current &&
      decision.readGeneration === readGeneration.current &&
      decision.read === admittedRead.current &&
      decision.field === admittedField.current &&
      decision.draft === admittedDraft.current
    );
  }

  function requestDraftDecision(spec: DraftDecisionSpec, trigger: DraftTrigger) {
    if (!editable()) return;
    const decision: DraftDecision = {
      ...spec,
      draftRevision: draftRevision.current,
      readGeneration: readGeneration.current,
      read,
      field,
      draft,
      editorActive: () => lifetime.active(),
      trigger,
    };
    draftDecisionRef.current = decision;
    setDraftDecision(decision);
  }

  function finishDraftDecision(decision: DraftDecision, target: DraftFocusTarget, restore = true) {
    if (draftDecisionRef.current !== decision) return;
    const document = decision.trigger.ownerDocument;
    const active = document.activeElement;
    const insideDecision = !!draftDecisionPanel.current?.contains(active);
    if (restore && (active === (decision.trigger as unknown as Element) || insideDecision))
      draftFocusIntent.current = { trigger: decision.trigger, active, target };
    else draftFocusIntent.current = undefined;
    draftDecisionRef.current = undefined;
    setDraftDecision(undefined);
  }

  function cancelDraftDecision(decision: DraftDecision) {
    if (draftDecisionRef.current === decision) finishDraftDecision(decision, { kind: 'trigger' });
  }

  function draftSlot(next = draft): RelationSlot | undefined {
    if (!field || !next.property.id) return;
    if (next.value.type === 'value' && typeof next.value.content === 'string') {
      const key = field.slotKey && next.qualifiers.find((snak) => snak.property.id === field.slotKey);
      const address = {
        property: next.property.id,
        target: next.value.content,
        ...(key && key.value.type === 'value' ? { key: String(key.value.content) } : {}),
      };
      return validRelationSlot(address) ? address : undefined;
    }
    const external = next.qualifiers.find((snak) => snak.property.id === 'schema:sameAs');
    if (
      next.value.type === 'somevalue' &&
      external?.value.type === 'value' &&
      typeof external.value.content === 'string'
    )
      return { property: next.property.id, sameAs: external.value.content };
  }
  function edit(next: RelationDraft) {
    if (!editable()) return;
    applyEdit(next);
  }
  function createMissingCreditTarget() {
    if (
      !editable() ||
      !visible ||
      draft.value.type !== 'somevalue' ||
      field?.group !== 'credit' ||
      !current?.descriptor ||
      !handoffReader ||
      !handoffReaderLive?.()
    )
      return;
    const admittedTypes = creditIdentityTypes.filter((type) => field.targets.includes(type));
    if (!admittedTypes.length) return;
    const handoff = createCreditTargetHandoff({
      workId: id,
      reader: handoffReader,
      context: candidateContext,
      releaseDigest: current.descriptor.releaseDigest,
      propertyId: field.id,
      targets: [...field.targets],
      admittedTypes,
      draft: structuredClone(draft),
      citation,
    });
    if (!handoff) return;
    const query = new URLSearchParams({ work: id, creditHandoff: handoff.token });
    window.location.assign(`/${locale}/catalogue/people?${query.toString()}`);
  }
  function chooseCreatedCreditIdentity() {
    const identity = createdCreditIdentity;
    const handoff = creditTargetHandoff;
    if (
      !identity ||
      !handoff ||
      !editable() ||
      !visible ||
      !handoffReaderLive?.() ||
      handoff.reader !== handoffReader ||
      handoff.workId !== id ||
      handoff.propertyId !== field?.id ||
      handoff.createdId !== identity.id ||
      !handoff.admittedTypes.includes(identity.type) ||
      !field?.targets.includes(identity.type) ||
      draft.value.type !== 'somevalue'
    )
      return;
    picked.current[identity.id] = {
      id: identity.id,
      title: identity.label,
      types: [identity.type],
      typeLabel: identity.type,
      year: null,
      cover: null,
    };
    edit({ ...draft, value: { type: 'value', content: identity.id } });
    discardCreditTargetHandoff(handoff.token);
    setCreatedCreditIdentity(undefined);
    onCreditTargetHandoffConsumed?.(handoff.token);
  }
  function applyEdit(next: RelationDraft) {
    if (draftDecisionRef.current) {
      draftDecisionRef.current = undefined;
      setDraftDecision(undefined);
      draftFocusIntent.current = undefined;
    }
    retireCompositionClose();
    lifetime.retire();
    draftRevision.current++;
    running.current = false;
    setBusy(false);
    nativeSession.current = undefined;
    setDraft(next);
    setOwnConsent(false);
    setConsentEntry(undefined);
    setRead((previous) => (previous?.ok ? { ...previous, page: null } : previous));
    setSlot(undefined);
    setCandidate(undefined);
    setResult(undefined);
    setProposed(false);
    setProposedId(undefined);
    proposedCandidate.current = undefined;
    setFailure(undefined);
    request.current = undefined;
    proposalReplay.current = false;
    pageCursor.current = undefined;
    reading.current = undefined;
    candidateReadFocus.current = undefined;
    readGeneration.current++;
  }

  function commitQualifierRemoval(identity: number) {
    const index = draft.qualifiers.findIndex((snak) => qualifierIdentity(snak) === identity);
    if (index < 0) return;
    const remaining = draft.qualifiers.filter((_, at) => at !== index);
    const adjacent = draft.qualifiers[index + 1] ?? draft.qualifiers[index - 1];
    const focusTarget: DraftFocusTarget = adjacent
      ? { kind: 'qualifier', identity: qualifierIdentity(adjacent) }
      : { kind: 'add-qualifier' };
    const decision = draftDecisionRef.current;
    if (decision?.kind === 'remove-qualifier' && decision.qualifierId === identity)
      finishDraftDecision(decision, focusTarget);
    applyEdit({ ...draft, qualifiers: remaining });
  }

  function confirmDraftDecision(decision: DraftDecision) {
    if (draftDecisionRef.current !== decision) return;
    if (!decisionIsCurrent(decision)) {
      finishDraftDecision(decision, { kind: 'property' });
      return;
    }
    if (decision.kind === 'remove-qualifier') {
      commitQualifierRemoval(decision.qualifierId);
      return;
    }
    finishDraftDecision(decision, { kind: 'property' });
    applyEdit(decision.replacement);
    setCitation('');
  }

  useLayoutEffect(() => {
    if (draftDecision && !decisionIsCurrent(draftDecision)) finishDraftDecision(draftDecision, { kind: 'property' });
    if (draftDecision || !draftFocusIntent.current) return;
    const intent = draftFocusIntent.current;
    draftFocusIntent.current = undefined;
    if (!visible || !mount.active()) return;
    const document = intent.trigger.ownerDocument;
    const active = document.activeElement;
    if (active !== intent.active && active !== document.body) return;
    let target: DraftTrigger | null = null;
    if (intent.target.kind === 'trigger') target = intent.trigger.isConnected ? intent.trigger : null;
    else if (intent.target.kind === 'qualifier')
      target = qualifierRemoveButtons.current.get(intent.target.identity) ?? null;
    else if (intent.target.kind === 'add-qualifier') target = document.getElementById(`${formId}-add-qualifier`);
    else target = document.getElementById(`${formId}-property`);
    (target ?? document.getElementById(`${formId}-property`))?.focus();
  }, [draftDecision, draft, read, field, visible, nativeFrozen, mount, formId]);

  function failed(next: CandidateFailure) {
    setFailure(next);
    if (next.reason !== 'denied') return;
    setConfirmation(undefined);
    if (request.current) {
      request.current = undefined;
      proposalReplay.current = false;
      return;
    }
    setRead(undefined);
    setCandidate(undefined);
    setResult(undefined);
    setConsentEntry(undefined);
    setProposedId(undefined);
    picked.current = {};
    proposedCandidate.current = undefined;
  }
  async function readPage(
    address?: RelationSlot,
    cursor?: string,
    session?: string,
    proposedId?: string,
    event?: MouseEvent<HTMLButtonElement>,
  ) {
    retireCompositionClose();
    const generation = ++readGeneration.current;
    const intent =
      event?.detail === 0 && event.currentTarget === document.activeElement
        ? {
            opener: event.currentTarget,
            active: mount.active,
            generation,
            outcome: undefined as 'boundary' | 'failure' | undefined,
          }
        : undefined;
    candidateReadFocus.current = intent;
    const orient = (outcome: 'boundary' | 'failure') => {
      if (intent && candidateReadFocus.current === intent) intent.outcome = outcome;
    };
    const destination = { slot: address && { ...address }, cursor, session };
    reading.current = destination;
    // A previous page is never fresh authority after another read starts or fails.
    setRead((previous) => (previous?.ok ? { ...previous, page: null } : undefined));
    setCandidate(undefined);
    setResult(undefined);
    setConsentEntry(undefined);
    pageCursor.current = undefined;
    const active = () => mount.active() && readGeneration.current === generation;
    try {
      const next = await transport.read(destination.slot, destination.cursor, destination.session);
      if (!active()) return;
      if (!next.ok) {
        orient('failure');
        failed(next);
        return;
      }
      orient('boundary');
      nativeSession.current = next.session ?? nativeSession.current;
      setRead(next);
      pageCursor.current = cursor;
      setSlot(destination.slot);
      if (proposedId) setCandidate(next.page?.candidates.find((item) => item.id === proposedId));
    } catch {
      if (active()) {
        orient('failure');
        failed({ ok: false, reason: 'unavailable' });
      }
    }
  }
  async function load(
    address = slot,
    cursor?: string,
    session = nativeSession.current,
    event?: MouseEvent<HTMLButtonElement>,
  ) {
    if (!lifetime.active() || running.current || uncertain) return;
    running.current = true;
    setBusy(true);
    setSlot(address);
    setFailure(undefined);
    setConfirmation(undefined);
    request.current = undefined;
    try {
      await readPage(address, cursor, session, proposedCandidate.current, event);
    } finally {
      if (mount.active()) {
        setBusy(false);
        running.current = false;
      }
    }
  }
  function reload(event?: MouseEvent<HTMLButtonElement>) {
    const destination = reading.current;
    void load(destination?.slot ?? slot, destination?.cursor, destination?.session ?? nativeSession.current, event);
  }
  async function confirm() {
    if (!lifetime.active()) return;
    if (running.current || !confirmation || !field) return;
    const address = confirmation === 'propose' ? draftSlot() : slot;
    if (!address || (!request.current && !candidate && confirmation !== 'propose')) return;
    const reused = !!request.current;
    request.current ??=
      confirmation === 'propose'
        ? { id, slot: address, statement: structuredClone(draft), key: crypto.randomUUID() }
        : {
            id,
            slot: address,
            candidate: candidate!.id,
            operation: confirmation,
            head: confirmation !== 'adopt' ? candidate!.head : (current?.page?.adoption?.head ?? null),
            rank,
            ...(pageCursor.current ? { cursor: pageCursor.current } : {}),
            ...(nativeSession.current ? { session: nativeSession.current } : {}),
            key: crypto.randomUUID(),
          };
    if (!reused) proposalReplay.current = false;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      const pending = request.current;
      if ('statement' in pending) {
        const next = await transport.propose(proposalReplay.current ? { ...pending, retry: true } : pending);
        if (!lifetime.active()) return;
        if (!next.ok) {
          if (next.retry) proposalReplay.current = true;
          failed(next);
          return;
        }
        setProposed(true);
        setProposedId(next.candidate);
        proposedCandidate.current = next.candidate;
        nativeSession.current = next.session ?? nativeSession.current;
        if (field.disclosure === 'sourceOrConsent' && !pending.statement.references.length)
          setConsentEntry(
            consentAddress({
              id,
              candidate: next.candidate,
              property: address.property,
              slot: { target: address.target, sameAs: address.sameAs, key: address.key },
            }),
          );
        setSlot(address);
        setConfirmation(undefined);
        request.current = undefined;
        proposalReplay.current = false;
        await readPage(address, undefined, nativeSession.current, next.candidate);
      } else {
        const next = await transport.confirm(pending);
        if (!lifetime.active()) return;
        if (!next.ok) {
          failed(next);
          return;
        }
        setResult(next);
        if ('session' in next) nativeSession.current = next.session ?? nativeSession.current;
        setConfirmation(undefined);
        request.current = undefined;
        if (next.kind === 'selected') await onSelected?.();
        if (!lifetime.active()) return;
      }
    } catch {
      if (!lifetime.active()) return;
      if (request.current && 'statement' in request.current) proposalReplay.current = true;
      failed({ ok: false, reason: 'unavailable' });
    } finally {
      if (!mount.active()) return;
      setBusy(false);
      running.current = false;
    }
  }
  const failureText =
    failure &&
    {
      denied: m.candidate_denied({}, options),
      stale: m.relation_stale({}, options),
      invalid: m.candidate_invalid({}, options),
      unavailable: m.candidate_unavailable({}, options),
    }[failure.reason];
  const action =
    confirmation === 'propose'
      ? m.relation_propose({}, options)
      : confirmation === 'accept'
        ? m.candidate_accept({}, options)
        : confirmation === 'reject'
          ? m.relation_reject({}, options)
          : m.candidate_adopt({}, options);
  const draftDecisionAction =
    draftDecision?.kind === 'remove-qualifier'
      ? m.relation_remove({}, options)
      : draftDecision?.kind === 'edit-existing'
        ? m.relation_edit_existing({}, options)
        : m.work_parts_draft_discard({}, options);
  const navigationState = { dirty, pending: !!request.current, isCurrent: () => lifetime.active() };
  const departure = navigation?.(navigationState);
  const content = visible ? (
    <section aria-label={m.relation_title({}, options)} className={relationSurface} aria-busy={busy}>
      <header className="space-y-2">
        {composition ? (
          <h2
            ref={openingHeading}
            tabIndex={onOpeningFocus ? -1 : undefined}
            data-content-item-slot="title"
            className="font-sans text-2xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.relation_title({}, options)}
          </h2>
        ) : (
          <>{!embedded && <h1 className="text-2xl font-semibold">{m.relation_title({}, options)}</h1>}</>
        )}
        <p className="text-sm text-muted-foreground">{m.relation_intro({}, options)}</p>
        {composition && onClose && (
          <Button ref={closeButton} variant="outline" disabled={closeLocked} onClick={requestCompositionClose}>
            {m.work_parts_draft_close({}, options)}
          </Button>
        )}
      </header>
      {closeConfirmation && composition && onClose && (
        <ContentItemFrame
          as="div"
          role="group"
          aria-labelledby={`${formId}-close-title`}
          className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5"
        >
          <ContentItemHeading id={`${formId}-close-title`} level={2} className="font-semibold">
            {m.candidate_confirm_title({ action: m.work_parts_draft_discard({}, options) }, options)}
          </ContentItemHeading>
          <p>{m.work_parts_draft_discard_confirmation({}, options)}</p>
          {closeLocked && <p role="status">{m.work_parts_draft_discard_locked({}, options)}</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={closeLocked} onClick={() => confirmCompositionClose(closeConfirmation)}>
              {m.work_parts_draft_discard({}, options)}
            </Button>
            <Button variant="outline" onClick={() => cancelCompositionClose(closeConfirmation)}>
              {m.candidate_cancel({}, options)}
            </Button>
          </div>
        </ContentItemFrame>
      )}
      {draftDecision && !concealed && (
        <div ref={draftDecisionPanel}>
          <ContentItemFrame
            as="div"
            role="group"
            aria-labelledby={`${formId}-draft-decision-title`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelDraftDecision(draftDecision);
              }
            }}
            className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5"
          >
            <ContentItemHeading id={`${formId}-draft-decision-title`} level={2} className="font-semibold">
              {m.candidate_confirm_title({ action: draftDecisionAction }, options)}
            </ContentItemHeading>
            {draftDecision.kind === 'remove-qualifier' ? (
              <>
                <p>{name(draftDecision.qualifier.property.id)}</p>
                {current && (
                  <CandidateValue snak={draftDecision.qualifier} related={current.public.related} locale={locale} />
                )}
              </>
            ) : (
              <>
                <p>{m.work_parts_draft_discard_confirmation({}, options)}</p>
                {draftDecision.kind === 'replace-property' ? (
                  <p>{draftDecision.propertyName}</p>
                ) : (
                  current && (
                    <Statement
                      statement={draftDecision.statement}
                      publicRead={current.public}
                      names={current.names}
                      locale={locale}
                    />
                  )
                )}
              </>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={nativeFrozen || !decisionIsCurrent(draftDecision)}
                onClick={() => confirmDraftDecision(draftDecision)}
              >
                {draftDecisionAction}
              </Button>
              <Button variant="outline" disabled={nativeFrozen} onClick={() => cancelDraftDecision(draftDecision)}>
                {m.candidate_cancel({}, options)}
              </Button>
            </div>
          </ContentItemFrame>
        </div>
      )}
      {consentEntry && (
        <StatementConsentLink
          address={consentEntry}
          label={pickText(current?.public.subject.labels ?? {}, locale).text}
          locale={locale}
        />
      )}
      {busy && <p role="status">{m.candidate_loading({}, options)}</p>}
      {failureText && (
        <div
          ref={candidateReadFailure}
          role="alert"
          tabIndex={-1}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ContentItemFrame as="div" className="min-w-0 rounded-xl bg-muted/30 p-4">
            <p>{failureText}</p>
          </ContentItemFrame>
        </div>
      )}
      {!current && !reading.current && !busy && <Button onClick={open}>{m.relation_open({}, options)}</Button>}
      {current && current.public.subject.context !== candidateContext ? (
        <p
          ref={openingBoundary}
          tabIndex={-1}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.relation_context({}, options)}
        </p>
      ) : (
        current &&
        !concealed && (
          <>
            {!current.fields.length ? (
              <p
                ref={openingBoundary}
                tabIndex={-1}
                className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {m.relation_no_fields({}, options)}
              </p>
            ) : (
              <>
                <ContentItemFrame as="div" className="min-w-0 rounded-xl bg-card p-4 sm:p-5">
                  <fieldset disabled={frozen} className="min-w-0 space-y-4">
                    <legend className="mb-4 px-1">
                      <ContentItemHeading level={2} className="text-lg font-semibold">
                        {m.relation_draft({}, options)}
                      </ContentItemHeading>
                    </legend>
                    <Field>
                      <FieldLabel htmlFor={`${formId}-property`}>{m.relation_property({}, options)}</FieldLabel>
                      <DefinitionGuideLink
                        locale={locale}
                        field={!!field}
                        address={{
                          type: current.public.subject.type,
                          property: field?.id,
                          ...(candidate?.release ? { release: candidate.release } : {}),
                          returnTo: `${subjectHref({ id, label: pickText(current.public.subject.labels, locale).text }, locale).href}/relation-edit`,
                        }}
                      />
                      <NativeSelect
                        ref={openingControl}
                        id={`${formId}-property`}
                        disabled={!!composition}
                        value={draft.property.id}
                        onChange={(event) => {
                          if (!editable()) return;
                          const property = event.target.value;
                          const replacement = blankDraft(property);
                          if (hasLocalDraftWork())
                            requestDraftDecision(
                              {
                                kind: 'replace-property',
                                propertyName: current.fields.find((item) => item.id === property)?.label ?? property,
                                replacement,
                              },
                              event.currentTarget,
                            );
                          else {
                            edit(replacement);
                            setCitation('');
                          }
                        }}
                      >
                        <NativeSelectOption value="">{m.candidate_choose_field({}, options)}</NativeSelectOption>
                        {current.fields.map((item) => (
                          <NativeSelectOption key={item.id} value={item.id}>
                            {item.label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </Field>
                    {field && (
                      <>
                        {!composition && (
                          <>
                            {!!current.public.subject.statements[field.id]?.length && (
                              <div className="space-y-2">
                                <p className="text-sm font-medium">{m.relation_existing({}, options)}</p>
                                {current.public.subject.statements[field.id]!.map((statement) => (
                                  <ContentItemFrame
                                    key={statement.id}
                                    as="div"
                                    className="min-w-0 space-y-3 rounded-xl bg-muted/30 p-3 sm:p-4"
                                  >
                                    <ContentItemHeading level={3} className="text-base font-semibold">
                                      {name(statement.property.id)}
                                    </ContentItemHeading>
                                    <Statement
                                      statement={statement}
                                      publicRead={current.public}
                                      names={current.names}
                                      locale={locale}
                                    />
                                    <Button
                                      variant="outline"
                                      onClick={(event) => {
                                        if (!editable()) return;
                                        const replacement = relationDraft(statement);
                                        if (hasLocalDraftWork())
                                          requestDraftDecision(
                                            { kind: 'edit-existing', statement, replacement },
                                            event.currentTarget,
                                          );
                                        else {
                                          edit(replacement);
                                          setCitation('');
                                        }
                                      }}
                                    >
                                      {m.relation_edit_existing({}, options)}
                                    </Button>
                                  </ContentItemFrame>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                        <Field className="gap-2">
                          <FieldTitle>{m.relation_target({}, options)}</FieldTitle>
                          <EntityPicker
                            label={m.relation_target({}, options)}
                            search={search}
                            src={coverSrc}
                            disabled={frozen}
                            {...(composition ? { disabled: true } : {})}
                            value={draft.value.type === 'value' ? target(draft.value.content) : []}
                            onValueChange={(items) => {
                              if (!editable()) return;
                              remember(items);
                              edit({
                                ...draft,
                                value: items[0] ? { type: 'value', content: items[0].id } : { type: 'somevalue' },
                              });
                            }}
                          />
                          {createdCreditIdentity && draft.value.type === 'somevalue' && (
                            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                              <p>
                                {createdCreditIdentity.label} · {createdCreditIdentity.type} ·{' '}
                                <code className="break-all">{createdCreditIdentity.id}</code>
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={!editable() || !handoffReaderLive?.()}
                                onClick={chooseCreatedCreditIdentity}
                              >
                                {m.relation_use_created_target({ label: createdCreditIdentity.label }, options)}
                              </Button>
                            </div>
                          )}
                          {!createdCreditIdentity &&
                            draft.value.type === 'somevalue' &&
                            field?.group === 'credit' &&
                            !!current?.descriptor &&
                            !!handoffReader &&
                            !!handoffReaderLive?.() &&
                            creditIdentityTypes.some((type) => field.targets.includes(type)) && (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={!editable()}
                                onClick={createMissingCreditTarget}
                              >
                                {m.relation_create_credit_target({}, options)}
                              </Button>
                            )}
                        </Field>
                        {draft.value.type === 'somevalue' && (
                          <p className="text-sm">{m.relation_unresolved({}, options)}</p>
                        )}
                        <div className="space-y-3">
                          {draft.qualifiers.map((snak, index) => {
                            const identity = qualifierIdentity(snak);
                            return (
                              <div
                                key={identity}
                                ref={(node) => {
                                  if (node && qualifierFocus.current?.snak === snak)
                                    qualifierFocus.current.target = node;
                                }}
                                role="group"
                                aria-label={name(snak.property.id)}
                                tabIndex={-1}
                                className="flex min-w-0 items-end gap-2 focus-visible:outline-2 focus-visible:outline-ring"
                              >
                                <div className="min-w-0 flex-1">
                                  <fieldset
                                    disabled={
                                      !!composition &&
                                      (!composition.positionEditable ||
                                        snak.property.id !== 'schema:position' ||
                                        !field.qualifiers.some((item) => item.id === 'schema:position'))
                                    }
                                  >
                                    <QualifierInput
                                      definition={field.qualifiers.find((item) => item.id === snak.property.id)}
                                      snak={snak}
                                      index={identity}
                                      label={name(snak.property.id)}
                                      scope={formId}
                                      search={search}
                                      target={target}
                                      remember={remember}
                                      disabled={frozen}
                                      onChange={(value) => {
                                        const qualifiers = draft.qualifiers.map((item, at) => {
                                          if (at !== index) return item;
                                          const changed = { ...item, value };
                                          qualifierIdentities.current.set(changed, identity);
                                          return changed;
                                        });
                                        edit({ ...draft, qualifiers });
                                      }}
                                    />
                                  </fieldset>
                                </div>
                                <Button
                                  variant="outline"
                                  disabled={!!composition}
                                  ref={(node) => {
                                    if (node) qualifierRemoveButtons.current.set(identity, node);
                                    else qualifierRemoveButtons.current.delete(identity);
                                  }}
                                  aria-label={`${m.relation_remove({}, options)}: ${name(snak.property.id)}`}
                                  onClick={(event) => {
                                    if (!editable() || composition) return;
                                    if (populatedValue(snak.value))
                                      requestDraftDecision(
                                        { kind: 'remove-qualifier', qualifierId: identity, qualifier: snak },
                                        event.currentTarget,
                                      );
                                    else commitQualifierRemoval(identity);
                                  }}
                                >
                                  {m.relation_remove({}, options)}
                                </Button>
                              </div>
                            );
                          })}
                          <Field>
                            <FieldLabel htmlFor={`${formId}-add-qualifier`}>
                              {m.relation_qualifier({}, options)}
                            </FieldLabel>
                            <NativeSelect
                              id={`${formId}-add-qualifier`}
                              disabled={!field.qualifiers.some(qualifierAvailable)}
                              value={qualifierDefinition?.id ?? ''}
                              onChange={(event) => {
                                if (qualifierAdmission.current !== admission || !visible || !editable()) return;
                                const definition = field.qualifiers.find(
                                  (item) => item.id === event.target.value && qualifierAvailable(item),
                                );
                                setQualifierChoice(definition ? { field, definition } : undefined);
                              }}
                            >
                              <NativeSelectOption value="">{m.relation_add_qualifier({}, options)}</NativeSelectOption>
                              {field.qualifiers.filter(qualifierAvailable).map((item) => (
                                <NativeSelectOption key={item.id} value={item.id}>
                                  {item.label}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={!qualifierDefinition && !qualifierHandoff}
                              onClick={addQualifier}
                            >
                              {m.relation_add_qualifier({}, options)}
                            </Button>
                          </Field>
                        </div>
                        {!!draft.references.length && (
                          <div className="space-y-2">
                            <p className="text-sm font-medium">{m.candidate_source({}, options)}</p>
                            {draft.references.map((reference, index) => (
                              <div key={index}>
                                {reference.parts.map((snak, at) => (
                                  <CandidateValue
                                    key={at}
                                    snak={snak}
                                    related={current.public.related}
                                    locale={locale}
                                  />
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                        <Field>
                          <FieldLabel htmlFor={`${formId}-citation`}>{m.relation_citation({}, options)}</FieldLabel>
                          <Input
                            id={`${formId}-citation`}
                            type="url"
                            value={citation}
                            onChange={(event) => editable() && setCitation(event.target.value)}
                          />
                        </Field>
                        {field.disclosure === 'sourceOrConsent' && !draft.references.length && (
                          <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">
                              {m.statement_consent_unsourced({}, options)}
                            </p>
                            <Field orientation="horizontal">
                              <Checkbox
                                className="size-11"
                                id={`${formId}-own-consent`}
                                checked={ownConsent}
                                onCheckedChange={(checked) => editable() && setOwnConsent(checked === true)}
                              />
                              <FieldLabel htmlFor={`${formId}-own-consent`}>
                                {m.statement_consent_own({}, options)}
                              </FieldLabel>
                            </Field>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            disabled={!/^https?:\/\/\S+$/.test(citation)}
                            onClick={() => {
                              if (!editable()) return;
                              edit({
                                ...draft,
                                references: [
                                  ...draft.references,
                                  {
                                    parts: [
                                      {
                                        property: { id: 'schema:url', data_type: 'url' },
                                        value: { type: 'value', content: citation },
                                      },
                                    ],
                                  },
                                ],
                              });
                              setCitation('');
                            }}
                          >
                            {m.relation_add_citation({}, options)}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={!draftSlot()}
                            onClick={() => (slot ? reload() : load(draftSlot()))}
                          >
                            {m.relation_review_slot({}, options)}
                          </Button>
                          <Button
                            disabled={
                              !draftSlot() ||
                              (!draft.references.length && !(field.disclosure === 'sourceOrConsent' && ownConsent)) ||
                              proposed
                            }
                            onClick={() => editable() && setConfirmation('propose')}
                          >
                            {m.relation_propose({}, options)}
                          </Button>
                        </div>
                      </>
                    )}
                    {composition && !field && <p role="status">{m.work_parts_not_admitted({}, options)}</p>}
                  </fieldset>
                </ContentItemFrame>
                {slot && field && current.page && (
                  <section
                    ref={candidatePageBoundary}
                    tabIndex={-1}
                    className="space-y-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={m.relation_review_slot({}, options)}
                  >
                    <ContentItemHeading level={2} className="text-lg font-semibold">
                      {m.relation_review_slot({}, options)}
                    </ContentItemHeading>
                    {publicRead?.subject.resolution[slot.property] === 'unresolved' && (
                      <p>{m.relation_unresolved_selection({}, options)}</p>
                    )}
                    <p className="text-sm text-muted-foreground">{m.relation_slot_hint({}, options)}</p>
                    <p className="text-sm [overflow-wrap:anywhere]">
                      {id} · {slot.property} · {slot.target ?? slot.sameAs} {slot.key ?? ''}
                    </p>
                    {!current.page.candidates.length && (
                      <p
                        ref={candidatePageEmpty}
                        role="status"
                        tabIndex={-1}
                        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {m.candidate_empty({}, options)}
                      </p>
                    )}
                    <ul className="space-y-3">
                      {current.page.candidates.map((item) => (
                        <li key={item.id}>
                          <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5">
                            <ContentItemHeading level={3} className="text-base font-semibold">
                              {pinnedName(item.statement.property.id, item.release)}
                            </ContentItemHeading>
                            <Statement
                              statement={item.statement}
                              publicRead={current.public}
                              names={pinnedNames(item.release)}
                              locale={locale}
                            />
                            <p>
                              {item.decision === 'accepted'
                                ? m.relation_accepted({}, options)
                                : item.decision === 'rejected'
                                  ? m.relation_rejected({}, options)
                                  : m.relation_unreviewed({}, options)}
                              {item.rank && item.rank !== 'deprecated'
                                ? ` · ${item.rank === 'preferred' ? m.relation_preferred({}, options) : m.relation_normal({}, options)}`
                                : ''}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {item.source && 'source' in item.source
                                ? m.candidate_provenance({}, options)
                                : m.candidate_editorial({}, options)}
                            </p>
                            {item.source && 'source' in item.source && (
                              <details>
                                <summary>{m.candidate_provenance({}, options)}</summary>
                                <p>
                                  {item.source.source} · {item.source.external_id}
                                </p>
                                <p>
                                  {m.candidate_source_revision({}, options)}: {item.source.record_revision}
                                </p>
                                <p>
                                  {m.candidate_converter({}, options)}: {item.source.converter_revision}
                                </p>
                              </details>
                            )}
                            <Button
                              variant="outline"
                              disabled={frozen || item.retracted !== null || item.rank === 'deprecated'}
                              onClick={() => {
                                if (!editable()) return;
                                if (candidate?.id !== item.id || candidate?.head !== item.head) {
                                  lifetime.retire();
                                  draftRevision.current++;
                                }
                                setCandidate(item);
                                setResult(undefined);
                                setFailure(undefined);
                                request.current = undefined;
                              }}
                            >
                              {item.retracted !== null
                                ? m.candidate_retracted({}, options)
                                : item.rank === 'deprecated'
                                  ? m.relation_deprecated({}, options)
                                  : m.candidate_review({}, options)}
                            </Button>
                          </ContentItemFrame>
                        </li>
                      ))}
                    </ul>
                    {current.page.next && (
                      <Button
                        variant="outline"
                        disabled={frozen}
                        onClick={(event) => load(slot, current.page!.next!, nativeSession.current, event)}
                      >
                        {m.candidate_more({}, options)}
                      </Button>
                    )}
                    {candidate &&
                      field.disclosure === 'sourceOrConsent' &&
                      !candidate.statement.references.length &&
                      candidate.retracted === null && (
                        <StatementConsentLink
                          address={{ id, property: field.id, candidate: candidate.id, ...(slot ? { slot } : {}) }}
                          label={pickText(current.public.subject.labels, locale).text}
                          locale={locale}
                        />
                      )}
                    {candidate && (
                      <div className="space-y-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          <section className="min-w-0">
                            <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-muted p-4">
                              <ContentItemHeading level={3} className="font-semibold">
                                {m.candidate_current({}, options)}
                              </ContentItemHeading>
                              {publicRead?.subject.statements[slot.property]?.filter((item) =>
                                relationSlotMatches(item, slot, field),
                              ).length ? (
                                publicRead.subject.statements[slot.property]!.filter((item) =>
                                  relationSlotMatches(item, slot, field),
                                ).map((item) => (
                                  <Statement
                                    key={item.id}
                                    statement={item}
                                    publicRead={publicRead}
                                    names={pinnedNames(item.rezics?.release)}
                                    locale={locale}
                                  />
                                ))
                              ) : (
                                <p>{m.candidate_no_current({}, options)}</p>
                              )}
                            </ContentItemFrame>
                          </section>
                          <section className="min-w-0">
                            <ContentItemFrame as="div" className="min-w-0 space-y-3 rounded-xl bg-card p-4">
                              <ContentItemHeading level={3} className="font-semibold">
                                {m.candidate_proposed({}, options)}
                              </ContentItemHeading>
                              <Statement
                                statement={candidate.statement}
                                publicRead={current.public}
                                names={pinnedNames(candidate.release)}
                                locale={locale}
                              />
                            </ContentItemFrame>
                          </section>
                        </div>
                        {selected ? (
                          <p role="status">{m.candidate_selected({}, options)}</p>
                        ) : result ? (
                          <p role="status">
                            {result.kind === 'accepted'
                              ? m.candidate_accepted({}, options)
                              : result.kind === 'rejected'
                                ? m.relation_rejected({}, options)
                                : m.candidate_pending({}, options)}
                          </p>
                        ) : (
                          !confirmation && (
                            <>
                              {candidate.decision === 'accepted' && (
                                <Field>
                                  <FieldLabel htmlFor={`${formId}-rank`}>{m.relation_rank({}, options)}</FieldLabel>
                                  <NativeSelect
                                    id={`${formId}-rank`}
                                    value={rank}
                                    disabled={frozen}
                                    onChange={(event) =>
                                      editable() && setRank(event.target.value as 'normal' | 'preferred')
                                    }
                                  >
                                    <NativeSelectOption value="normal">
                                      {m.relation_normal({}, options)}
                                    </NativeSelectOption>
                                    <NativeSelectOption value="preferred">
                                      {m.relation_preferred({}, options)}
                                    </NativeSelectOption>
                                  </NativeSelect>
                                </Field>
                              )}
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  className="min-h-11"
                                  disabled={frozen || candidate.retracted !== null}
                                  onClick={() =>
                                    editable() &&
                                    setConfirmation(candidate.decision === 'accepted' ? 'adopt' : 'accept')
                                  }
                                >
                                  {candidate.decision === 'accepted'
                                    ? m.candidate_adopt({}, options)
                                    : m.candidate_accept({}, options)}
                                </Button>
                                {candidate.decision !== 'rejected' && (
                                  <Button
                                    className="min-h-11"
                                    variant="outline"
                                    disabled={frozen}
                                    onClick={() => editable() && setConfirmation('reject')}
                                  >
                                    {m.relation_reject({}, options)}
                                  </Button>
                                )}
                              </div>
                            </>
                          )
                        )}
                        {selected && publicRead && (
                          <a
                            className="text-primary underline"
                            href={
                              subjectHref({ id, label: pickText(publicRead.subject.labels, locale).text }, locale).href
                            }
                          >
                            {m.candidate_view_public({}, options)}
                          </a>
                        )}
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </>
        )
      )}
      {proposed && <p role="status">{m.relation_proposed({}, options)}</p>}
      {composition && proposedId && (
        <p className="break-all text-sm">{m.work_parts_candidate({ candidate: proposedId }, options)}</p>
      )}
      {confirmation && !concealed && (
        <ContentItemFrame
          as="div"
          role="group"
          aria-label={m.candidate_confirm_title({ action }, options)}
          className="min-w-0 space-y-3 rounded-xl bg-card p-4 sm:p-5"
        >
          <ContentItemHeading level={2} className="font-semibold">
            {m.candidate_confirm_title({ action }, options)}
          </ContentItemHeading>
          <p>
            {confirmation === 'adopt'
              ? m.relation_confirm_adopt({}, options)
              : confirmation === 'accept'
                ? m.candidate_confirm_accept({}, options)
                : confirmation === 'reject'
                  ? m.relation_confirm_reject({}, options)
                  : m.relation_confirm_propose({}, options)}
          </p>
          {confirmation === 'propose' && current && (
            <Statement statement={draft} publicRead={current.public} names={current.names} locale={locale} />
          )}
          {confirmation !== 'propose' && candidate && current && (
            <Statement
              statement={candidate.statement}
              publicRead={current.public}
              names={pinnedNames(candidate.release)}
              locale={locale}
            />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={busy || (!!failure && failure.reason !== 'unavailable')}
              onClick={confirm}
            >
              {action}
            </Button>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy || !!request.current}
              onClick={() => lifetime.active() && !running.current && !request.current && setConfirmation(undefined)}
            >
              {m.candidate_cancel({}, options)}
            </Button>
          </div>
        </ContentItemFrame>
      )}
      {(current || reading.current) && !uncertain && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={reload}>
            {failure && reading.current ? m.statement_consent_retry_page({}, options) : m.candidate_reload({}, options)}
          </Button>
          {reading.current?.slot && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={(event) => load(slot, undefined, nativeSession.current, event)}
            >
              {m.statement_consent_restart({}, options)}
            </Button>
          )}
        </div>
      )}
    </section>
  ) : null;
  return (
    <>
      {navigation ? departure : visible && <RelationEditorNavigation {...navigationState} />}
      {content}
    </>
  );
}

function QualifierInput({
  definition,
  snak,
  index,
  label,
  scope,
  search,
  target,
  remember,
  disabled,
  onChange,
}: {
  definition: RelationQualifier | undefined;
  snak: Snak;
  index: number;
  label: string;
  scope?: string | undefined;
  search: EntityPickerSearch;
  target: (value: unknown) => EntityPickerSubject[];
  remember: (items: EntityPickerSubject[]) => void;
  disabled: boolean;
  onChange: (value: Snak['value']) => void;
}) {
  const inputId = useId();
  const controlId = `${scope ?? inputId}-qualifier-${index}`;
  const value = snak.value.type === 'value' ? snak.value.content : undefined;
  if (definition?.datatype === 'wikibase-item')
    return (
      <Field className="gap-2">
        <FieldTitle>{label}</FieldTitle>
        <EntityPicker
          label={label}
          search={search}
          src={coverSrc}
          disabled={disabled}
          value={value ? target(value) : []}
          onValueChange={(items) => {
            remember(items);
            onChange({ type: 'value', content: items[0]?.id ?? '' });
          }}
        />
      </Field>
    );
  return (
    <Field>
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      <Input
        id={controlId}
        disabled={disabled}
        value={typeof value === 'string' ? value : ''}
        readOnly={typeof value !== 'string'}
        onChange={(event) => onChange({ type: 'value', content: event.target.value })}
      />
    </Field>
  );
}

function Statement({
  statement,
  publicRead,
  names,
  locale,
}: {
  statement: RelationDraft;
  publicRead: SubjectRead;
  names: Record<string, Record<string, string>>;
  locale: string;
}) {
  return (
    <div data-relation-statement className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]">
      <CandidateValue snak={statement} related={publicRead.related} locale={locale} />
      {statement.qualifiers.map((snak, index) => (
        <div key={index}>
          <span className="text-muted-foreground">
            {pickText(names[snak.property.id] ?? {}, locale).text || snak.property.id}:{' '}
          </span>
          <CandidateValue snak={snak} related={publicRead.related} locale={locale} />
        </div>
      ))}
      {statement.references.map((reference, index) => (
        <div key={index}>
          {reference.parts.map((snak, at) => (
            <CandidateValue key={at} snak={snak} related={publicRead.related} locale={locale} />
          ))}
        </div>
      ))}
    </div>
  );
}
