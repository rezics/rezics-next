import type { UploadedImage } from '@rezics/ui';
import * as source from './upload';

export type ReplyUploadTarget = Parameters<typeof source.uploadReplyImage>[0];
export type ReplyUploadContext = {
  target: ReplyUploadTarget | undefined;
  session: { subject: string; csrfToken: string } | null;
};
type Resume = (mediaId: string, file: File, signal: AbortSignal) => Promise<UploadedImage>;
type Transport = { uploadReplyImage: typeof source.uploadReplyImage; resumeReplyImageUpload?: Resume };
// The original upload module wins as soon as its declared export is delivered. No second upload producer lives here.
const native: Transport = source;

export class ReplyUploadRecoveryRefusal extends source.UploadRefusal {
  constructor(readonly recovery: 'target-changed' | 'fresh-file') {
    super('unavailable');
  }
}

function targetKey(target: ReplyUploadTarget | undefined): string {
  if (typeof target === 'string') return JSON.stringify(['container', target]);
  if (!target) return '';
  return 'containerId' in target
    ? JSON.stringify(['container', target.containerId])
    : JSON.stringify(['new-thread', target.newThread.boardId, target.newThread.idempotencyKey]);
}

function sameContext(a: ReplyUploadContext, b: ReplyUploadContext): boolean {
  return Boolean(
    a.session &&
    b.session &&
    a.session.subject === b.session.subject &&
    a.session.csrfToken === b.session.csrfToken &&
    targetKey(a.target) === targetKey(b.target),
  );
}

type Pending = {
  context: ReplyUploadContext;
  controller: AbortController;
  detach: () => void;
  mediaId?: string;
  blocked?: 'target-changed' | 'fresh-file';
  running: boolean;
  attempted: boolean;
};

/** One mounted editor's original Files, never media IDs inferred from a document or another draft. */
export class ReplyImageUploadRecovery {
  private readonly pending = new Map<File, Pending>();

  constructor(
    private readonly current: () => ReplyUploadContext,
    private readonly transport: Transport = native,
  ) {}

  invalidate(): void {
    for (const entry of this.pending.values()) {
      if (!sameContext(entry.context, this.current())) {
        entry.blocked = 'target-changed';
        delete entry.mediaId;
        entry.controller.abort();
      }
    }
  }

  clear(): void {
    for (const [file, entry] of this.pending) this.remove(file, entry);
  }

  private remove(file: File, entry: Pending): void {
    if (this.pending.get(file) !== entry) return;
    this.pending.delete(file);
    entry.detach();
    entry.controller.abort();
  }

  async upload(file: File, signal: AbortSignal): Promise<UploadedImage> {
    signal.throwIfAborted();
    this.invalidate();
    let entry = this.pending.get(file);
    if (entry?.running) throw new source.UploadRefusal('unavailable');
    const context = this.current();
    if (!entry) {
      if (!context.target || !context.session) throw new source.UploadRefusal('unavailable');
      if (this.pending.size >= source.replyImageLimit) throw new source.UploadRefusal('unavailable');
      entry = {
        context: structuredClone(context),
        controller: new AbortController(),
        detach: () => {},
        running: false,
        attempted: false,
      };
      this.pending.set(file, entry);
    }
    entry.detach();
    entry.controller = new AbortController();
    const attempt = entry;
    const remove = () => this.remove(file, attempt);
    signal.addEventListener('abort', remove, { once: true });
    entry.detach = () => signal.removeEventListener('abort', remove);
    if (entry.blocked) throw new ReplyUploadRecoveryRefusal(entry.blocked);
    entry.running = true;
    try {
      let uploaded: UploadedImage;
      if (entry.mediaId) {
        const resume = this.transport.resumeReplyImageUpload;
        if (!resume) throw new source.UploadRefusal('unavailable');
        uploaded = await resume(entry.mediaId, file, entry.controller.signal);
        if (uploaded.src !== entry.mediaId) throw new source.UploadRefusal('unavailable');
      } else {
        // Without a returned reservation ID, another reserve could duplicate an uncertain upload.
        if (entry.attempted) throw new source.UploadRefusal('unavailable');
        entry.attempted = true;
        uploaded = await this.transport.uploadReplyImage(entry.context.target!, file, entry.controller.signal);
      }
      this.invalidate();
      if (entry.blocked) throw new ReplyUploadRecoveryRefusal(entry.blocked);
      if (this.pending.get(file) !== entry) throw new DOMException('Upload removed', 'AbortError');
      signal.throwIfAborted();
      this.remove(file, entry);
      return uploaded;
    } catch (error) {
      this.invalidate();
      if (entry.blocked) throw new ReplyUploadRecoveryRefusal(entry.blocked);
      if (this.pending.get(file) === entry && error instanceof source.UploadRefusal) {
        if (error.reason === 'rejected') {
          entry.blocked = 'fresh-file';
          delete entry.mediaId;
        } else if (!entry.mediaId && error.mediaId) entry.mediaId = error.mediaId;
      }
      throw error;
    } finally {
      entry.running = false;
    }
  }
}
