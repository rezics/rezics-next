import type { ProfileValues } from './profile-data';
import type { ProfileEditor } from './profile-write';

export type AvatarUpload = (accountId: string, file: File, signal: AbortSignal) => Promise<{ src: string }>;
type Avatar = ProfileValues['avatar'];
type Selection = {
  accountId: string;
  file: File;
  url: string;
  before: Avatar;
  media?: string;
};
type UploadState = { phase: 'idle' | 'uploading' | 'ready' | 'error' | 'cancelled'; url: string | null };
const idle: UploadState = { phase: 'idle', url: null };
export const avatarMedia = (avatar: Avatar) => avatar?.media ?? null;

/** Owns only this card's local preview and request; cancellation never promises provider cleanup. */
export class ProfileAvatarUpload {
  private state = idle;
  private selection: Selection | null = null;
  private request: AbortController | null = null;
  private listeners = new Set<() => void>();
  private connected = false;
  constructor(
    private editor: ProfileEditor,
    private upload: AvatarUpload,
    private urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: UploadState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
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
    const selection = this.selection;
    this.selection = null;
    const request = this.request;
    this.request = null;
    request?.abort();
    if (selection) this.urls.revokeObjectURL(selection.url);
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
    this.selection = { accountId: draft.accountId, file, url, before: draft.avatar };
    this.editor.edit({});
    void this.send(this.selection);
  };
  retry = () => {
    if (this.editable() && this.selection && this.state.phase === 'error') void this.send(this.selection);
  };
  private async send(selection: Selection) {
    const request = new AbortController();
    this.request = request;
    this.update({ phase: 'uploading', url: selection.url });
    try {
      const result = await this.upload(selection.accountId, selection.file, request.signal);
      if (!this.owns(selection, request)) return;
      selection.media = result.src;
      this.update({ phase: 'ready', url: selection.url });
      this.editor.edit({ avatar: { media: result.src } });
    } catch {
      if (this.owns(selection, request)) this.update({ phase: 'error', url: selection.url });
    } finally {
      if (this.request === request) this.request = null;
    }
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
