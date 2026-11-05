import { parseAvatarUploadAdvice } from '../media/kernel';
import {
  createMediaReservationIntent,
  readSiteAvatarUploadAdvice,
  UploadRefusal,
  type MediaReservationIntent,
  type UploadStage,
  type UploadStageUpdate,
  type UploadResponseWait,
} from '../threads/upload';
import { preferenceRetryDeadline } from './preference-failure-retry';
import { withProfileDeadline } from './profile-request-deadline';
import type { ProfileValues } from './profile-data';
import type { ProfileEditor } from './profile-write';
import { readAvatarCropSource } from './profile-avatar-source';
import {
  avatarCropSourceSupported,
  avatarUploadFailure,
  constrainAvatarCrop,
  createCroppedAvatarFile,
  decodeAvatarCrop,
  initialAvatarCrop,
  type AvatarCropIssue,
  type AvatarCropPosition,
} from './profile-avatar-crop.ts';

export type AvatarUpload = (
  accountId: string,
  file: File,
  signal: AbortSignal,
  intent?: MediaReservationIntent,
  onStage?: UploadStageUpdate,
  onResponseWait?: UploadResponseWait,
) => Promise<{ src: string }>;
export type AvatarResume = (
  mediaId: string,
  file: File,
  signal: AbortSignal,
  onStage?: UploadStageUpdate,
  intent?: MediaReservationIntent,
  onResponseWait?: UploadResponseWait,
) => Promise<{ src: string }>;
export type AvatarAdviceReadResult = {
  ok: boolean;
  body?: unknown;
  retryAfter?: string;
  responseTime: number;
};
export type AvatarAdviceRead = (
  signal: AbortSignal,
  onResponseWait?: UploadResponseWait,
) => Promise<AvatarAdviceReadResult>;
export type AvatarAdviceState = 'loading' | 'unavailable' | 'denied' | 'allowed';
type Failure = Pick<UploadRefusal, 'reason' | 'retryAfter'>;
type Avatar = ProfileValues['avatar'];
type Selection = {
  accountId: string;
  file: File;
  url: string;
  before: Avatar;
  bitmap?: ImageBitmap;
  source?: { width: number; height: number };
  crop?: AvatarCropPosition;
  reservation?: string;
  media?: string;
  intent?: MediaReservationIntent;
};
type UploadState = {
  phase: 'idle' | 'preparing' | 'crop' | 'original-only' | 'exporting' | 'uploading' | 'ready' | 'error' | 'cancelled';
  url: string | null;
  crop?: { width: number; height: number; position: AvatarCropPosition };
  cropIssue?: AvatarCropIssue;
  failure?: Failure;
  retryAt?: number;
  adviceRetryAt?: number;
  stage?: UploadStage;
  advice?: AvatarAdviceState;
};
const idle: UploadState = { phase: 'idle', url: null };
type AvatarWaits = {
  commandRetryAt: number;
  commandFailure?: Failure;
  adviceTarget: string | null;
  adviceRetryAt: number;
};
const waitsByEditor = new WeakMap<ProfileEditor, AvatarWaits>();

function waitsFor(editor: ProfileEditor): AvatarWaits {
  let waits = waitsByEditor.get(editor);
  if (!waits) {
    waits = { commandRetryAt: 0, adviceTarget: null, adviceRetryAt: 0 };
    waitsByEditor.set(editor, waits);
  }
  return waits;
}

export const avatarMedia = (avatar: Avatar) => avatar?.media ?? null;

