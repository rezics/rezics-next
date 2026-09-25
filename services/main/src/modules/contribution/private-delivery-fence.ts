import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccessAdmissionRegistry } from '../access/admission.ts';

type DeliveryOwner = Pick<AccessAdmissionRegistry,
  'armContributionSearchSend' | 'finishContributionSearchRead'>;

/** One WebSocket message carries the complete result and a final random
 * challenge. A matching client message is a peer-receipt, not proof that a UI
 * displayed the result. The Access row is armed before any transport send.
 * A socket close after arming is intentionally unresolved. */
export class PrivateSearchReceiptSession {
  private phase: 'unarmed' | 'arming' | 'armed' | 'settled' = 'unarmed';
  private closed = false;
  private receiptToken: string | undefined;

  constructor(private readonly owner: DeliveryOwner, private readonly leaseId: string,
    private readonly result: unknown) {}

  async send(sendFrame: (frame: string) => number): Promise<number> {
    if (this.phase !== 'unarmed') throw new Error('private result send already attempted');
    const receiptToken = randomBytes(32).toString('hex');
    const frame = JSON.stringify({ type: 'private-contribution-result-v1',
      leaseId: this.leaseId, result: this.result, receiptChallenge: receiptToken });
    if (Buffer.byteLength(frame, 'utf8') > 1_048_576) {
      throw new Error('private result frame exceeds delivery bound');
    }
    // From this point a lost owner response could hide a committed marker.
    // A concurrent disconnect must not turn that uncertain state into abort.
    this.phase = 'arming';
    await this.owner.armContributionSearchSend(this.leaseId, receiptToken);
    this.receiptToken = receiptToken;
    this.phase = 'armed';
    if (this.closed) return 0;
    // A zero, negative or thrown send may still have emitted bytes. The row
    // remains armed, never aborted by this method or a later close/timeout.
    return sendFrame(frame);
  }

  async receipt(message: string): Promise<boolean> {
    if (this.phase !== 'armed' || !this.receiptToken) return false;
    let value: unknown;
    try { value = JSON.parse(message); } catch { return false; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (data.type !== 'private-contribution-receipt-v1'
      || data.leaseId !== this.leaseId || typeof data.receiptChallenge !== 'string'
      || !/^[0-9a-f]{64}$/.test(data.receiptChallenge)) return false;
    const expected = Buffer.from(this.receiptToken, 'hex');
    const supplied = Buffer.from(data.receiptChallenge, 'hex');
    if (!timingSafeEqual(expected, supplied)) return false;
    await this.owner.finishContributionSearchRead(this.leaseId, 'delivered', this.receiptToken);
    this.phase = 'settled';
    return true;
  }

  /** Before arming, no sensitive send was attempted and abort is safe. After
   * arming, even a closed connection may have buffered the full result. */
  async disconnect(): Promise<'aborted' | 'unresolved' | 'settled'> {
    this.closed = true;
    if (this.phase === 'settled') return 'settled';
    if (this.phase !== 'unarmed') return 'unresolved';
    await this.owner.finishContributionSearchRead(this.leaseId, 'aborted');
    this.phase = 'settled';
    return 'aborted';
  }
}
