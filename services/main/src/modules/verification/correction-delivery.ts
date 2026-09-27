import { randomUUID } from 'node:crypto';
import { NotificationStore, type EnqueuedItem } from '../notification/store.ts';
import type { NotificationSubjectReader } from '../notification/dispatcher.ts';
import { nativeId, type VerificationStore } from './store.ts';

/**
 * Content's correction notice is the durable producer event. Access owns the
 * recipient items and channel deliveries. A crash after enqueue replays the
 * same source event; Access deduplicates each recipient before the cursor moves.
 */
export class VerificationCorrectionPublisher {
  constructor(private readonly verification: VerificationStore,
    private readonly notifications: Pick<NotificationStore, 'enqueue'>) {}

  async runOnce(owner: string, maxPages = 8, pageSize = 128): Promise<{
    pages: number; recipients: number; newItems: number }> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 32) throw new Error('invalid correction page count');
    const result = { pages: 0, recipients: 0, newItems: 0 };
    while (result.pages < maxPages) {
      const page = await this.verification.leaseCorrectionPage(owner, pageSize);
      if (!page) break;
      let queued: EnqueuedItem[] = [];
      if (page.recipients.length) {
        queued = await this.notifications.enqueue({ sourceOwner: 'content',
          sourceEvent: nativeId(page.generation), purpose: 'governance', topic: 'claim-correction',
          subject: { owner: 'content', ref: page.claim, revision: nativeId(page.generation) },
          display: { kind: 'claim_correction', actorAgent: null, realm: null, groupKey: null },
          disclosureBasis: 'verification-correction-subscription-v1', recipients: page.recipients });
      }
      await this.verification.acknowledgeCorrectionPage(owner, page.generation,
        page.cursor, page.next, page.complete);
      result.pages++;
      result.recipients += page.recipients.length;
      result.newItems += queued.filter(item => !item.replayed).length;
    }
    return result;
  }
}

/** Poll the durable Content cursor; Access delivery remains G-051's owner. */
export class VerificationCorrectionWorker {
  private readonly owner = `main-correction:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly publisher: VerificationCorrectionPublisher,
    private readonly intervalMs = 1000) {}

  start(): void {
    if (this.timer) throw new Error('correction worker is already started');
    const poll = () => {
      if (this.running) return;
      this.running = this.publisher.runOnce(this.owner).then(() => undefined)
        .catch(error => { console.error('Verification correction delivery:', error); })
        .finally(() => { this.running = null; });
    };
    poll();
    this.timer = setInterval(poll, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}

/** Exact, recipient-specific correction rendering for G-051's delivery worker. */
export function verificationCorrectionSubjectReader(verification: VerificationStore): NotificationSubjectReader {
  return { async resolve(input) {
    if (input.owner !== 'content' || input.disclosureBasis !== 'verification-correction-subscription-v1'
      || !input.revision?.startsWith('https://rezics.com/id/')) return { status: 'unavailable' };
    const notice = await verification.correctionForRecipient(input.principalId,
      input.revision.slice('https://rezics.com/id/'.length));
    if (notice.status !== 'available') return notice;
    if (notice.claim !== input.ref || notice.generation !== input.revision) return { status: 'unavailable' };
    return { status: 'available', subject: { private: true,
      fields: { claim: notice.claim, generation: notice.generation,
        support: notice.support, dispute: notice.dispute, linkTarget: notice.claim } } };
  } };
}
