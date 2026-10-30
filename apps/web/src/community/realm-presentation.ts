import type { MediaImportRequest } from '@rezics/definitions/media-import';
import * as v from 'valibot';
import { coverSrc } from '../media/cover-src';

// Isolated pending-producer types. Replace with the generated realm-media exports when delivered.
// These match services/kernel/src/content/realm-media.ts in the adopted native contract.
export type RealmPresentationOptional<T> =
  | Readonly<{ state: 'available'; value: T }>
  | Readonly<{ state: 'none' | 'unavailable'; value: null }>;
export type RealmPresentationImage = Readonly<{
  id: string;
  containerId: string;
  digest: string;
  width: number;
  height: number;
  variants: readonly Readonly<{ format: 'avif' | 'webp'; width: number; height: number }>[];
  placeholder: Readonly<{ thumbhash: string; color: string }> | null;
  focalPoint: Readonly<{ x: number; y: number }> | null;
  credit: MediaImportRequest['credit'] | null;
}>;
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
  | { kind: 'conflict' | 'denied' | 'invalid' | 'unavailable' };
export type RealmAppearanceSelection =
  | { kind: 'image'; image: RealmPresentationImage }
  | { kind: 'rules'; rules: RealmRulesSummary }
  | { kind: 'unavailable' };
export type RealmAppearanceAdapter = Readonly<{
  read(realmId: string): Promise<RealmAppearanceRead>;
  change(command: RealmAppearanceCommand): Promise<RealmAppearanceResult>;
  select(choice: RealmAppearanceChoice): Promise<RealmAppearanceSelection>;
  upload(realmId: string, slot: RealmImageSlot, file: File, signal: AbortSignal): Promise<{ id: string }>;
  resume(mediaId: string, signal: AbortSignal): Promise<{ id: string }>;
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
  pendingUpload: { slot: RealmImageSlot; mediaId: string } | null;
}>;

