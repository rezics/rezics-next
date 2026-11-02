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
} from './realm-presentation';
import { realmAppearanceReference, type RealmAppearanceReference } from './realm-appearance-reference';
import type { RealmAppearanceCallerLifetime } from './realm-appearance-caller-lifetime';
import { RealmAppearanceDeparture } from './realm-appearance-departure';

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
        <Button variant="outline" onClick={retry}>
          {m.realm_appearance_retry_image_preview()}
        </Button>
      ) : null}
      {value ? <ImageCredit image={value} loaded={loaded} /> : null}
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
  const selectionRef = useRef<Selection | null>(null);
  const [usedReferences, setUsedReferences] = useState<
    Partial<Record<RealmImageSlot, { owner: object; callerId: number; reference: RealmAppearanceReference }>>
  >({});
  const [clearState, setClearState] = useState<{
    slot: RealmImageSlot | 'rules';
    owner: object;
    callerId: number;
    source: RealmAppearanceRead;
    head: string;
  } | null>(null);
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
    if (value === null) selectionGeneration.current++;
    selectionRef.current = value;
    setSelectionState(value);
  }
  function setClear(value: RealmImageSlot | 'rules' | null) {
    if (value === null) {
      setClearState(null);
      return;
    }
    const current = control.getSnapshot().read;
    if (!control.selectable() || current.kind !== 'ready') return;
    control.cancelUpload();
    setSelection(null);
    setClearState({ slot: value, owner: control, callerId, source: initial, head: current.snapshot.head });
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
          <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
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
        <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
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
  const editable = control.editable() && !selection;
  const selectable = control.selectable() && !selection && !clear;
  const label = (slot: RealmImageSlot | 'rules') =>
    slot === 'avatar'
      ? m.realm_appearance_icon()
      : slot === 'banner'
        ? m.realm_appearance_banner()
        : m.realm_appearance_rules();
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
  const rules = draft.rules.state === 'available' ? draft.rules.value : null;
  return withDeparture(
    <section aria-labelledby={`${ids}-heading`} className="space-y-6 rounded-2xl border p-4 sm:p-6">
      {heading}
      <p className="text-sm text-muted-foreground">
        {snapshot.canManage ? m.realm_appearance_intro() : m.realm_appearance_readonly()}
      </p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        {(['avatar', 'banner'] as const).map((slot) => (
          <div key={slot} className="min-w-0 space-y-3">
            <h3 className="font-medium">{label(slot)}</h3>
            <ImagePreview
              key={imagePreviewKey(draft[slot])}
              image={draft[slot]}
              title={snapshot.title}
              banner={slot === 'banner'}
              pending={
                draft[slot].state === 'unavailable' &&
                draft.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId'] !== null &&
                draft.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId'] !==
                  snapshot.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']
                  ? usedReference(slot)
                    ? m.realm_appearance_reference_pending()
                    : m.realm_appearance_preview_after_save()
                  : undefined
              }
            />
            {usedReference(slot) ? (
              <p className="text-sm text-muted-foreground">
                {m.realm_appearance_selection_for({ slot: label(slot), realm: snapshot.title })}{' '}
                <a className="text-primary underline" href={usedReference(slot)!.href}>
                  {m.realm_appearance_source_link()}
                </a>
              </p>
            ) : null}
            {snapshot.canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!selectable} onClick={() => openSelection(slot)}>
                  {m.realm_appearance_choose()}
                </Button>
                <Field className="w-full min-w-0 max-w-64">
                  <FieldLabel htmlFor={`${ids}-${slot}-upload`} className="text-sm">
                    {m.realm_appearance_upload()}
                  </FieldLabel>
                  <Input
                    id={`${ids}-${slot}-upload`}
                    type="file"
                    className="w-full min-w-0"
                    disabled={!selectable}
                    accept="image/avif,image/gif,image/jpeg,image/png,image/webp"
                    aria-label={`${label(slot)}: ${m.realm_appearance_upload()}`}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void control.upload(slot, file);
                    }}
                  />
                </Field>
                <Button
                  variant="ghost"
                  disabled={
                    !selectable ||
                    (draft.presentation[slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId'] === null &&
                      state.pendingUpload?.slot !== slot &&
                      state.uploadSlot !== slot)
                  }
                  onClick={() => setClear(slot)}
                >
                  {m.realm_appearance_clear()}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <h3 className="font-medium">{m.realm_appearance_rules()}</h3>
        {rules ? (
          <div className="space-y-2 rounded-xl bg-muted p-4">
            <p className="font-medium">{rules.title}</p>
            <p className="whitespace-pre-wrap text-sm">{rules.summary}</p>
            <a className="text-sm text-primary underline" href={rulesHref(rules.postId, rules.revisionId)}>
              {m.realm_appearance_open_revision()}
            </a>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {draft.rules.state === 'unavailable'
              ? m.realm_appearance_rules_unavailable()
              : m.realm_appearance_no_rules()}
          </p>
        )}
        {snapshot.canManage ? (
          <>
            <p className="text-sm text-muted-foreground">{m.realm_appearance_rules_help()}</p>
            <div className="flex gap-2">
              <Button variant="outline" disabled={!selectable} onClick={() => openSelection('rules')}>
                {m.realm_appearance_select_rules()}
              </Button>
              <Button
                variant="ghost"
                disabled={!selectable || draft.presentation.rules === null}
                onClick={() => setClear('rules')}
              >
                {m.realm_appearance_clear()}
              </Button>
            </div>
          </>
        ) : null}
      </div>
      {selection ? (
        <fieldset className="space-y-4 rounded-xl border p-4" aria-busy={selection.busy}>
          <legend className="px-2 font-medium">{label(selection.slot)}</legend>
          <p className="text-sm text-muted-foreground">
            {m.realm_appearance_selection_for({ slot: label(selection.slot), realm: snapshot.title })}
          </p>
          <Field>
            <FieldLabel htmlFor={`${ids}-reference`}>
              {selection.slot === 'rules' ? m.realm_appearance_rules_link() : m.realm_appearance_image_link()}
            </FieldLabel>
            <Input
              id={`${ids}-reference`}
              value={selection.link}
              maxLength={2048}
              aria-invalid={selection.invalid || selection.unavailable}
              aria-describedby={`${ids}-reference-help${selection.invalid || selection.unavailable ? ` ${ids}-reference-error` : ''}`}
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
            <p id={`${ids}-reference-help`} className="text-sm text-muted-foreground">
              {selection.slot === 'rules' ? m.realm_appearance_rules_link_help() : m.realm_appearance_image_link_help()}
            </p>
          </Field>
          {selection.candidate?.kind === 'image' ? (
            <ImagePreview
              key={imagePreviewKey({ state: 'available', value: selection.candidate.image })}
              image={{ state: 'available', value: selection.candidate.image }}
              title={snapshot.title}
              banner={selection.slot === 'banner'}
            />
          ) : null}
          {selection.candidate?.kind === 'image-reference' ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.realm_appearance_reference_pending()}
            </p>
          ) : null}
          {selection.candidate?.kind === 'rules' ? (
            <div>
              <p className="font-medium">{selection.candidate.rules.title}</p>
              <p className="whitespace-pre-wrap text-sm">{selection.candidate.rules.summary}</p>
              <a
                className="text-sm text-primary underline"
                href={rulesHref(selection.candidate.rules.postId, selection.candidate.rules.revisionId)}
              >
                {m.realm_appearance_open_revision()}
              </a>
            </div>
          ) : null}
          {selection.candidate && selection.reference ? (
            <a className="text-sm text-primary underline" href={selection.reference.href}>
              {m.realm_appearance_source_link()}
            </a>
          ) : null}
          {selection.invalid || selection.unavailable ? (
            <p id={`${ids}-reference-error`} role="alert">
              {selection.unavailable
                ? m.realm_appearance_link_unavailable()
                : selection.slot === 'rules'
                  ? m.realm_appearance_invalid_rules_link()
                  : m.realm_appearance_invalid_image_link()}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={selection.busy || !selection.link.trim()}
              onClick={() => void resolve()}
            >
              {m.realm_appearance_preview()}
            </Button>
            <Button
              disabled={!selection.candidate}
              onClick={() => {
                if (!selection.candidate || !currentSelection(selection)) return;
                control.choose(selection.slot, selection.candidate);
                if (selection.slot !== 'rules' && selection.reference)
                  setUsedReferences((previous) => ({
                    ...previous,
                    [selection.slot]: { owner: control, callerId, reference: selection.reference! },
                  }));
                setSelection(null);
              }}
            >
              {m.realm_appearance_use_selection()}
            </Button>
            <Button variant="ghost" onClick={() => setSelection(null)}>
              {m.editor_cancel()}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {clear ? (
        <div
          role="group"
          aria-label={m.realm_appearance_clear_confirm()}
          className="space-y-3 rounded-xl border border-destructive p-4"
        >
          <p>
            {m.realm_appearance_clear_confirm()} ({label(clear)})
          </p>
          <p className="text-sm text-muted-foreground">{m.realm_appearance_clear_help()}</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={!editable}
              onClick={() => {
                const current = control.getSnapshot().read;
                if (
                  clearState?.source !== incoming.current ||
                  current.kind !== 'ready' ||
                  clearState.head !== current.snapshot.head
                )
                  return;
                control.clear(clear);
                setClear(null);
              }}
            >
              {m.realm_appearance_clear()}
            </Button>
            <Button variant="outline" onClick={() => setClear(null)}>
              {m.editor_cancel()}
            </Button>
          </div>
        </div>
      ) : null}
      {state.phase === 'uploading' ? (
        <div role="status" className="flex flex-wrap items-center gap-3">
          <p>{m.realm_appearance_uploading()}</p>
          <Button variant="outline" onClick={control.cancelUpload}>
            {m.editor_cancel()}
          </Button>
        </div>
      ) : null}
      {state.pendingUpload && state.phase !== 'uploading' ? (
        <div role="status" className="space-y-2">
          <p>{m.realm_appearance_upload_pending()}</p>
          <Button
            variant="outline"
            disabled={state.busy}
            onClick={() => void control.upload(state.pendingUpload!.slot)}
          >
            {m.realm_appearance_retry_upload()}
          </Button>
          <Button variant="ghost" onClick={control.cancelUpload}>
            {m.editor_cancel()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'uncertain' ? (
        <div role="alert" className="space-y-2">
          <p>{m.realm_appearance_uncertain()}</p>
          <Button disabled={state.busy} onClick={() => void control.save()}>
            {m.realm_appearance_retry()}
          </Button>
        </div>
      ) : null}
      {state.phase === 'conflict' ? (
        <div role="alert" className="space-y-2">
          <p>{m.realm_appearance_conflict()}</p>
          <Button variant="outline" disabled={state.busy} onClick={() => void control.refresh()}>
            {m.realm_appearance_refresh()}
          </Button>
          {state.reviewed ? (
            <>
              <details className="space-y-3">
                <summary>{m.realm_appearance_current()}</summary>
                <div className="grid gap-4 sm:grid-cols-2">
                  <ImagePreview key={imagePreviewKey(snapshot.avatar)} image={snapshot.avatar} title={snapshot.title} />
                  <ImagePreview
                    key={imagePreviewKey(snapshot.banner)}
                    image={snapshot.banner}
                    title={snapshot.title}
                    banner
                  />
                </div>
                <p>
                  {snapshot.rules.state === 'available'
                    ? snapshot.rules.value.title
                    : snapshot.rules.state === 'none'
                      ? m.realm_appearance_no_rules()
                      : m.realm_appearance_rules_unavailable()}
                </p>
              </details>
              <Button variant="outline" onClick={control.reviewConflict}>
                {m.realm_appearance_review()}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {state.notice !== 'none' ? <p role="alert">{m.realm_appearance_selection_unavailable()}</p> : null}
      {state.phase === 'saved' ? <p role="status">{m.realm_appearance_saved()}</p> : null}
      {snapshot.canManage ? (
        <Button disabled={!editable || Boolean(clear)} onClick={() => void control.save()}>
          {state.phase === 'saving' ? m.realm_appearance_saving() : m.realm_appearance_save()}
        </Button>
      ) : null}
    </section>,
  );
}
