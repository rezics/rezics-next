import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { localizeUrl } from '../paraglide/runtime.js';
import { useCommunityManagementAdmission } from './community-management';
import { ImageCredit } from './community-presentation-parts';
import {
  createRealmAppearance,
  realmAppearanceHasUnsavedChanges,
  realmImageSource,
  type RealmAppearanceAdapter,
  type RealmAppearanceRead,
  type RealmAppearanceSelection,
  type RealmImageSlot,
  type RealmPresentationImage,
  type RealmPresentationOptional,
  type RealmRulesSummary,
} from './realm-presentation';
import { realmAppearanceReference, type RealmAppearanceReference } from './realm-appearance-reference';
import type { RealmAppearanceCallerLifetime } from './realm-appearance-caller-lifetime';
import { RealmAppearanceDeparture } from './realm-appearance-departure';
import { RealmRulesAuthoringPanel } from './realm-rules-authoring/panel';

const appearanceButtonClass =
  'h-auto min-h-7 max-w-full shrink text-center leading-snug whitespace-normal [overflow-wrap:anywhere]';

function ImagePreview({
  image,
  title,
  banner = false,
  pending,
}: {
  image: RealmPresentationOptional<RealmPresentationImage>;
  title: string;
  banner?: boolean;
  pending?: string | undefined;
}) {
  const src = realmImageSource(image);
  const [attempt, setAttempt] = useState<{
    generation: number;
    state: 'loading' | 'recovering' | 'failed' | 'loaded';
  }>({ generation: 0, state: 'loading' });
  const attemptRef = useRef(attempt);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function settle(state: 'failed' | 'loaded') {
    if (
      !mounted.current ||
      attemptRef.current !== attempt ||
      (attempt.state !== 'loading' && attempt.state !== 'recovering')
    )
      return;
    const next = { ...attempt, state };
    attemptRef.current = next;
    setAttempt(next);
  }
  function retry() {
    if (!mounted.current || attemptRef.current !== attempt || attempt.state !== 'failed' || !src) return;
    const next = { generation: attempt.generation + 1, state: 'recovering' as const };
    attemptRef.current = next;
    setAttempt(next);
  }
  const value = image.state === 'available' ? image.value : null;
  const loaded = src !== null && attempt.state === 'loaded';
  const fallback = !src || attempt.state === 'failed' || attempt.state === 'recovering';
  return (
    <div className="space-y-2">
      <div
        className={`flex items-center justify-center overflow-hidden border bg-muted text-2xl font-semibold text-muted-foreground ${banner ? 'aspect-[3/1] w-full rounded-xl' : 'size-20 rounded-2xl'}`}
        style={value?.placeholder ? { backgroundColor: value.placeholder.color } : undefined}
      >
        {src ? (
          <img
            key={attempt.generation}
            src={src}
            alt=""
            className="size-full object-cover"
            style={
              value?.focalPoint
                ? {
                    objectPosition: `${value.focalPoint.x * 100}% ${value.focalPoint.y * 100}%`,
                    visibility: fallback ? 'hidden' : undefined,
                  }
                : fallback
                  ? { visibility: 'hidden' }
                  : undefined
            }
            onLoad={() => settle('loaded')}
            onError={() => settle('failed')}
          />
        ) : null}
        {fallback ? <span aria-hidden="true">{title.trim().slice(0, 2).toLocaleUpperCase()}</span> : null}
      </div>
      {pending ? (
        <p className="text-sm text-muted-foreground">{pending}</p>
      ) : image.state === 'unavailable' ||
        attempt.state === 'failed' ||
        attempt.state === 'recovering' ||
        (image.state === 'available' && !src) ? (
        <p className="text-sm text-muted-foreground">{m.realm_appearance_image_unavailable()}</p>
      ) : image.state === 'none' ? (
        <p className="text-sm text-muted-foreground">{m.realm_appearance_no_image()}</p>
      ) : null}
      {src && attempt.state === 'failed' && !pending ? (
        <Button type="button" variant="outline" className={appearanceButtonClass} onClick={retry}>
          {m.realm_appearance_retry_image_preview()}
        </Button>
      ) : null}
      {value ? <ImageCredit image={value} loaded={loaded} /> : null}
    </div>
  );
}

