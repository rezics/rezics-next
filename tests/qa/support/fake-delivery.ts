import { createHmac, randomUUID } from 'node:crypto';
import type { DeliveryProvider, ProviderLookup, ProviderResult, ProviderSend }
  from '../../../services/main/src/modules/notification/dispatcher.ts';

/**
 * In-stack fake external channel. It deduplicates by delivery id like a real
 * provider idempotency key and can lose the acknowledgement after accepting,
 * fail before accepting, reject, or become unreachable for lookups.
 */
export type FakeBehavior = 'accept' | 'lose-ack' | 'fail-before-accept' | 'transient' | 'permanent';

export class FakeDeliveryProvider implements DeliveryProvider {
  readonly name = 'fake';
  readonly calls = { send: 0, lookup: 0 };
  readonly accepted = new Map<string, { messageId: string; payload: Readonly<Record<string, string>>;
    requests: number }>();
  lookupDown = false;
  private readonly queue: FakeBehavior[] = [];

  next(...behaviors: FakeBehavior[]): void { this.queue.push(...behaviors); }

  async send(request: ProviderSend): Promise<ProviderResult> {
    this.calls.send++;
    const behavior = this.queue.shift() ?? 'accept';
    if (behavior === 'fail-before-accept') throw new Error('connection reset before provider accepted');
    if (behavior === 'transient') return { status: 'rejected', permanent: false, code: 'rate_limited' };
    if (behavior === 'permanent') return { status: 'rejected', permanent: true, code: 'invalid_recipient' };
    const prior = this.accepted.get(request.deliveryId);
    const message = prior ?? { messageId: `msg-${randomUUID()}`, payload: request.payload, requests: 0 };
    message.requests++;
    this.accepted.set(request.deliveryId, message);
    if (behavior === 'lose-ack') throw new Error('acknowledgement lost after provider accepted');
    return { status: 'accepted', messageId: message.messageId };
  }

  async lookup(deliveryId: string): Promise<ProviderLookup> {
    this.calls.lookup++;
    if (this.lookupDown) throw new Error('provider lookup unreachable');
    const message = this.accepted.get(deliveryId);
    return message ? { status: 'delivered', messageId: message.messageId } : { status: 'not_found' };
  }
}

export function signProviderEvent(secret: string, raw: string): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}
