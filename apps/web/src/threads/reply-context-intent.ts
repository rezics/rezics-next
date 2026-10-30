import type { DocumentSnapshot } from '@rezics/document';

export type ReplyDraft = { title: string; body: DocumentSnapshot; mediaIds: string[] };
export type ReplyCommand = ReplyDraft & { idempotencyKey: string; parentId?: string };

/** One target and one draft form a command intent; an uncertain response can replay it unchanged. */
export class ReplyIntent {
  private parentId: string | null = null;
  private attempt: ReplyCommand | undefined;
  private fingerprint: string | undefined;

  constructor(private key: string) {}

  selectParent(parentId: string | null): string {
    if (parentId !== this.parentId) {
      this.parentId = parentId;
      this.reset(crypto.randomUUID());
    }
    return this.key;
  }

  prepare(draft: ReplyDraft, parentId: string | null): ReplyCommand {
    this.selectParent(parentId);
    const fingerprint = JSON.stringify(draft);
    if (this.attempt && fingerprint === this.fingerprint) return this.attempt;
    if (this.attempt) this.reset(crypto.randomUUID());
    this.fingerprint = fingerprint;
    this.attempt = {
      ...structuredClone(draft),
      idempotencyKey: this.key,
      ...(parentId === null ? {} : { parentId }),
    };
    return this.attempt;
  }

  reset(key: string): void {
    this.key = key;
    this.attempt = undefined;
    this.fingerprint = undefined;
  }
}

/** Match ContentIdSchema; native permission and bounded ancestry validation remain authoritative. */
export function replyParentId(input: object): string | undefined {
  if (!('parentId' in input) || input.parentId === undefined || input.parentId === null) return undefined;
  if (
    typeof input.parentId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.parentId)
  )
    throw new Error('Invalid reply parent id');
  return input.parentId;
}
