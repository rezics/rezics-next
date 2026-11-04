import type { UploadAttachment, UploadedImage } from '@rezics/ui';
import { ReplyImageUploadRecovery, type ReplyUploadContext } from '../media-upload-recovery';
import { replyImageLimit, UploadRefusal, type UploadStage } from '../upload';

export type AttachmentRecovery = 'exact' | 'known-media' | 'replace' | 'unavailable';
export type AttachmentObservation = Readonly<{
  stage: UploadStage | 'insertion' | 'failed';
  recovery?: AttachmentRecovery;
  refusal?: UploadRefusal;
}>;

type Occurrence = {
  file: File;
  context: string;
  attempt: symbol;
  observation: AttachmentObservation;
  accepted?: UploadedImage;
  detach: () => void;
};

function contextKey(context: ReplyUploadContext): string {
  return JSON.stringify([context.target, context.session]);
}

/**
 * Presentation of the editor's admitted occurrences, not a second upload queue.
 * The editor owns selection, tracked positions, descriptions and insertion. Recovery
 * owns the native commands. This owner joins those two identities for one caller.
 */
export class ComposerAttachmentEpisode {
  private readonly rows = new Map<UploadAttachment, Occurrence>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    private readonly recovery: ReplyImageUploadRecovery,
    private readonly context: () => ReplyUploadContext,
    private readonly current: () => boolean,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  observation(attachment: UploadAttachment): AttachmentObservation | undefined {
    const row = this.rows.get(attachment);
    return row && this.admitted(row) ? row.observation : undefined;
  }

  private admitted(row: Occurrence): boolean {
    return this.current() && row.context === contextKey(this.context());
  }

  private remove(attachment: UploadAttachment, row: Occurrence): void {
    if (this.rows.get(attachment) !== row) return;
    row.detach();
    this.rows.delete(attachment);
    delete row.accepted;
    this.changed();
  }

  /** The editor aborts an occurrence on removal and after accepted snapshot publication. */
  async upload(attachment: UploadAttachment, signal: AbortSignal): Promise<UploadedImage> {
    signal.throwIfAborted();
    if (!this.current() || !this.context().session) throw new DOMException('Editor retired', 'AbortError');
    let row = this.rows.get(attachment);
    if (!row) {
      if (this.rows.size >= replyImageLimit) throw new UploadRefusal('unavailable');
      row = {
        file: attachment.file,
        context: contextKey(this.context()),
        attempt: Symbol(),
        observation: { stage: 'reservation' },
        detach: () => {},
      };
      this.rows.set(attachment, row);
    }
    if (!this.admitted(row) || row.file !== attachment.file) throw new DOMException('Attachment retired', 'AbortError');
    row.detach();
    const original = row;
    const attempt = Symbol();
    row.attempt = attempt;
    const active = () =>
      this.rows.get(attachment) === original &&
      original.attempt === attempt &&
      this.admitted(original) &&
      !signal.aborted;
    const removed = () => this.remove(attachment, original);
    signal.addEventListener('abort', removed, { once: true });
    row.detach = () => signal.removeEventListener('abort', removed);
    // An insertion failure retries only insertion of the accepted occurrence.
    if (row.accepted) return row.accepted;
    try {
      const uploaded = await this.recovery.upload(
        row.file,
        signal,
        (stage) => {
          if (!active() || original.observation.stage === stage) return;
          original.observation = { stage };
          this.changed();
        },
        attachment,
      );
      if (!active()) throw new DOMException('Attachment retired', 'AbortError');
      row.accepted = uploaded;
      row.observation = { stage: 'insertion' };
      this.changed();
      return uploaded;
    } catch (error) {
      if (active()) {
        row.observation = {
          stage: 'failed',
          recovery: this.recovery.recoveryFor(attachment),
          refusal: error instanceof UploadRefusal ? error : new UploadRefusal('unavailable'),
        };
        this.changed();
      }
      throw error;
    }
  }

  clear(): void {
    for (const [attachment, row] of this.rows) this.remove(attachment, row);
    this.recovery.clear();
  }
}