/** Owns only this card's local preview and request; cancellation never promises provider cleanup. */
export class ProfileAvatarUpload {
  private state = idle;
  private selection: Selection | null = null;
  private request: AbortController | null = null;
  private preparationRequest: AbortController | null = null;
  private listeners = new Set<() => void>();
  private connected = false;
  private preparation = 0;
  private readonly waits: AvatarWaits;
  private advice: AvatarAdviceState = 'loading';
  private adviceRequest: AbortController | null = null;
  private adviceTarget: string | null = null;
  private adviceEpisode = 0;
  constructor(
    private editor: ProfileEditor,
    private upload: AvatarUpload,
    private urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
    private resume?: AvatarResume,
    private readAdvice: AvatarAdviceRead = readSiteAvatarUploadAdvice,
  ) {
    this.waits = waitsFor(editor);
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: UploadState) {
    const failure = state.failure ?? this.waits.commandFailure;
    const next: UploadState =
      Date.now() < this.waits.commandRetryAt
        ? { ...state, retryAt: this.waits.commandRetryAt, ...(failure ? { failure } : {}) }
        : { ...state };
    if (this.waits.adviceRetryAt > 0) next.adviceRetryAt = this.waits.adviceRetryAt;
    else delete next.adviceRetryAt;
    this.state = { ...next, advice: this.advice };
    this.listeners.forEach((listener) => listener());
  }
  private waiting() {
    return Date.now() < this.waits.commandRetryAt;
  }
  connect() {
    this.connected = true;
    const unsubscribe = this.editor.subscribe(() => this.reconcile());
    this.reconcile();
    return () => {
      this.connected = false;
      unsubscribe();
      this.adviceRequest?.abort();
      this.adviceRequest = null;
      this.adviceTarget = null;
      this.adviceEpisode++;
      this.advice = 'unavailable';
      this.clear();
    };
  }
  canUpload = () => {
    const draft = this.live();
    return this.advice === 'allowed' && !!draft && draft.accountId === this.adviceTarget;
  };
  private live() {
    const { draft, phase, attempt } = this.editor.snapshot();
    return this.connected && draft && !attempt && !['saving', 'reloading', 'unavailable'].includes(phase)
      ? draft
      : null;
  }
  private target() {
    const { draft, phase } = this.editor.snapshot();
    return draft && phase !== 'unavailable' ? draft.accountId : null;
  }
  private observeTarget(target: string | null) {
    this.adviceEpisode++;
    this.adviceTarget = target;
    if (this.waits.adviceTarget !== target) {
      this.waits.adviceTarget = target;
      this.waits.adviceRetryAt = 0;
    }
    this.adviceRequest?.abort();
    this.adviceRequest = null;
    this.advice = target ? 'loading' : 'unavailable';
    this.update(this.state);
    if (target) this.startAdviceRead(target, this.adviceEpisode);
  }
  private startAdviceRead(target: string, episode: number) {
    const request = new AbortController();
    this.adviceRequest = request;
    void this.readAdviceFor(target, episode, request);
  }
  private async readAdviceFor(target: string, episode: number, request: AbortController) {
    try {
      const onResponseWait: UploadResponseWait = (_status, retryAfter, responseTime) =>
        this.retainAdviceWait(target, retryAfter, responseTime);
      const result = await withProfileDeadline((signal) => this.readAdvice(signal, onResponseWait), request.signal);
      if (!this.ownsAdvice(target, episode, request)) return;
      this.retainAdviceWait(target, result.retryAfter, result.responseTime);
      const parsed = result.ok ? parseAvatarUploadAdvice(result.body, target) : null;
      this.advice = !parsed ? 'unavailable' : parsed.allowedActions.length ? 'allowed' : 'denied';
    } catch (error) {
      if (!this.ownsAdvice(target, episode, request)) return;
      if (error instanceof UploadRefusal)
        this.retainAdviceWait(target, error.retryAfterHeader, error.responseTime ?? Date.now());
      this.advice = 'unavailable';
    } finally {
      const current = this.connected && this.adviceEpisode === episode && this.adviceTarget === target;
      if (this.adviceRequest === request) this.adviceRequest = null;
      if (current) this.update(this.state);
    }
  }
  private retainAdviceWait(target: string, retryAfter: string | undefined, responseTime: number) {
    if (this.waits.adviceTarget !== target) return;
    const deadline = preferenceRetryDeadline(retryAfter, responseTime);
    if (deadline <= this.waits.adviceRetryAt) return;
    this.waits.adviceRetryAt = deadline;
    if (this.connected && this.adviceTarget === target) this.update(this.state);
  }
  private retainCommandWait(status: number, retryAfter: string | undefined, responseTime: number) {
    const deadline = preferenceRetryDeadline(retryAfter, responseTime);
    if (deadline > this.waits.commandRetryAt) this.waits.commandRetryAt = deadline;
    if (status === 429) this.waits.commandFailure = { reason: 'rate-limited' };
    if (this.connected && (deadline > 0 || status === 429)) this.update(this.state);
  }
  private currentAdviceEpisode(target: string, episode: number) {
    return this.connected && this.adviceTarget === target && this.adviceEpisode === episode && this.target() === target;
  }
  private ownsAdvice(target: string, episode: number, request: AbortController) {
    return this.currentAdviceEpisode(target, episode) && this.adviceRequest === request && !request.signal.aborted;
  }
  canOfferAdviceRetry = () =>
    this.connected &&
    !!this.adviceTarget &&
    !!this.live() &&
    this.target() === this.adviceTarget &&
    this.advice !== 'loading' &&
    (this.advice === 'unavailable' || this.advice === 'denied' || (!!this.selection && this.state.phase === 'error'));
  canRetryAdvice = () => this.canOfferAdviceRetry() && Date.now() >= this.waits.adviceRetryAt;
  retryAdvice = () => {
    if (!this.canRetryAdvice() || !this.adviceTarget) return;
    const target = this.adviceTarget;
    const episode = this.adviceEpisode;
    this.advice = 'loading';
    this.update(this.state);
    this.startAdviceRead(target, episode);
  };
  private clear() {
    // Invalidate ownership before abort listeners or a late promise can run.
    this.preparation++;
    const selection = this.selection;
    this.selection = null;
    const preparationRequest = this.preparationRequest;
    this.preparationRequest = null;
    preparationRequest?.abort();
    const request = this.request;
    this.request = null;
    request?.abort();
    if (selection) {
      selection.bitmap?.close();
      this.urls.revokeObjectURL(selection.url);
    }
    this.update(idle);
  }
  private reconcile() {
    const { draft, known, phase } = this.editor.snapshot();
    const target = draft && phase !== 'unavailable' ? draft.accountId : null;
    if (this.adviceTarget !== target) this.observeTarget(target);
    const selection = this.selection;
    if (!draft || phase === 'unavailable') {
      if (selection) this.clear();
      return;
    }
    if (selection && draft.accountId !== selection.accountId) {
      this.clear();
      return;
    }
    if (!selection) return;
    if (selection.media && avatarMedia(known?.avatar ?? null) === selection.media) this.clear();
    else if (avatarMedia(draft.avatar) !== (selection.media ?? avatarMedia(selection.before))) this.clear();
  }
  private editable() {
    return this.live();
  }
  cancel = () => {
    const draft = this.editable();
    if (!draft) return;
    const selection = this.selection;
    this.clear();
    if (selection?.media && avatarMedia(draft.avatar) === selection.media)
      this.editor.edit({ avatar: selection.before });
    this.update({ phase: 'cancelled', url: null });
  };
  remove = () => {
    if (!this.editable()) return;
    this.clear();
    this.editor.edit({ avatar: null });
  };
  choose = (file: File | undefined) => {
    if (!file || !this.canUpload()) return;
    // Replacement restores only our prior avatar draft, preserving all other edits.
    this.cancel();
    const draft = this.editable();
    if (!draft) return;
    let url: string;
    try {
      url = this.urls.createObjectURL(file);
    } catch {
      this.update({ phase: 'error', url: null });
      return;
    }
    const selection: Selection = { accountId: draft.accountId, file, url, before: draft.avatar };
    this.selection = selection;
    this.editor.edit({});
    const failure = avatarUploadFailure(file);
    if (failure) {
      this.update({ phase: 'error', url, failure: { reason: failure } });
      return;
    }
    const preparation = ++this.preparation;
    const request = new AbortController();
    this.preparationRequest = request;
    this.update({ phase: 'preparing', url: null });
    void this.prepare(selection, preparation, request.signal);
  };
  setCrop = (patch: Partial<AvatarCropPosition>) => {
    const selection = this.selection;
    if (!selection?.source || !selection.crop || this.state.phase !== 'crop') return;
    selection.crop = constrainAvatarCrop(selection.source, { ...selection.crop, ...patch });
    this.update({
      phase: 'crop',
      url: selection.url,
      crop: { ...selection.source, position: selection.crop },
    });
  };
  applyCrop = () => {
    const selection = this.selection;
    if (!selection?.bitmap || !selection.crop || !selection.source || this.state.phase !== 'crop') return;
    const preparation = ++this.preparation;
    const bitmap = selection.bitmap;
    const sourceFile = selection.file;
    const position = selection.crop;
    const request = new AbortController();
    this.preparationRequest = request;
    this.update({ phase: 'exporting', url: selection.url, crop: { ...selection.source, position } });
    void this.exportCrop(selection, preparation, bitmap, sourceFile, position, request.signal);
  };
  useOriginal = () => {
    const selection = this.selection;
    if (!selection || !this.canUpload() || !['crop', 'original-only'].includes(this.state.phase)) return;
    this.preparation++;
    const preparationRequest = this.preparationRequest;
    this.preparationRequest = null;
    preparationRequest?.abort();
    selection.bitmap?.close();
    delete selection.bitmap;
    delete selection.source;
    delete selection.crop;
    void this.send(selection);
  };
  retry = () => {
    if (this.editable() && this.selection && this.canRetry() && !this.waiting()) void this.send(this.selection);
  };
  canRetry = () =>
    this.state.phase === 'error' &&
    !!this.selection &&
    this.selection.accountId === this.adviceTarget &&
    this.advice === 'allowed' &&
    (!this.selection.reservation || !!this.resume) &&
    !['type', 'too-large', 'rejected'].includes(this.state.failure?.reason ?? 'unavailable');
  private bindIntent(selection: Selection) {
    if (selection.intent && selection.intent.file === selection.file && selection.intent.viewer === selection.accountId)
      return selection.intent;
    selection.intent = createMediaReservationIntent(
      { containerId: selection.accountId },
      selection.file,
      'avatar',
      selection.accountId,
    );
    return selection.intent;
  }
  private async send(selection: Selection) {
    // Replacing or clearing a selection never bypasses the native delay. Expiry does no IO.
    if (this.waiting()) {
      this.update({ phase: 'error', url: selection.url });
      return;
    }
    if (!this.canUpload() || selection.accountId !== this.adviceTarget) {
      this.update({ phase: 'error', url: selection.url });
      return;
    }
    const reservation = selection.reservation;
    if (reservation && !this.resume) return;
    if (!reservation && !this.canUpload()) return;
    if (reservation && !selection.intent) return;
    const intent = selection.intent ?? this.bindIntent(selection);
    const request = new AbortController();
    this.request = request;
    this.update({
      phase: 'uploading',
      url: selection.url,
      stage: reservation ? 'processing' : 'reservation',
    });
    const onStage: UploadStageUpdate = (stage, mediaId) => {
      if (!this.owns(selection, request)) return;
      if (mediaId) selection.reservation = mediaId;
      this.update({ phase: 'uploading', url: selection.url, stage });
    };
    const onResponseWait: UploadResponseWait = (status, retryAfter, responseTime) =>
      this.retainCommandWait(status, retryAfter, responseTime);
    try {
      const result = reservation
        ? await withProfileDeadline(
            (signal) => this.resume!(reservation, selection.file, signal, onStage, intent, onResponseWait),
            request.signal,
          )
        : await withProfileDeadline(
            (signal) => this.upload(selection.accountId, selection.file, signal, intent, onStage, onResponseWait),
            request.signal,
          );
      if (!this.owns(selection, request)) return;
      if (selection.reservation && result.src !== selection.reservation) throw new UploadRefusal('unavailable');
      selection.media = result.src;
      this.update({ phase: 'ready', url: selection.url });
      this.editor.edit({ avatar: { media: result.src } });
    } catch (error) {
      if (!this.owns(selection, request)) return;
      if (error instanceof UploadRefusal) {
        if (!selection.reservation && error.mediaId) selection.reservation = error.mediaId;
        const failure: Failure = {
          reason: error.reason,
          ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
        };
        const observed = preferenceRetryDeadline(error.retryAfterHeader, error.responseTime ?? Date.now());
        if (observed > 0) {
          this.waits.commandRetryAt = Math.max(this.waits.commandRetryAt, observed);
          this.waits.commandFailure = failure;
        }
        this.update({
          phase: 'error',
          url: selection.url,
          ...(this.state.stage ? { stage: this.state.stage } : {}),
          failure,
        });
      } else
        this.update({
          phase: 'error',
          url: selection.url,
          ...(this.state.stage ? { stage: this.state.stage } : {}),
        });
    } finally {
      if (this.request === request) this.request = null;
    }
  }
  private async prepare(selection: Selection, preparation: number, signal: AbortSignal) {
    try {
      const source = await withProfileDeadline(() => readAvatarCropSource(selection.file), signal);
      if (!this.ownsPreparation(selection, preparation)) return;
      if (!source) {
        this.update({ phase: 'original-only', url: selection.url, cropIssue: 'unsupported' });
        return;
      }
      const bitmap = await this.decodeWithinDeadline(selection.file, signal);
      if (!this.ownsPreparation(selection, preparation)) {
        bitmap?.close();
        return;
      }
      if (!bitmap) {
        this.update({ phase: 'original-only', url: selection.url, cropIssue: 'unsupported' });
        return;
      }
      if (!avatarCropSourceSupported(bitmap)) {
        bitmap.close();
        this.update({ phase: 'original-only', url: selection.url, cropIssue: 'unsupported' });
        return;
      }
      selection.bitmap = bitmap;
      selection.source = { width: bitmap.width, height: bitmap.height };
      selection.crop = initialAvatarCrop;
      this.update({
        phase: 'crop',
        url: selection.url,
        crop: { ...selection.source, position: selection.crop },
      });
    } catch {
      if (!this.ownsPreparation(selection, preparation)) return;
      this.update({ phase: 'original-only', url: selection.url, cropIssue: 'decode' });
    } finally {
      if (this.preparationRequest?.signal === signal) this.preparationRequest = null;
    }
  }
  private async decodeWithinDeadline(file: File, signal: AbortSignal) {
    let retired = false;
    let decoded: ImageBitmap | null = null;
    const pending = decodeAvatarCrop(file).then((bitmap) => {
      decoded = bitmap;
      if (retired) {
        bitmap?.close();
        decoded = null;
      }
      return bitmap;
    });
    try {
      return await withProfileDeadline(() => pending, signal);
    } catch (error) {
      retired = true;
      decoded?.close();
      decoded = null;
      throw error;
    }
  }
  private async exportCrop(
    selection: Selection,
    preparation: number,
    bitmap: ImageBitmap,
    sourceFile: File,
    position: AvatarCropPosition,
    signal: AbortSignal,
  ) {
    try {
      const file = await withProfileDeadline(() => createCroppedAvatarFile(bitmap, sourceFile, position), signal);
      if (!this.ownsPreparation(selection, preparation)) return;
      if (this.preparationRequest?.signal === signal) this.preparationRequest = null;
      const url = this.urls.createObjectURL(file);
      const previousUrl = selection.url;
      selection.file = file;
      selection.url = url;
      selection.bitmap?.close();
      delete selection.bitmap;
      delete selection.source;
      delete selection.crop;
      this.urls.revokeObjectURL(previousUrl);
      await this.send(selection);
    } catch {
      if (!this.ownsPreparation(selection, preparation)) return;
      const crop = selection.source && selection.crop ? { ...selection.source, position: selection.crop } : undefined;
      this.update({
        phase: 'crop',
        url: selection.url,
        ...(crop ? { crop } : {}),
        cropIssue: 'encode',
      });
    } finally {
      if (this.preparationRequest?.signal === signal) this.preparationRequest = null;
    }
  }
  private ownsPreparation(selection: Selection, preparation: number) {
    const { draft, phase } = this.editor.snapshot();
    return (
      this.connected &&
      this.selection === selection &&
      this.preparation === preparation &&
      draft?.accountId === selection.accountId &&
      phase !== 'unavailable'
    );
  }
  private owns(selection: Selection, request: AbortController) {
    return (
      this.connected &&
      this.selection === selection &&
      this.request === request &&
      !request.signal.aborted &&
      this.editor.snapshot().draft?.accountId === selection.accountId &&
      this.editor.snapshot().phase !== 'unavailable'
    );
  }
}
