import { memoizedValue } from '../memoized.ts';
import Stripe from 'stripe';
import { MAX_WEBHOOK_SECRETS } from './config.ts';
import { HANDLED_STRIPE_EVENTS, type HandledStripeEvent, type StripeEventRef } from './model.ts';

const MAX_SIGNATURE_BYTES = 8192;
const cryptoProvider = Stripe.createSubtleCryptoProvider();
function handled() {
  return memoizedValue(handled, () => new Set<string>(HANDLED_STRIPE_EVENTS));
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

/** receivedAt is the trusted request arrival time in Unix milliseconds, as stripe-node expects. */
export async function verifyStripeEvent(
  raw: Uint8Array,
  header: string | null,
  secrets: readonly string[],
  receivedAt: number,
): Promise<Stripe.Event> {
  if (
    !header ||
    header.length > MAX_SIGNATURE_BYTES ||
    Buffer.byteLength(header, 'utf8') > MAX_SIGNATURE_BYTES ||
    secrets.length === 0 ||
    secrets.length > MAX_WEBHOOK_SECRETS ||
    !Number.isFinite(receivedAt)
  )
    throw new WebhookSignatureError();
  for (const secret of secrets) {
    try {
      return await Stripe.webhooks.constructEventAsync(raw, header, secret, 300, cryptoProvider, receivedAt);
    } catch {
      // During rotation each configured secret may verify a delivery.
    }
  }
  throw new WebhookSignatureError();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paymentIntentId(value: unknown): string | null {
  const id = record(value) ? value.id : value;
  return typeof id === 'string' && /^pi_[A-Za-z0-9]+$/.test(id) ? id : null;
}

/** Only identifiers from supported, platform-account events cross into durable work. */
export function classifyStripeEvent(event: Stripe.Event): StripeEventRef | null {
  if (!record(event) || Object.hasOwn(event, 'account') || !handled().has(event.type)) return null;
  if (
    typeof event.id !== 'string' ||
    !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
    !Number.isSafeInteger(event.created) ||
    event.created < 0 ||
    typeof event.livemode !== 'boolean' ||
    !record(event.data) ||
    !record(event.data.object)
  )
    return null;

  const object = event.data.object;
  const intent = paymentIntentId(object.payment_intent);
  // Missing intents are allowed on sessions; a supplied but malformed ID never is.
  if (object.payment_intent != null && intent === null) return null;
  let sessionId: string | null = null;
  if (event.type.startsWith('checkout.session.')) {
    if (typeof object.id !== 'string' || !/^cs_(?:(?:test|live)_)?[A-Za-z0-9]+$/.test(object.id)) return null;
    sessionId = object.id;
  } else if (intent === null) return null;

  return {
    eventId: event.id,
    type: event.type as HandledStripeEvent,
    created: event.created,
    livemode: event.livemode,
    sessionId,
    paymentIntentId: intent,
  };
}
