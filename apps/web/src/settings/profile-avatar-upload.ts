import { UploadRefusal } from '../threads/upload';
import { preferenceRetryDeadline } from './preference-failure-retry';
import type { ProfileValues } from './profile-data';
import type { ProfileEditor } from './profile-write';
import {
  avatarCropSourceSupported,
  avatarUploadFailure,
  canCropAvatar,
  constrainAvatarCrop,
  createCroppedAvatarFile,
  decodeAvatarCrop,
  initialAvatarCrop,
  type AvatarCropIssue,
  type AvatarCropPosition,
} from './profile-avatar-crop.ts';

export type AvatarUpload = (accountId: string, file: File, signal: AbortSignal) => Promise<{ src: string }>;
export type AvatarResume = (mediaId: string, file: File, signal: AbortSignal) => Promise<{ src: string }>;
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
};
type UploadState = {
  phase: 'idle' | 'preparing' | 'crop' | 'original-only' | 'exporting' | 'uploading' | 'ready' | 'error' | 'cancelled';
  url: string | null;
  crop?: { width: number; height: number; position: AvatarCropPosition };
  cropIssue?: AvatarCropIssue;
  failure?: Failure;
  retryAt?: number;
};
const idle: UploadState = { phase: 'idle', url: null };
export const avatarMedia = (avatar: Avatar) => avatar?.media ?? null;

/** Owns only this card's local preview and request; cancellation never promises provider cleanup. */
export class ProfileAvatarUpload {
  private state = idle;
  private selection: Selection | null = null;
  private request: AbortController | null = null;
  private listeners = new Set<() => void>();
  private connected = false;
  private retryAt = 0;
  private rateFailure: Failure | undefined;
  private preparation = 0;
  constructor(
    private editor: ProfileEditor,
    private upload: AvatarUpload,
    private urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
    private resume?: AvatarResume,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: UploadState) {
    const failure = state.failure ?? this.rateFailure;
    this.state = this.waiting() ? { ...state, retryAt: this.retryAt, ...(failure ? { failure } : {}) } : state;
    this.listeners.forEach((listener) => listener());
  }
  private waiting() {
    return Date.now() < this.retryAt;
  }
  connect() {
    this.connected = true;
    const unsubscribe = this.editor.subscribe(() => this.reconcile());
    return () => {
      this.connected = false;
      unsubscribe();
      this.clear();
    };
  }
  private clear() {
    // Invalidate ownership before abort listeners or a late promise can run.
    this.preparation++;
    const selection = this.selection;
    this.selection = null;
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
    const selection = this.selection;
    if (!selection) return;
    const { draft, known, phase } = this.editor.snapshot();
    if (!draft || draft.accountId !== selection.accountId || phase === 'unavailable') this.clear();
    else if (selection.media && avatarMedia(known?.avatar ?? null) === selection.media) this.clear();
    else if (avatarMedia(draft.avatar) !== (selection.media ?? avatarMedia(selection.before))) this.clear();
  }
  private editable() {
    const { draft, phase, attempt } = this.editor.snapshot();
    return this.connected && draft && !attempt && !['saving', 'reloading', 'unavailable'].includes(phase)
      ? draft
      : null;
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
    if (!file || !this.editable()) return;
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
    this.update({ phase: 'preparing', url });
    void this.prepare(selection, preparation);
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
    this.update({ phase: 'exporting', url: selection.url, crop: { ...selection.source, position } });
    void this.exportCrop(selection, preparation, bitmap, sourceFile, position);
  };
  useOriginal = () => {
    const selection = this.selection;
    if (!selection || !this.editable() || !['crop', 'original-only'].includes(this.state.phase)) return;
    this.preparation++;
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
    (!this.selection.reservation || !!this.resume) &&
    !['type', 'too-large', 'rejected'].includes(this.state.failure?.reason ?? 'unavailable');
  private async send(selection: Selection) {
    // Replacing or clearing a selection never bypasses the native delay. Expiry does no IO.
    if (this.waiting()) {
      this.update({ phase: 'error', url: selection.url });
      return;
    }
    const reservation = selection.reservation;
    if (reservation && !this.resume) return;
    const request = new AbortController();
    this.request = request;
    this.update({ phase: 'uploading', url: selection.url });
    try {
      const result = reservation
        ? await this.resume!(reservation, selection.file, request.signal)
        : await this.upload(selection.accountId, selection.file, request.signal);
      if (!this.owns(selection, request)) return;
      if (reservation && result.src !== reservation) throw new UploadRefusal('unavailable');
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
        if (error.reason === 'rate-limited') {
          this.retryAt = preferenceRetryDeadline(error.retryAfter?.toString());
          this.rateFailure = failure;
        }
        this.update({ phase: 'error', url: selection.url, failure });
      } else this.update({ phase: 'error', url: selection.url });
    } finally {
      if (this.request === request) this.request = null;
    }
  }
  private async prepare(selection: Selection, preparation: number) {
    try {
      const cropable = await canCropAvatar(selection.file);
      if (!this.ownsPreparation(selection, preparation)) return;
      if (!cropable) {
        this.update({ phase: 'original-only', url: selection.url, cropIssue: 'unsupported' });
        return;
      }
      const bitmap = await decodeAvatarCrop(selection.file);
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
    }
  }
  private async exportCrop(
    selection: Selection,
    preparation: number,
    bitmap: ImageBitmap,
    sourceFile: File,
    position: AvatarCropPosition,
  ) {
    try {
      const file = await createCroppedAvatarFile(bitmap, sourceFile, position);
      if (!this.ownsPreparation(selection, preparation)) return;
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