function RulesPreview({ rules }: { rules: RealmPresentationOptional<RealmRulesSummary> }) {
  if (rules.state !== 'available') {
    return (
      <p className="text-sm text-muted-foreground" data-rules-preview-state={rules.state}>
        {rules.state === 'none' ? m.realm_appearance_no_rules() : m.realm_appearance_rules_unavailable()}
      </p>
    );
  }
  const href = rulesHref(rules.value.postId, rules.value.revisionId);
  return (
    <div className="space-y-2 rounded-xl bg-muted p-4" data-rules-preview-state="available">
      <p className="font-medium">{rules.value.title}</p>
      <p className="whitespace-pre-wrap text-sm">{rules.value.summary}</p>
      <a className="break-all text-sm text-primary underline [overflow-wrap:anywhere]" href={href}>
        {m.realm_appearance_open_revision()} <span className="select-text">{href}</span>
      </a>
    </div>
  );
}

function imagePreviewKey(image: RealmPresentationOptional<RealmPresentationImage>) {
  return image.state === 'available'
    ? JSON.stringify([image.state, image.value.id, image.value.digest, realmImageSource(image), image.value.credit])
    : image.state;
}

type Selection = {
  generation: number;
  owner: object;
  callerId: number;
  callerTicket: number;
  head: string | null;
  slot: RealmImageSlot | 'rules';
  source: RealmAppearanceRead;
  link: string;
  reference: RealmAppearanceReference | null;
  invalid: boolean;
  candidate: RealmAppearanceSelection | null;
  busy: boolean;
  unavailable: boolean;
};

type FocusRequest = {
  kind: 'selection' | 'clear' | 'return';
  owner: object;
  callerId: number;
  callerTicket: number;
  source: RealmAppearanceRead;
  head: string;
  generation: number;
  slot: RealmImageSlot | 'rules';
  expected: Element | null;
  returnTo?: 'selector' | 'opener';
  opener?: HTMLButtonElement | null;
};

function rulesHref(postId: string, revisionId: string) {
  return localizeUrl(new URL(`/posts/${postId}/revisions/${revisionId}`, 'https://rezics.local')).pathname;
}

