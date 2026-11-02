import type {
  RealmPresentationImage,
  RealmPresentationOptional,
} from '../../../../packages/client/src/kernel/content/realm-media';
export type {
  RealmPresentationImage,
  RealmPresentationOptional,
} from '../../../../packages/client/src/kernel/content/realm-media';
import * as v from 'valibot';
import { coverSrc } from '../media/cover-src';
import type { RealmAppearanceCallerLifetime } from './realm-appearance-caller-lifetime';

const id = v.pipe(v.string(), v.uuid());
export const realmPresentationSchema = v.strictObject({
  avatarMediaId: v.nullable(id),
  bannerMediaId: v.nullable(id),
  rules: v.nullable(v.strictObject({ postId: id, revisionId: id })),
});
export const realmAppearanceCommandSchema = v.strictObject({
  realmId: id,
  head: id,
  key: id,
  presentation: realmPresentationSchema,
});
export const realmAppearanceReadSchema = v.strictObject({ realmId: id });
export const realmAppearanceChoiceSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('image'),
    realmId: id,
    mediaId: id,
    purpose: v.picklist(['realm-icon', 'realm-banner']),
  }),
  v.strictObject({ kind: v.literal('rules'), realmId: id, postId: id, revisionId: id }),
]);
export type RealmPresentation = v.InferOutput<typeof realmPresentationSchema>;
export type RealmAppearanceCommand = v.InferOutput<typeof realmAppearanceCommandSchema>;
export type RealmAppearanceChoice = v.InferOutput<typeof realmAppearanceChoiceSchema>;
export type RealmImageSlot = 'avatar' | 'banner';
export type RealmRulesSummary = Readonly<{ postId: string; revisionId: string; title: string; summary: string }>;
export type RealmAppearanceDraft = Readonly<{
  presentation: RealmPresentation;
  avatar: RealmPresentationOptional<RealmPresentationImage>;
  banner: RealmPresentationOptional<RealmPresentationImage>;
  rules: RealmPresentationOptional<RealmRulesSummary>;
}>;
export type RealmAppearanceSnapshot = RealmAppearanceDraft &
  Readonly<{
    realmId: string;
    head: string;
    title: string;
    contextId: string;
    state: 'active' | 'removed' | 'orphaned';
    canManage: boolean;
  }>;
export type RealmAppearanceRead =
  | { kind: 'ready'; snapshot: RealmAppearanceSnapshot }
  | { kind: 'hidden' | 'unavailable' };
export type RealmAppearanceResult =
  | { kind: 'confirmed'; snapshot: RealmAppearanceSnapshot }
  | { kind: 'conflict' | 'denied' | 'invalid' }
  | { kind: 'unavailable'; read?: RealmAppearanceRead };
export type RealmAppearanceSelection =
  | { kind: 'image'; image: RealmPresentationImage }
  | { kind: 'image-reference'; mediaId: string; realmId: string; purpose: 'realm-icon' | 'realm-banner' }
  | { kind: 'rules'; rules: RealmRulesSummary }
  | { kind: 'unavailable' };
export type RealmAppearanceAdapter = Readonly<{
  read(realmId: string): Promise<RealmAppearanceRead>;
  change(command: RealmAppearanceCommand): Promise<RealmAppearanceResult>;
  select(choice: RealmAppearanceChoice): Promise<RealmAppearanceSelection>;
  upload(realmId: string, slot: RealmImageSlot, file: File, signal: AbortSignal): Promise<{ id: string }>;
  resume(mediaId: string, file: File, realmId: string, signal: AbortSignal): Promise<{ id: string }>;
}>;

/** A DTO is never permission. Every resulting request still uses current media download authorization. */
export function realmImageSource(image: RealmPresentationOptional<RealmPresentationImage>): string | null {
  if (image.state !== 'available' || image.value.variants.length > 12) return null;
  const variant = [...image.value.variants]
    .filter((item) => item.width > 0 && item.height > 0)
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  return variant ? coverSrc(image.value.id, variant.format, variant.width) : null;
}

/** The board/header owner consumes these exact optional DTOs, without cover/account-image coercion. */
export function realmPresentationAssets(draft: RealmAppearanceDraft) {
  return { avatar: draft.avatar, banner: draft.banner };
}

