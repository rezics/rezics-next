import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, AdmissionUnavailable } from
  '../access/admission.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import { PRIVATE_SEARCH_OFFER_MS, type PrivateSearchSettlement } from './private-search-settlement.ts';

type DeliveryOwner = Pick<AccessAdmissionRegistry,
  'armContributionSearchSend' | 'finishContributionSearchRead'>;
type SettlementOwner = Pick<PrivateSearchSettlement, 'settle'>;

export interface PrivateSearchSessionOptions {
  /** Runs after the durable arm and before the offer: the last owner check. */
  afterArm?: () => Promise<void>;
  /** Without it, post-arm outcomes stay unresolved as in the 010 candidate. */
  settlement?: SettlementOwner;
  offerWithinMs?: number;
}

export type PrivateSearchDisconnect =
  'aborted' | 'withheld' | 'unconfirmed' | 'delivered' | 'settled' | 'unresolved';

/** The arm committed but the frame could not be offered in time. */
export class PrivateSearchOfferExpired extends Error {}

/** One WebSocket message carries the complete result and a final random
 * challenge. A matching client message is a peer-receipt, not proof that a UI
 * displayed the result. The Access row is armed before any transport send.
 * With a settlement owner every armed row reaches a terminal state: `withheld`
 * when this process never offered the frame, `unconfirmed` once the transport
 * can no longer hand it bytes, or `delivered` for the exact receipt. */
export class PrivateSearchReceiptSession {
  private phase: 'unarmed' | 'checking' | 'arming' | 'armed' | 'offered' | 'settled' = 'unarmed';
  private closed = false;
  private receiptToken: string | undefined;
  private offeredFrame = false;
  private closing: Promise<PrivateSearchDisconnect> | undefined;

  constructor(private readonly owner: DeliveryOwner, private readonly leaseId: string,
    private readonly result: unknown, private readonly beforeArm?: () => Promise<void>,
    private readonly options: PrivateSearchSessionOptions = {}) {}

  /** True once the frame was handed to the transport, whatever it reported. */
  get offered(): boolean { return this.offeredFrame; }

  async send(sendFrame: (frame: string) => number): Promise<number> {
    if (this.phase !== 'unarmed') throw new Error('private result send already attempted');
    this.phase = 'checking';
    try { await this.beforeArm?.(); }
    catch (error) {
      await this.disconnect();
      throw error;
    }
    if (this.closed) return 0;
    const receiptToken = randomBytes(32).toString('hex');
    const frame = JSON.stringify({ type: 'private-contribution-result-v1',
      leaseId: this.leaseId, result: this.result, receiptChallenge: receiptToken });
    if (Buffer.byteLength(frame, 'utf8') > 1_048_576) {
      await this.disconnect();
      throw new Error('private result frame exceeds delivery bound');
    }
    // From this point a lost owner response could hide a committed marker.
    // A concurrent disconnect must not turn that uncertain state into abort.
    this.phase = 'arming';
    const armStarted = performance.now();
    try { await this.owner.armContributionSearchSend(this.leaseId, receiptToken); }
    catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired
        || error instanceof AdmissionConflict || error instanceof AdmissionUnavailable) {
        // These owner rejections happen before a committed send marker.
        await this.owner.finishContributionSearchRead(this.leaseId, 'aborted');
        this.phase = 'settled';
      } else if (this.options.settlement) {
        await this.settleUncertainArm(receiptToken);
      }
      throw error;
    }
    this.receiptToken = receiptToken;
    this.phase = 'armed';
    try { await this.options.afterArm?.(); }
    catch (error) {
      await this.withhold();
      throw error;
    }
    if (this.closed) {
      await this.withhold();
      return 0;
    }
    // The durable send window starts no earlier than armStarted, so an offer
    // inside this local bound precedes any window sweep by a wide margin.
    if (performance.now() - armStarted > (this.options.offerWithinMs ?? PRIVATE_SEARCH_OFFER_MS)) {
      await this.withhold();
      throw new PrivateSearchOfferExpired('private result offer deadline elapsed');
    }
    this.phase = 'offered';
    this.offeredFrame = true;
    // A zero, negative or thrown send may still have emitted bytes. The row is
    // never aborted after this point.
    return sendFrame(frame);
  }

  async receipt(message: unknown): Promise<boolean> {
    if (this.phase !== 'offered' || !this.receiptToken) return false;
    let value: unknown = message;
    if (typeof message === 'string') {
      try { value = JSON.parse(message); } catch { return false; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    if (data.type !== 'private-contribution-receipt-v1'
      || data.leaseId !== this.leaseId || typeof data.receiptChallenge !== 'string'
      || !/^[0-9a-f]{64}$/.test(data.receiptChallenge)) return false;
    const expected = Buffer.from(this.receiptToken, 'hex');
    const supplied = Buffer.from(data.receiptChallenge, 'hex');
    if (!timingSafeEqual(expected, supplied)) return false;
    try {
      await this.owner.finishContributionSearchRead(this.leaseId, 'delivered', this.receiptToken);
    } catch (error) {
      // A window sweep already recorded this possible delivery as unconfirmed.
      if (!(error instanceof AdmissionConflict)) throw error;
      this.phase = 'settled';
      return false;
    }
    this.phase = 'settled';
    return true;
  }

  /** Call after the transport can no longer hand this frame's bytes to the
   * peer: a close event, or after a terminate that discarded process buffers.
   * Before arming, no sensitive send was attempted and abort is safe. An arm in
   * flight is settled by `send` itself once it observes the close. */
  async disconnect(): Promise<PrivateSearchDisconnect> {
    this.closed = true;
    if (this.phase === 'settled') return 'settled';
    // A close event and a receipt deadline may both report the same socket.
    if (this.closing) return this.closing;
    if (this.phase === 'unarmed' || this.phase === 'checking') {
      this.closing = this.finishDisconnect(async () => {
        await this.owner.finishContributionSearchRead(this.leaseId, 'aborted');
        return 'aborted';
      });
      return this.closing;
    }
    const settlement = this.options.settlement;
    const receiptToken = this.receiptToken;
    if (this.phase !== 'offered' || !settlement || !receiptToken) return 'unresolved';
    this.closing = this.finishDisconnect(async () =>
      await settlement.settle(this.leaseId, receiptToken, 'unconfirmed') ?? 'unresolved');
    return this.closing;
  }

  private async finishDisconnect(
    settle: () => Promise<PrivateSearchDisconnect>): Promise<PrivateSearchDisconnect> {
    try {
      const outcome = await settle();
      if (outcome !== 'unresolved') this.phase = 'settled';
      return outcome;
    } finally { this.closing = undefined; }
  }

  private async withhold(): Promise<void> {
    if (!this.options.settlement || !this.receiptToken) return;
    if (await this.options.settlement.settle(this.leaseId, this.receiptToken, 'withheld')) {
      this.phase = 'settled';
    }
  }

  /** A lost arm response: the digest proves whether this challenge armed the
   * row. If it did, the frame was never offered; otherwise the row is unarmed. */
  private async settleUncertainArm(receiptToken: string): Promise<void> {
    try {
      if (await this.options.settlement!.settle(this.leaseId, receiptToken, 'withheld')) {
        this.phase = 'settled';
        return;
      }
      await this.owner.finishContributionSearchRead(this.leaseId, 'aborted');
      this.phase = 'settled';
    } catch {
      // Access is unreachable; the window sweep or an operator resolves the row.
    }
  }
}