/** Local view state only; native commands retain all permission, source and lifecycle authority. */
export function createRealmAppearance(
  realmId: string,
  initial: RealmAppearanceRead,
  adapter: RealmAppearanceAdapter,
  newKey: () => string = () => crypto.randomUUID(),
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
    pendingUpload: null,
  };
  let uploadAbort: AbortController | null = null;
  let readVersion = 0;
  const listeners = new Set<() => void>();
  function update(change: Partial<RealmAppearanceState>) {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  }
  function editable() {
    return (
      admitted(state.read) &&
      state.read.snapshot.canManage &&
      !state.busy &&
      !state.attempt &&
      !state.pendingUpload &&
      (state.phase === 'idle' || state.phase === 'saved')
    );
  }
  function observe(incoming: RealmAppearanceRead) {
    const read = incoming.kind === 'ready' && !admitted(incoming) ? { kind: 'hidden' as const } : incoming;
    if (read === state.read) return;
    readVersion++;
    const changed = admitted(read) && admitted(state.read) && read.snapshot.head !== state.read.snapshot.head;
    update({
      read,
      draft: state.draft ?? (admitted(read) ? read.snapshot : null),
      ...(changed && !state.attempt && !state.busy ? { phase: 'conflict' as const, reviewed: true } : {}),
    });
  }
  function choose(slot: RealmImageSlot | 'rules', selection: RealmAppearanceSelection) {
    if (!editable() || !state.draft) return;
    const draft = state.draft;
    if (slot === 'rules' && selection.kind === 'rules') {
      update({
        draft: {
          ...draft,
          rules: { state: 'available', value: selection.rules },
          presentation: {
            ...draft.presentation,
            rules: { postId: selection.rules.postId, revisionId: selection.rules.revisionId },
          },
        },
        phase: 'idle',
        notice: 'none',
      });
    } else if (
      slot !== 'rules' &&
      selection.kind === 'image' &&
      selection.image.containerId === realmId &&
      realmImageSource({ state: 'available', value: selection.image })
    ) {
      update({
        draft: {
          ...draft,
          [slot]: { state: 'available', value: selection.image },
          presentation: {
            ...draft.presentation,
            [slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId']: selection.image.id,
          },
        },
        phase: 'idle',
        notice: 'none',
      });
    }
  }
  function clear(slot: RealmImageSlot | 'rules') {
    if (!editable() || !state.draft) return;
    const key = slot === 'rules' ? 'rules' : slot === 'avatar' ? 'avatarMediaId' : 'bannerMediaId';
    update({
      draft: {
        ...state.draft,
        [slot]: { state: 'none', value: null },
        presentation: { ...state.draft.presentation, [key]: null },
      },
      phase: 'idle',
      notice: 'none',
    });
  }
  async function refresh() {
    if (state.busy) return;
    update({ busy: true });
    let read: RealmAppearanceRead;
    try {
      read = await adapter.read(realmId);
    } catch {
      read = { kind: 'unavailable' };
    }
    if (read.kind === 'ready' && !admitted(read)) read = { kind: 'hidden' };
    update({
      read,
      busy: false,
      draft: state.draft ?? (admitted(read) ? read.snapshot : null),
      reviewed: state.phase === 'conflict' && admitted(read) && read.snapshot.canManage,
    });
  }
  async function save() {
    if (state.busy || !admitted(state.read) || !state.read.snapshot.canManage || !state.draft || state.pendingUpload)
      return;
    if (state.phase === 'conflict') return;
    if (state.attempt && state.phase !== 'uncertain') return;
    const contextId = state.read.snapshot.contextId;
    const version = readVersion;
    const attempt =
      state.attempt ??
      v.parse(realmAppearanceCommandSchema, {
        realmId,
        head: state.read.snapshot.head,
        key: newKey(),
        presentation: structuredClone(state.draft.presentation),
      });
    update({ attempt, busy: true, phase: 'saving', notice: 'none', reviewed: false });
    let result: RealmAppearanceResult;
    try {
      result = await adapter.change(structuredClone(attempt));
    } catch {
      result = { kind: 'unavailable' };
    }
    if (version !== readVersion) {
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
      update({ read: { kind: 'ready', snapshot }, draft: snapshot, attempt: null, phase: 'saved', busy: false });
    } else if (result.kind === 'unavailable') {
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
  async function upload(slot: RealmImageSlot, file?: File) {
    const pending = state.pendingUpload;
    if (!pending && !editable()) return;
    if (state.busy || !admitted(state.read) || !state.read.snapshot.canManage || (!file && !pending)) return;
    const abort = new AbortController();
    uploadAbort = abort;
    update({ busy: true, phase: 'uploading', notice: 'none' });
    let mediaId = pending?.mediaId;
    try {
      const media = pending
        ? await adapter.resume(pending.mediaId, abort.signal)
        : await adapter.upload(realmId, slot, file!, abort.signal);
      mediaId = media.id;
      if (abort.signal.aborted) return;
      if (!admitted(state.read) || !state.read.snapshot.canManage) {
        update({ busy: false, phase: 'idle', pendingUpload: { slot, mediaId } });
        return;
      }
      update({ pendingUpload: { slot, mediaId } });
      const choice = await adapter.select({
        kind: 'image',
        realmId,
        mediaId,
        purpose: slot === 'avatar' ? 'realm-icon' : 'realm-banner',
      });
      if (abort.signal.aborted) return;
      if (!admitted(state.read) || !state.read.snapshot.canManage) {
        update({ busy: false, phase: 'idle', pendingUpload: { slot, mediaId } });
        return;
      }
      if (
        choice.kind !== 'image' ||
        choice.image.id !== mediaId ||
        choice.image.containerId !== realmId ||
        !realmImageSource({ state: 'available', value: choice.image })
      )
        throw new Error('Image summary unavailable');
      update({ busy: false, phase: 'idle', pendingUpload: null });
      choose(slot, choice);
    } catch (error) {
      if (abort.signal.aborted) return;
      if (!mediaId && error && typeof error === 'object' && 'mediaId' in error && typeof error.mediaId === 'string')
        mediaId = error.mediaId;
      update({ busy: false, phase: 'idle', notice: 'unavailable', pendingUpload: mediaId ? { slot, mediaId } : null });
    } finally {
      if (uploadAbort === abort) uploadAbort = null;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    editable,
    observe,
    choose,
    clear,
    refresh,
    save,
    upload,
    cancelUpload() {
      uploadAbort?.abort();
      uploadAbort = null;
      update({ busy: false, phase: 'idle', pendingUpload: null });
    },
    reviewConflict() {
      if (state.phase === 'conflict' && state.reviewed && admitted(state.read) && state.read.snapshot.canManage)
        update({ attempt: null, phase: 'idle', reviewed: false });
    },
  };
}