/** Reusable settings Pattern. Pages provide only current native data and ordinary command transport. */
export function RealmAppearanceSettings({
  realmId,
  initial,
  adapter,
  lifetime,
}: {
  realmId: string;
  initial: RealmAppearanceRead;
  adapter: RealmAppearanceAdapter;
  lifetime?: RealmAppearanceCallerLifetime;
}) {
  const control = useMemo(
    () => createRealmAppearance(realmId, initial, adapter, undefined, lifetime),
    [realmId, adapter, lifetime],
  );
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const [selectionState, setSelectionState] = useState<Selection | null>(null);
  const [rulesAuthoringActive, setRulesAuthoringActive] = useState(false);
  const selectionRef = useRef<Selection | null>(null);
  const [usedReferences, setUsedReferences] = useState<
    Partial<Record<RealmImageSlot, { owner: object; callerId: number; reference: RealmAppearanceReference }>>
  >({});
  const [clearState, setClearState] = useState<{
    slot: RealmImageSlot | 'rules';
    owner: object;
    callerId: number;
    callerTicket: number;
    source: RealmAppearanceRead;
    head: string;
    generation: number;
    opener: HTMLButtonElement | null;
  } | null>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  const selectionTriggers = useRef<Partial<Record<RealmImageSlot | 'rules', HTMLButtonElement | null>>>({});
  const clearTriggers = useRef<Partial<Record<RealmImageSlot | 'rules', HTMLButtonElement | null>>>({});
  const referenceInput = useRef<HTMLInputElement | null>(null);
  const clearBoundary = useRef<HTMLDivElement | null>(null);
  const ids = useId();
  const callerId = lifetime?.id ?? 0;
  const incoming = useRef(initial);
  const previousOwner = useRef(control);
  const previousCaller = useRef(callerId);
  const read = initial !== incoming.current ? initial : state.read;
  const visible = useCommunityManagementAdmission(
    'appearance',
    (!lifetime || lifetime.current()) &&
      read.kind === 'ready' &&
      read.snapshot.realmId === realmId &&
      read.snapshot.state === 'active' &&
      read.snapshot.canManage,
  );
  const visibleSelection =
    selectionState?.owner === control &&
    selectionState.callerId === callerId &&
    selectionState.source === initial &&
    read.kind === 'ready' &&
    selectionState.head === read.snapshot.head
      ? selectionState
      : null;
  const clear =
    clearState?.owner === control &&
    clearState.callerId === callerId &&
    clearState.source === initial &&
    (!lifetime || lifetime.owns(clearState.callerTicket)) &&
    read.kind === 'ready' &&
    clearState.head === read.snapshot.head
      ? clearState.slot
      : null;
  const departureBaseline =
    state.read.kind === 'ready'
      ? state.read.snapshot.presentation
      : initial.kind === 'ready'
        ? initial.snapshot.presentation
        : undefined;
  const departureAuthority =
    visible &&
    (!lifetime || lifetime.current()) &&
    state.draft !== null &&
    (read.kind === 'ready'
      ? read.snapshot.realmId === realmId && read.snapshot.state === 'active' && read.snapshot.canManage
      : read.kind === 'unavailable' &&
        (state.read.kind === 'unavailable' ||
          (state.read.kind === 'ready' &&
            state.read.snapshot.realmId === realmId &&
            state.read.snapshot.state === 'active' &&
            state.read.snapshot.canManage)));
  const changedReference = Boolean(
    visibleSelection &&
    (visibleSelection.link.trim() !== '' ||
      visibleSelection.reference ||
      visibleSelection.candidate ||
      visibleSelection.busy),
  );
  const departureDirty =
    departureAuthority && (realmAppearanceHasUnsavedChanges(state, departureBaseline) || changedReference);
  const withDeparture = (children: ReactNode) => (
    <RealmAppearanceDeparture
      active={departureAuthority}
      dirty={departureDirty}
      unresolvedSave={state.phase === 'saving' || state.phase === 'uncertain'}
    >
      {children}
    </RealmAppearanceDeparture>
  );
  const selectionGeneration = useRef(0);
  function setSelection(value: Selection | null) {
    if (value === null) {
      selectionGeneration.current++;
      focusRequest.current = null;
    }
    selectionRef.current = value;
    setSelectionState(value);
  }
  function setClear(value: RealmImageSlot | 'rules' | null) {
    if (value === null) {
      selectionGeneration.current++;
      focusRequest.current = null;
      setClearState(null);
      return;
    }
    const current = control.getSnapshot().read;
    if (!control.selectable() || current.kind !== 'ready') return;
    const callerTicket = lifetime?.ticket() ?? 0;
    if (lifetime && (!lifetime.current() || !lifetime.owns(callerTicket))) return;
    control.cancelUpload();
    setSelection(null);
    const generation = ++selectionGeneration.current;
    const opener = clearTriggers.current[value] ?? (document.activeElement as HTMLButtonElement | null);
    const next = {
      slot: value,
      owner: control,
      callerId,
      callerTicket,
      source: initial,
      head: current.snapshot.head,
      generation,
      opener,
    };
    setClearState(next);
    focusRequest.current = {
      kind: 'clear',
      ...next,
      expected: document.activeElement,
    };
  }
  function currentSelection(selected: Selection) {
    const current = selectionRef.current;
    const snapshot = control.getSnapshot();
    return (
      current?.generation === selected.generation &&
      current.owner === control &&
      current.callerId === callerId &&
      current.callerTicket === selected.callerTicket &&
      current.head === selected.head &&
      current.slot === selected.slot &&
      current.link === selected.link &&
      current.source === incoming.current &&
      current.source === selected.source &&
      (!lifetime || (lifetime.current() && lifetime.owns(selected.callerTicket))) &&
      snapshot.read.kind === 'ready' &&
      snapshot.read.snapshot.head === selected.head
    );
  }
  function closeSelection(selected: Selection) {
    const expected = document.activeElement;
    setSelection(null);
    focusRequest.current = {
      kind: 'return',
      owner: control,
      callerId,
      callerTicket: selected.callerTicket,
      source: selected.source,
      head: selected.head ?? '',
      generation: selectionGeneration.current,
      slot: selected.slot,
      expected,
      returnTo: 'selector',
    };
  }
  function closeClear(current: NonNullable<typeof clearState>, returnTo: 'selector' | 'opener') {
    const expected = document.activeElement;
    setClear(null);
    focusRequest.current = {
      kind: 'return',
      owner: control,
      callerId,
      callerTicket: current.callerTicket,
      source: current.source,
      head: current.head,
      generation: selectionGeneration.current,
      slot: current.slot,
      expected,
      returnTo,
      opener: current.opener,
    };
  }
  function focusRequestIsCurrent(request: FocusRequest) {
    const current = control.getSnapshot().read;
    return (
      request.owner === control &&
      request.callerId === callerId &&
      request.generation === selectionGeneration.current &&
      request.source === incoming.current &&
      (!lifetime || (lifetime.current() && lifetime.owns(request.callerTicket))) &&
      visible &&
      request.head !== '' &&
      current.kind === 'ready' &&
      current.snapshot.realmId === realmId &&
      current.snapshot.state === 'active' &&
      current.snapshot.canManage &&
      current.snapshot.head === request.head
    );
  }
  function openSelection(slot: RealmImageSlot | 'rules') {
    if (!control.selectable()) return;
    control.cancelUpload();
    const snapshot = control.getSnapshot();
    const head = snapshot.read.kind === 'ready' ? snapshot.read.snapshot.head : null;
    const next: Selection = {
      generation: ++selectionGeneration.current,
      owner: control,
      callerId,
      callerTicket: lifetime?.ticket() ?? 0,
      head,
      slot,
      source: initial,
      link: '',
      reference: null,
      invalid: false,
      candidate: null,
      busy: false,
      unavailable: false,
    };
    setSelection(next);
    focusRequest.current = {
      kind: 'selection',
      owner: control,
      callerId,
      callerTicket: next.callerTicket,
      source: initial,
      head: next.head ?? '',
      generation: next.generation,
      slot,
      expected: document.activeElement,
    };
  }
  useLayoutEffect(() => {
    const previousRead = incoming.current;
    const ownerChanged = previousOwner.current !== control;
    const callerChanged = previousCaller.current !== callerId;
    const previousHead = previousRead.kind === 'ready' ? previousRead.snapshot.head : null;
    const currentHead = initial.kind === 'ready' ? initial.snapshot.head : null;
    incoming.current = initial;
    previousOwner.current = control;
    previousCaller.current = callerId;
    control.observe(initial);
    if (ownerChanged || callerChanged || previousRead !== initial || previousHead !== currentHead) {
      setSelection(null);
      setClear(null);
    }
  }, [control, initial, callerId]);
  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    if (!focusRequestIsCurrent(request)) return;
    if (request.kind !== 'return' && document.activeElement !== request.expected) return;
    if (
      request.kind === 'return' &&
      document.activeElement !== request.expected &&
      document.activeElement !== document.body
    )
      return;
    if (request.kind === 'selection') {
      const selected = selectionRef.current;
      if (selected?.generation === request.generation && currentSelection(selected)) referenceInput.current?.focus();
    } else if (request.kind === 'clear') {
      if (clearState?.generation === request.generation && clearState.slot === request.slot)
        clearBoundary.current?.focus();
    } else if (selectionState === null && clearState === null) {
      const target =
        request.returnTo === 'opener' && request.opener?.isConnected && !request.opener.disabled
          ? request.opener
          : selectionTriggers.current[request.slot];
      if (target?.isConnected && !target.disabled) target.focus();
    }
  }, [control, initial, callerId, read, selectionState, clearState, visible]);
  useLayoutEffect(() => control.connect(), [control]);
  useEffect(() => () => control.cancelUpload(), [control]);
  useEffect(() => () => control.disconnect(), [control]);
  if (!visible || (lifetime && !lifetime.current())) return withDeparture(null);
  const heading = (
    <h2 id={`${ids}-heading`} className="text-xl font-semibold">
      {m.realm_appearance_heading()}
    </h2>
  );
  if (read.kind === 'hidden') {
    return withDeparture(
      state.draft ? (
        <section aria-labelledby={`${ids}-heading`} className="space-y-4 rounded-2xl border p-4 sm:p-6">
          {heading}
          <p role="alert">{m.community_management_denied()}</p>
          <Button
            type="button"
            variant="outline"
            className={appearanceButtonClass}
            disabled={state.busy}
            onClick={() => void control.refresh()}
          >
            {m.realm_appearance_refresh()}
          </Button>
        </section>
      ) : null,
    );
  }
  if (read.kind === 'ready' && (read.snapshot.state !== 'active' || read.snapshot.realmId !== realmId))
    return withDeparture(null);
  if (read.kind !== 'ready' || !state.draft)
    return withDeparture(
      <section aria-labelledby={`${ids}-heading`} className="space-y-4 rounded-2xl border p-4 sm:p-6">
        {heading}
        <p role="status">{m.realm_appearance_unavailable()}</p>
        <Button
          type="button"
          variant="outline"
          className={appearanceButtonClass}
          disabled={state.busy}
          onClick={() => void control.refresh()}
        >
          {m.realm_appearance_refresh()}
        </Button>
      </section>,
    );
  const { snapshot } = read;
  const retained = state.draft;
  // Preserve the local intent, while current optional reads replace cached facts for the same selected source.
  const draft = {
    ...retained,
    avatar:
      retained.presentation.avatarMediaId === snapshot.presentation.avatarMediaId ? snapshot.avatar : retained.avatar,
    banner:
      retained.presentation.bannerMediaId === snapshot.presentation.bannerMediaId ? snapshot.banner : retained.banner,
    rules:
      retained.presentation.rules?.postId === snapshot.presentation.rules?.postId &&
      retained.presentation.rules?.revisionId === snapshot.presentation.rules?.revisionId
        ? snapshot.rules
        : retained.rules,
  };
  const selection = visibleSelection;
  const editable = control.editable() && !selection && !rulesAuthoringActive;
  const selectable = control.selectable() && !selection && !clear && !rulesAuthoringActive;
  async function resolve() {
    if (!selection || selectionRef.current?.busy || !currentSelection(selection)) return;
    const reference = realmAppearanceReference(selection.link, window.location.origin, realmId, selection.slot);
    const selected = {
      ...selection,
      generation: ++selectionGeneration.current,
      reference,
      candidate: null,
      invalid: !reference,
      unavailable: false,
      busy: Boolean(reference),
    };
    setSelection(selected);
    if (!reference) return;
    const candidate = await control.resolveSelection(reference.choice, () => currentSelection(selected));
    if (candidate === null || !currentSelection(selected)) return;
    const choice = reference.choice;
    const valid =
      choice.kind === 'rules'
        ? candidate.kind === 'rules' &&
          candidate.rules.postId === choice.postId &&
          candidate.rules.revisionId === choice.revisionId
        : (candidate.kind === 'image' &&
            candidate.image.id === choice.mediaId &&
            candidate.image.containerId === realmId &&
            Boolean(realmImageSource({ state: 'available', value: candidate.image }))) ||
          (candidate.kind === 'image-reference' &&
            candidate.mediaId === choice.mediaId &&
            candidate.realmId === realmId &&
            candidate.purpose === choice.purpose);
    setSelection({ ...selected, busy: false, candidate: valid ? candidate : null, unavailable: !valid });
  }
  function usedReference(slot: RealmImageSlot) {
    const used = usedReferences[slot];
    return used?.owner === control &&
      used.callerId === callerId &&
      used.reference.choice.kind === 'image' &&
      used.reference.choice.mediaId === draft.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']
      ? used.reference
      : null;
  }
  function imagePreviewPending(slot: RealmImageSlot) {
    const key = slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId';
    if (
      draft[slot].state !== 'unavailable' ||
      draft.presentation[key] === null ||
      draft.presentation[key] === snapshot.presentation[key]
    )
      return undefined;
    return usedReference(slot) ? m.realm_appearance_reference_pending() : m.realm_appearance_preview_after_save();
  }
  function appearanceLabel(slot: RealmImageSlot | 'rules') {
    return slot === 'avatar'
      ? m.realm_appearance_icon()
      : slot === 'banner'
        ? m.realm_appearance_banner()
        : m.realm_appearance_rules();
  }
  function referenceEditor(slot: RealmImageSlot | 'rules') {
    if (!selection || selection.slot !== slot) return null;
    return (
      <fieldset
        className="min-w-0 space-y-4 rounded-xl border p-4"
        aria-busy={selection.busy}
        data-appearance-selection={slot}
      >
        <legend className="max-w-full px-2 font-medium [overflow-wrap:anywhere]">{appearanceLabel(slot)}</legend>
        <p className="text-sm text-muted-foreground">
          {m.realm_appearance_selection_for({ slot: appearanceLabel(slot), realm: snapshot.title })}
        </p>
        <Field className="min-w-0">
          <FieldLabel htmlFor={ids + '-reference'}>
            {slot === 'rules' ? m.realm_appearance_rules_link() : m.realm_appearance_image_link()}
          </FieldLabel>
          <Input
            ref={referenceInput}
            id={ids + '-reference'}
            className="w-full min-w-0"
            value={selection.link}
            maxLength={2048}
            aria-invalid={selection.invalid || selection.unavailable}
            aria-describedby={
              ids +
              '-reference-help' +
              (selection.invalid || selection.unavailable ? ' ' + ids + '-reference-error' : '')
            }
            onChange={(event) =>
              setSelection({
                ...selection,
                generation: ++selectionGeneration.current,
                link: event.target.value,
                reference: null,
                candidate: null,
                busy: false,
                invalid: false,
                unavailable: false,
              })
            }
          />
          <p id={ids + '-reference-help'} className="text-sm text-muted-foreground">
            {slot === 'rules' ? m.realm_appearance_rules_link_help() : m.realm_appearance_image_link_help()}
          </p>
          {selection.link ? (
            <p className="break-all text-sm text-muted-foreground [overflow-wrap:anywhere]">
              <span className="select-text">{selection.link}</span>
            </p>
          ) : null}
        </Field>
        {selection.candidate?.kind === 'image' ? (
          <ImagePreview
            key={imagePreviewKey({ state: 'available', value: selection.candidate.image })}
            image={{ state: 'available', value: selection.candidate.image }}
            title={snapshot.title}
            banner={slot === 'banner'}
          />
        ) : null}
        {selection.candidate?.kind === 'image-reference' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.realm_appearance_reference_pending()}
          </p>
        ) : null}
        {selection.candidate?.kind === 'rules' ? (
          <RulesPreview rules={{ state: 'available', value: selection.candidate.rules }} />
        ) : null}
        {selection.candidate && selection.reference ? (
          <a
            className="break-all text-sm text-primary underline [overflow-wrap:anywhere]"
            href={selection.reference.href}
          >
            {m.realm_appearance_source_link()} <span className="select-text">{selection.reference.href}</span>
          </a>
        ) : null}
        {selection.invalid || selection.unavailable ? (
          <p id={ids + '-reference-error'} role="alert">
            {selection.unavailable
              ? m.realm_appearance_link_unavailable()
              : slot === 'rules'
                ? m.realm_appearance_invalid_rules_link()
                : m.realm_appearance_invalid_image_link()}
          </p>
        ) : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <Button
            type="button"
            variant="outline"
            className={appearanceButtonClass}
            disabled={selection.busy || !selection.link.trim()}
            onClick={() => void resolve()}
          >
            {m.realm_appearance_preview()}
          </Button>
          <Button
            type="button"
            className={appearanceButtonClass}
            disabled={!selection.candidate}
            onClick={() => {
              if (!selection.candidate || !currentSelection(selection)) return;
              control.choose(selection.slot, selection.candidate);
              if (selection.slot !== 'rules' && selection.reference)
                setUsedReferences((previous) => ({
                  ...previous,
                  [selection.slot]: { owner: control, callerId, reference: selection.reference! },
                }));
              closeSelection(selection);
            }}
          >
            {m.realm_appearance_use_selection()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className={appearanceButtonClass}
            onClick={() => closeSelection(selection)}
          >
            {m.editor_cancel()}
          </Button>
        </div>
      </fieldset>
    );
  }
  function clearConfirmation(slot: RealmImageSlot | 'rules') {
    if (clear !== slot) return null;
    return (
      <div
        ref={clearBoundary}
        role="group"
        aria-label={m.realm_appearance_clear_confirm()}
        tabIndex={-1}
        className="min-w-0 space-y-3 rounded-xl border border-destructive p-4"
        data-clear-target={slot}
      >
        <p className="[overflow-wrap:anywhere]">
          {m.realm_appearance_clear_confirm()} ({appearanceLabel(slot)})
        </p>
        <p className="text-sm text-muted-foreground">{m.realm_appearance_clear_help()}</p>
        <div className="flex min-w-0 flex-wrap items-start gap-2">
          <Button
            type="button"
            variant="destructive"
            className={appearanceButtonClass}
            disabled={!editable}
            onClick={() => {
              const current = control.getSnapshot().read;
              if (
                clearState?.source !== incoming.current ||
                current.kind !== 'ready' ||
                clearState.head !== current.snapshot.head
              )
                return;
              control.clear(slot);
              if (clearState) closeClear(clearState, 'selector');
            }}
          >
            {m.realm_appearance_clear()}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={appearanceButtonClass}
            onClick={() => clearState && closeClear(clearState, 'opener')}
          >
            {m.editor_cancel()}
          </Button>
        </div>
      </div>
    );
  }
  function uploadStatus(slot: RealmImageSlot) {
    return (
      <>
        {state.phase === 'uploading' && state.uploadSlot === slot ? (
          <div role="status" className="flex min-w-0 flex-wrap items-center gap-3" data-upload-target={slot}>
            <p>{m.realm_appearance_uploading()}</p>
            <Button
              type="button"
              variant="outline"
              className={appearanceButtonClass}
              onClick={control.cancelUpload}
            >
              {m.editor_cancel()}
            </Button>
          </div>
        ) : null}
        {state.pendingUpload?.slot === slot && state.phase !== 'uploading' ? (
          <div role="status" className="min-w-0 space-y-2" data-upload-target={slot}>
            <p>{m.realm_appearance_upload_pending()}</p>
            <div className="flex min-w-0 flex-wrap items-start gap-2">
              <Button
                type="button"
                variant="outline"
                className={appearanceButtonClass}
                disabled={state.busy}
                onClick={() => void control.upload(slot)}
              >
                {m.realm_appearance_retry_upload()}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={appearanceButtonClass}
                onClick={control.cancelUpload}
              >
                {m.editor_cancel()}
              </Button>
            </div>
          </div>
        ) : null}
      </>
    );
  }
  function renderImageSlot(slot: RealmImageSlot) {
    const reference = usedReference(slot);
    const presentationKey = slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId';
    const isDraft = draft.presentation[presentationKey] !== snapshot.presentation[presentationKey];
    return (
      <div
        key={slot}
        role="group"
        aria-labelledby={ids + '-' + slot + '-heading'}
        className="min-w-0 space-y-4 rounded-xl border p-4"
        data-appearance-slot={slot}
      >
        <h3 id={ids + '-' + slot + '-heading'} className="font-medium">
          {appearanceLabel(slot)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isDraft ? m.realm_appearance_preview() : m.realm_appearance_current()}
        </p>
        <ImagePreview
          key={imagePreviewKey(draft[slot])}
          image={draft[slot]}
          title={snapshot.title}
          banner={slot === 'banner'}
          pending={imagePreviewPending(slot)}
        />
        {reference ? (
          <p className="break-words text-sm text-muted-foreground">
            {m.realm_appearance_selection_for({ slot: appearanceLabel(slot), realm: snapshot.title })}{' '}
            <a className="break-all text-primary underline [overflow-wrap:anywhere]" href={reference.href}>
              {m.realm_appearance_source_link()} <span className="select-text">{reference.href}</span>
            </a>
          </p>
        ) : null}
        {snapshot.canManage ? (
          <div className="flex min-w-0 flex-wrap items-start gap-3">
            <Button
              type="button"
              ref={(element) => {
                selectionTriggers.current[slot] = element;
              }}
              variant="outline"
              className={appearanceButtonClass}
              disabled={!selectable}
              onClick={() => openSelection(slot)}
            >
              {m.realm_appearance_choose()}
            </Button>
            <Field className="w-full min-w-0 max-w-72">
              <FieldLabel htmlFor={ids + '-' + slot + '-upload'} className="text-sm">
                {m.realm_appearance_upload()}
              </FieldLabel>
              <Input
                id={ids + '-' + slot + '-upload'}
                type="file"
                className="w-full min-w-0"
                disabled={!selectable}
                accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                aria-label={appearanceLabel(slot) + ': ' + m.realm_appearance_upload()}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void control.upload(slot, file);
                }}
              />
            </Field>
            <Button
              type="button"
              ref={(element) => {
                clearTriggers.current[slot] = element;
              }}
              variant="ghost"
              className={appearanceButtonClass}
              disabled={
                !selectable ||
                (draft.presentation[presentationKey] === null &&
                  state.pendingUpload?.slot !== slot &&
                  state.uploadSlot !== slot)
              }
              onClick={() => setClear(slot)}
            >
              {m.realm_appearance_clear()}
            </Button>
          </div>
        ) : null}
        {referenceEditor(slot)}
        {clearConfirmation(slot)}
        {uploadStatus(slot)}
      </div>
    );
  }
  const rulesChanged =
    draft.presentation.rules?.postId !== snapshot.presentation.rules?.postId ||
    draft.presentation.rules?.revisionId !== snapshot.presentation.rules?.revisionId;
  function renderRulesSlot() {
    return (
      <div
        role="group"
        aria-labelledby={ids + '-rules-heading'}
        className="min-w-0 space-y-4 rounded-xl border p-4 sm:col-span-2"
        data-appearance-slot="rules"
      >
        <h3 id={ids + '-rules-heading'} className="font-medium">
          {appearanceLabel('rules')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {rulesChanged ? m.realm_appearance_preview() : m.realm_appearance_current()}
        </p>
        <RulesPreview rules={draft.rules} />
        {snapshot.canManage ? (
          <>
            <p className="text-sm text-muted-foreground">{m.realm_appearance_rules_help()}</p>
            <div className="flex min-w-0 flex-wrap items-start gap-2">
              <Button
                type="button"
                ref={(element) => {
                  selectionTriggers.current.rules = element;
                }}
                variant="outline"
                className={appearanceButtonClass}
                disabled={!selectable}
                onClick={() => openSelection('rules')}
              >
                {m.realm_appearance_select_rules()}
              </Button>
              <Button
                type="button"
                ref={(element) => {
                  clearTriggers.current.rules = element;
                }}
                variant="ghost"
                className={appearanceButtonClass}
                disabled={!selectable || draft.presentation.rules === null}
                onClick={() => setClear('rules')}
              >
                {m.realm_appearance_clear()}
              </Button>
            </div>
            {referenceEditor('rules')}
            {clearConfirmation('rules')}
          </>
        ) : null}
        <div className="min-w-0" data-rules-authoring-owner>
          <RealmRulesAuthoringPanel
            realmId={realmId}
            snapshot={snapshot}
            state={state}
            adapter={adapter}
            control={control}
            {...(lifetime ? { lifetime } : {})}
            onModeChange={(active) => setRulesAuthoringActive(active)}
          />
        </div>
      </div>
    );
  }
  const hasDraftWork = realmAppearanceHasUnsavedChanges(state, departureBaseline);
  return withDeparture(
    <section
      aria-labelledby={ids + '-heading'}
      className="space-y-6 rounded-2xl border p-4 sm:p-6"
      data-appearance-workspace
    >
      {heading}
      <p className="text-sm text-muted-foreground">
        {snapshot.canManage ? m.realm_appearance_intro() : m.realm_appearance_readonly()}
      </p>
      <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2 lg:gap-6">
        {renderImageSlot('avatar')}
        {renderImageSlot('banner')}
        {renderRulesSlot()}
      </div>
      <section
        aria-labelledby={ids + '-save-heading'}
        className={
          'min-w-0 space-y-4 rounded-xl border p-4 sm:p-5 ' +
          (hasDraftWork ? 'border-primary/50 bg-primary/5' : 'bg-muted/20')
        }
        data-appearance-save
        data-dirty={hasDraftWork}
      >
        <h3 id={ids + '-save-heading'} className="font-medium">
          {m.realm_appearance_save()}
        </h3>
        {state.phase === 'uncertain' ? (
          <div role="alert" className="min-w-0 space-y-2">
            <p>{m.realm_appearance_uncertain()}</p>
            <Button
              type="button"
              className={appearanceButtonClass}
              disabled={state.busy}
              onClick={() => void control.save()}
            >
              {m.realm_appearance_retry()}
            </Button>
          </div>
        ) : null}
        {state.phase === 'conflict' ? (
          <section
            role="alert"
            aria-labelledby={ids + '-conflict-heading'}
            className="min-w-0 space-y-3 rounded-xl border border-destructive p-4"
            data-conflict-review
          >
            <h4 id={ids + '-conflict-heading'} className="font-medium">
              {m.realm_appearance_conflict()}
            </h4>
            <Button
              type="button"
              variant="outline"
              className={appearanceButtonClass}
              disabled={state.busy}
              onClick={() => void control.refresh()}
            >
              {m.realm_appearance_refresh()}
            </Button>
            {state.reviewed ? (
              <>
                <div className="grid min-w-0 gap-4 md:grid-cols-2">
                  <section
                    aria-labelledby={ids + '-conflict-current'}
                    className="min-w-0 space-y-3 rounded-lg border p-3"
                    data-conflict-current
                  >
                    <h5 id={ids + '-conflict-current'} className="font-medium">
                      {m.realm_appearance_current()}
                    </h5>
                    <ImagePreview
                      key={imagePreviewKey(snapshot.avatar)}
                      image={snapshot.avatar}
                      title={snapshot.title}
                    />
                    <ImagePreview
                      key={imagePreviewKey(snapshot.banner)}
                      image={snapshot.banner}
                      title={snapshot.title}
                      banner
                    />
                    <RulesPreview rules={snapshot.rules} />
                  </section>
                  <section
                    aria-labelledby={ids + '-conflict-draft'}
                    className="min-w-0 space-y-3 rounded-lg border p-3"
                    data-conflict-draft
                  >
                    <h5 id={ids + '-conflict-draft'} className="font-medium">
                      {m.realm_appearance_preview()}
                    </h5>
                    <ImagePreview
                      key={imagePreviewKey(draft.avatar)}
                      image={draft.avatar}
                      title={snapshot.title}
                      pending={imagePreviewPending('avatar')}
                    />
                    <ImagePreview
                      key={imagePreviewKey(draft.banner)}
                      image={draft.banner}
                      title={snapshot.title}
                      banner
                      pending={imagePreviewPending('banner')}
                    />
                    <RulesPreview rules={draft.rules} />
                  </section>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className={appearanceButtonClass}
                  onClick={() => control.reviewConflict()}
                >
                  {m.realm_appearance_review()}
                </Button>
              </>
            ) : null}
          </section>
        ) : null}
        {state.notice !== 'none' ? <p role="alert">{m.realm_appearance_selection_unavailable()}</p> : null}
        {state.phase === 'saved' ? <p role="status">{m.realm_appearance_saved()}</p> : null}
        {snapshot.canManage ? (
          <Button
            type="button"
            className={appearanceButtonClass}
            disabled={!editable || Boolean(clear)}
            onClick={() => void control.save()}
          >
            {state.phase === 'saving' ? m.realm_appearance_saving() : m.realm_appearance_save()}
          </Button>
        ) : null}
      </section>
    </section>,
  );
}