export function sameRealmPresentation(a: RealmPresentation, b: RealmPresentation): boolean {
  return (
    a.avatarMediaId === b.avatarMediaId &&
    a.bannerMediaId === b.bannerMediaId &&
    a.rules?.postId === b.rules?.postId &&
    a.rules?.revisionId === b.rules?.revisionId
  );
}

export type RealmAppearanceState = Readonly<{
  read: RealmAppearanceRead;
  draft: RealmAppearanceDraft | null;
  attempt: RealmAppearanceCommand | null;
  phase: 'idle' | 'saving' | 'uploading' | 'conflict' | 'uncertain' | 'saved';
  notice: 'none' | 'unavailable' | 'denied' | 'invalid';
  reviewed: boolean;
  busy: boolean;
  uploadSlot: RealmImageSlot | null;
  pendingUpload: { slot: RealmImageSlot; mediaId: string } | null;
}>;

export function realmAppearanceHasUnsavedChanges(state: RealmAppearanceState, baseline?: RealmPresentation): boolean {
  return Boolean(
    state.attempt ||
    state.pendingUpload ||
    state.uploadSlot ||
    (state.draft && baseline && !sameRealmPresentation(state.draft.presentation, baseline)),
  );
}

/** Local view state only; native commands retain all permission, source and lifecycle authority. */
export function createRealmAppearance(
  realmId: string,
  initial: RealmAppearanceRead,
  adapter: RealmAppearanceAdapter,
  newKey: () => string = () => crypto.randomUUID(),
  lifetime?: RealmAppearanceCallerLifetime,
) {
  function admitted(read: RealmAppearanceRead): read is Extract<RealmAppearanceRead, { kind: 'ready' }> {
    return read.kind === 'ready' && read.snapshot.realmId === realmId && read.snapshot.state === 'active';
  }
  let state: RealmAppearanceState = {
    read: initial.kind === 'ready' ? (admitted(initial) ? initial : { kind: 'hidden' }) : initial,
    draft: admitted(initial) ? initial.snapshot : null,
    attempt: null,
    phase: 'idle',
    notice: 'none',
    reviewed: false,
    busy: false,
    uploadSlot: null,
    pendingUpload: null,
  };
  const hiddenState: RealmAppearanceState = {
    read: { kind: 'hidden' },
    draft: null,
    attempt: null,
    phase: 'idle',
    notice: 'none',
    reviewed: false,
    busy: false,
    uploadSlot: null,
    pendingUpload: null,
  };
  let uploadAbort: AbortController | null = null;
  // The original file stays in this caller only. A retry never reserves another object.
  let retainedUpload: {
    file: File;
    slot: RealmImageSlot;
    purpose: 'realm-icon' | 'realm-banner';
    mediaId: string | null;
  } | null = null;
  let readVersion = 0;
  let operationGeneration = 0;
  let connected = true;
  let retired = false;
  let stopLifetime: (() => void) | undefined;
  const listeners = new Set<() => void>();
  type Ticket = { operation: number; caller: number; readVersion: number; head: string | null };

  function publish() {
    for (const listener of listeners) listener();
  }
  function retireLocal() {
    if (retired) return;
    retired = true;
    retainedUpload = null;
    operationGeneration++;
    uploadAbort?.abort();
    uploadAbort = null;
    state = hiddenState;
    stopLifetime?.();
    stopLifetime = undefined;
    publish();
  }
  function active() {
    if (retired || !connected) return false;
    if (lifetime && !lifetime.current()) {
      retireLocal();
      return false;
    }
    return true;
  }
  function update(change: Partial<RealmAppearanceState>) {
    if (!active()) return;
    if ('pendingUpload' in change && change.pendingUpload === null) retainedUpload = null;
    state = { ...state, ...change };
    publish();
  }
  function operation() {
    if (!active()) return null;
    return {
      operation: ++operationGeneration,
      caller: lifetime?.ticket() ?? 0,
      readVersion,
      head: admitted(state.read) ? state.read.snapshot.head : null,
    } satisfies Ticket;
  }
  function operationCurrent(ticket: Ticket) {
    return active() && operationGeneration === ticket.operation && (!lifetime || lifetime.owns(ticket.caller));
  }
  function owns(ticket: Ticket) {
    return (
      operationCurrent(ticket) &&
      readVersion === ticket.readVersion &&
      (ticket.head === null || (admitted(state.read) && state.read.snapshot.head === ticket.head))
    );
  }
  function selectable() {
    return (
      active() &&
      admitted(state.read) &&
      state.read.snapshot.canManage &&
      !state.attempt &&
      (!state.busy || state.phase === 'uploading') &&
      (state.phase === 'idle' || state.phase === 'saved' || state.phase === 'uploading')
    );
  }
  function editable() {
    return selectable() && !state.busy && !state.pendingUpload;
  }
  function retireUpload() {
    operationGeneration++;
    uploadAbort?.abort();
    uploadAbort = null;
    state = { ...state, uploadSlot: null };
  }
  function cancelUpload() {
    if (!active() || (!uploadAbort && !state.pendingUpload && state.phase !== 'uploading')) return;
    retireUpload();
    update({ busy: false, phase: 'idle', pendingUpload: null });
  }
  function observe(incoming: RealmAppearanceRead, refreshed = false) {
    if (!active()) return;
    const read = incoming.kind === 'ready' && !admitted(incoming) ? { kind: 'hidden' as const } : incoming;
    const reviewed = state.phase === 'conflict' && admitted(read) && read.snapshot.canManage;
    if (read === state.read) {
      if (refreshed) update({ busy: false, reviewed });
      return;
    }
    readVersion++;
    const changed = admitted(read) && admitted(state.read) && read.snapshot.head !== state.read.snapshot.head;
    // A read replaces the authority behind asynchronous previews and responses, not the saved intent.
    const uploading = Boolean(uploadAbort || state.pendingUpload || state.phase === 'uploading');
    const saving = state.phase === 'saving';
    if (uploading) retireUpload();
    else if (saving) operationGeneration++;
    update({
      read,
      draft: state.draft ?? (admitted(read) ? read.snapshot : null),
      ...(refreshed ? { busy: false, reviewed } : {}),
      ...(uploading ? { busy: false, phase: 'idle' as const, pendingUpload: null } : {}),
      ...(saving ? { busy: false, phase: 'uncertain' as const } : {}),
      ...(changed && !state.attempt && (!state.busy || uploading || refreshed)
        ? { phase: 'conflict' as const, reviewed: true }
        : {}),
    });
  }
  function choose(slot: RealmImageSlot | 'rules', selection: RealmAppearanceSelection) {
    if (!selectable() || !state.draft) return;
    const draft = state.draft;
    let selected: RealmAppearanceDraft;
    if (slot === 'rules' && selection.kind === 'rules') {
      selected = {
        ...draft,
        rules: { state: 'available', value: selection.rules },
        presentation: {
          ...draft.presentation,
          rules: { postId: selection.rules.postId, revisionId: selection.rules.revisionId },
        },
      };
    } else if (
      slot !== 'rules' &&
      selection.kind === 'image-reference' &&
      selection.realmId === realmId &&
      selection.purpose === (slot === 'avatar' ? 'realm-icon' : 'realm-banner')
    ) {
      selected = {
        ...draft,
        [slot]: { state: 'unavailable', value: null },
        presentation: {
          ...draft.presentation,
          [slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']: selection.mediaId,
        },
      };
    } else if (
      slot !== 'rules' &&
      selection.kind === 'image' &&
      selection.image.containerId === realmId &&
      realmImageSource({ state: 'available', value: selection.image })
    ) {
      selected = {
        ...draft,
        [slot]: { state: 'available', value: selection.image },
        presentation: {
          ...draft.presentation,
          [slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']: selection.image.id,
        },
      };
    } else return;
    retireUpload();
    update({ draft: selected, busy: false, pendingUpload: null, phase: 'idle', notice: 'none' });
  }
  function clear(slot: RealmImageSlot | 'rules') {
    if (!selectable() || !state.draft) return;
    retireUpload();
    const key = slot === 'rules' ? 'rules' : slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId';
    update({
      draft: {
        ...state.draft,
        [slot]: { state: 'none', value: null },
        presentation: { ...state.draft.presentation, [key]: null },
      },
      phase: 'idle',
      notice: 'none',
      busy: false,
      pendingUpload: null,
    });
  }
  async function refresh() {
    if (state.busy) return;
    const ticket = operation();
    if (!ticket) return;
    update({ busy: true });
    if (!owns(ticket)) return;
    let read: RealmAppearanceRead;
    try {
      read = await adapter.read(realmId);
    } catch {
      read = { kind: 'unavailable' };
    }
    if (!operationCurrent(ticket)) return;
    if (!owns(ticket)) {
      update({ busy: false });
      return;
    }
    observe(read, true);
  }
  async function save() {
    if (state.busy || !admitted(state.read) || !state.read.snapshot.canManage || !state.draft || state.pendingUpload)
      return;
    if (state.phase === 'conflict') return;
    if (state.attempt && state.phase !== 'uncertain') return;
    const ticket = operation();
    if (!ticket) return;
    const contextId = state.read.snapshot.contextId;
    const attempt =
      state.attempt ??
      v.parse(realmAppearanceCommandSchema, {
        realmId,
        head: state.read.snapshot.head,
        key: newKey(),
        presentation: structuredClone(state.draft.presentation),
      });
    update({ attempt, busy: true, phase: 'saving', notice: 'none', reviewed: false });
    if (!owns(ticket)) return;
    let result: RealmAppearanceResult;
    try {
      result = await adapter.change(structuredClone(attempt));
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!operationCurrent(ticket)) return;
    if (!owns(ticket)) {
      update({ busy: false, phase: 'uncertain' });
      return;
    }
    if (result.kind === 'confirmed') {
      const snapshot = result.snapshot;
      if (
        snapshot.realmId !== realmId ||
        snapshot.state !== 'active' ||
        !snapshot.head ||
        snapshot.contextId !== contextId ||
        !sameRealmPresentation(snapshot.presentation, attempt.presentation)
      ) {
        update({ busy: false, phase: 'uncertain' });
        return;
      }
      // A replay can settle the original intent without replacing the current source disclosure.
      if (attempt.head !== ticket.head) {
        const current = state.read.snapshot;
        update(
          snapshot.head === current.head && sameRealmPresentation(current.presentation, attempt.presentation)
            ? { draft: current, attempt: null, phase: 'saved', busy: false }
            : { phase: 'conflict', reviewed: true, busy: false },
        );
        return;
      }
      update({ read: { kind: 'ready', snapshot }, draft: snapshot, attempt: null, phase: 'saved', busy: false });
    } else if (result.kind === 'unavailable') {
      if (result.read) observe(result.read);
      update({ phase: 'uncertain', busy: false });
    } else if (result.kind === 'conflict') {
      update({ phase: 'conflict', busy: false });
    } else {
      update({
        notice: result.kind,
        phase: 'idle',
        busy: false,
        attempt: null,
        ...(result.kind === 'denied' ? { read: { kind: 'hidden' as const } } : {}),
      });
    }
  }
  async function resolveSelection(
    choice: RealmAppearanceChoice,
    stillSelected: () => boolean = () => true,
  ): Promise<RealmAppearanceSelection | null> {
    if (!editable() || !stillSelected()) return null;
    const ticket = operation();
    if (!ticket || !owns(ticket) || !stillSelected()) return null;
    let selected: RealmAppearanceSelection;
    try {
      selected = await adapter.select(choice);
    } catch {
      selected = { kind: 'unavailable' };
    }
    return owns(ticket) && stillSelected() ? selected : null;
  }
  async function upload(slot: RealmImageSlot, file?: File) {
    // A file is a new selection. Only an explicit retry may reuse a reservation.
    if (file) {
      if (!selectable()) return;
      cancelUpload();
    }
    const pending = file ? null : state.pendingUpload;
    const uploadSlot = pending?.slot ?? slot;
    if (!pending && !editable()) return;
    if (state.busy || !admitted(state.read) || !state.read.snapshot.canManage || (!file && !pending)) return;
    const purpose = uploadSlot === 'avatar' ? 'realm-icon' : 'realm-banner';
    if (file) retainedUpload = { file, slot: uploadSlot, purpose, mediaId: null };
    else if (
      !pending ||
      !retainedUpload ||
      retainedUpload.slot !== pending.slot ||
      retainedUpload.purpose !== purpose ||
      (retainedUpload.mediaId !== null && retainedUpload.mediaId !== pending.mediaId)
    )
      return;
    const original = file ?? retainedUpload?.file;
    if (!original) return;
    const ticket = operation();
    if (!ticket) return;
    const abort = new AbortController();
    uploadAbort = abort;
    update({ busy: true, phase: 'uploading', notice: 'none', uploadSlot });
    let mediaId = pending?.mediaId;
    try {
      if (!owns(ticket) || abort.signal.aborted) return;
      const media = pending
        ? await adapter.resume(pending.mediaId, original, realmId, abort.signal)
        : await adapter.upload(realmId, uploadSlot, original, abort.signal);
      mediaId = media.id;
      if (abort.signal.aborted || !owns(ticket)) return;
      if (retainedUpload?.file === original) retainedUpload = { ...retainedUpload, mediaId };
      update({ pendingUpload: { slot: uploadSlot, mediaId } });
      if (!owns(ticket) || abort.signal.aborted) return;
      const choice = await adapter.select({
        kind: 'image',
        realmId,
        mediaId,
        purpose: uploadSlot === 'avatar' ? 'realm-icon' : 'realm-banner',
      });
      if (abort.signal.aborted || !owns(ticket)) return;
      if (
        !(
          (choice.kind === 'image' &&
            choice.image.id === mediaId &&
            choice.image.containerId === realmId &&
            realmImageSource({ state: 'available', value: choice.image })) ||
          (choice.kind === 'image-reference' &&
            choice.mediaId === mediaId &&
            choice.realmId === realmId &&
            choice.purpose === (uploadSlot === 'avatar' ? 'realm-icon' : 'realm-banner'))
        )
      )
        throw new Error('Image summary unavailable');
      choose(uploadSlot, choice);
    } catch (error) {
      if (abort.signal.aborted || !owns(ticket)) return;
      if (!mediaId && error && typeof error === 'object' && 'mediaId' in error && typeof error.mediaId === 'string')
        mediaId = error.mediaId;
      if (error && typeof error === 'object' && 'reason' in error && error.reason === 'rejected') {
        update({ busy: false, phase: 'idle', notice: 'unavailable', pendingUpload: null });
        return;
      }
      if (retainedUpload?.file === original && mediaId) retainedUpload = { ...retainedUpload, mediaId };
      update({
        busy: false,
        phase: 'idle',
        notice: 'unavailable',
        pendingUpload: mediaId ? { slot: uploadSlot, mediaId } : null,
      });
    } finally {
      if (uploadAbort === abort) {
        uploadAbort = null;
        update({ uploadSlot: null });
      }
    }
  }
  if (lifetime) {
    stopLifetime = lifetime.subscribe(() => {
      if (lifetime.current()) publish();
      else retireLocal();
    });
  }
  return {
    getSnapshot: () => (active() ? state : hiddenState),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    editable,
    selectable,
    observe,
    choose,
    clear,
    refresh,
    save,
    resolveSelection,
    upload,
    connect() {
      if (retired) return () => {};
      connected = true;
      operationGeneration++;
      return disconnect;
    },
    disconnect,
    cancelUpload,
    reviewConflict() {
      if (
        active() &&
        state.phase === 'conflict' &&
        state.reviewed &&
        admitted(state.read) &&
        state.read.snapshot.canManage
      )
        update({ attempt: null, phase: 'idle', reviewed: false });
    },
  };

  function disconnect() {
    if (!connected || retired) return;
    connected = false;
    operationGeneration++;
    uploadAbort?.abort();
    uploadAbort = null;
    if (state.busy) {
      state = {
        ...state,
        busy: false,
        uploadSlot: null,
        phase: state.attempt ? 'uncertain' : 'idle',
      };
    }
    publish();
    // Strict Mode reconnects this controller synchronously; a real unmount clears its private draft.
    queueMicrotask(() => {
      if (!connected) retireLocal();
    });
  }
}
