import type { DeliveryProvider, ProviderLookup, ProviderResult, ProviderSend } from './dispatcher.ts';

export interface HttpDeliveryProviderConfig {
  name: string;
  baseUrl: string;
  bearerToken: string;
  timeoutMs?: number;
}

const safeCode = /^[A-Za-z0-9_.:-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const responseLimit = 16_384;
const defaultTimeoutMs = 5_000;

type RecordValue = Record<string, unknown>;

async function responseJson(response: Response): Promise<RecordValue> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('notification provider response is empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > responseLimit) throw new Error('notification provider response exceeds its bound');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const source = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.byteLength; }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(source));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('notification provider response is not an object');
  }
  return parsed as RecordValue;
}

/**
 * Provider bridge for deployments that expose the documented REZICS v1
 * delivery contract. All outcomes that are not an explicit response remain
 * thrown errors; NotificationDispatcher records them as uncertain and looks
 * up the same delivery id before retrying.
 */
export class HttpDeliveryProvider implements DeliveryProvider {
  readonly name: string;
  private readonly baseUrl: URL;
  private readonly bearerToken: string;
  private readonly timeoutMs: number;

  constructor(config: HttpDeliveryProviderConfig) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(config.name) || !config.bearerToken
      || config.bearerToken.length > 4_096) throw new Error('invalid notification provider configuration');
    let baseUrl: URL;
    try { baseUrl = new URL(config.baseUrl); } catch { throw new Error('invalid notification provider URL'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
    if ((!loopback && baseUrl.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(baseUrl.protocol))
      || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error('notification provider URL must be HTTPS without credentials or query data');
    }
    baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    this.baseUrl = baseUrl;
    this.name = config.name;
    this.bearerToken = config.bearerToken;
    this.timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error('notification provider timeout is out of bounds');
    }
  }

  async send(request: ProviderSend): Promise<ProviderResult> {
    if (!uuid.test(request.deliveryId)) throw new Error('invalid stable notification delivery id');
    // Email contact resolution remains Account-owned. Never send an email with
    // a missing verified address to an external provider.
    if (request.channel === 'email' && !request.address) {
      return { status: 'rejected', permanent: true, code: 'address_unavailable' };
    }
    const response = await this.exchange('deliveries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': request.deliveryId },
      body: JSON.stringify({ profile: 'notification-provider-send-v1', deliveryId: request.deliveryId,
        channel: request.channel, address: request.address, addressDigest: request.addressDigest,
        payload: request.payload }),
    });
    if ((response.status >= 300 && response.status < 400) || response.status >= 500 || response.status === 404) {
      await response.body?.cancel();
      throw new Error('notification provider outcome is uncertain');
    }
    const body = await responseJson(response);
    if (body.profile !== 'notification-provider-result-v1') throw new Error('invalid notification provider profile');
    if (body.status === 'accepted' && typeof body.messageId === 'string'
      && body.messageId.length > 0 && body.messageId.length <= 256 && response.ok) {
      return { status: 'accepted', messageId: body.messageId };
    }
    if (body.status === 'rejected' && typeof body.permanent === 'boolean'
      && typeof body.code === 'string' && safeCode.test(body.code)) {
      return { status: 'rejected', permanent: body.permanent, code: body.code };
    }
    throw new Error('invalid notification provider result');
  }

  async lookup(deliveryId: string): Promise<ProviderLookup> {
    if (!uuid.test(deliveryId)) throw new Error('invalid stable notification delivery id');
    const response = await this.exchange(`deliveries/${deliveryId}`, { method: 'GET' });
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('notification provider lookup is unavailable');
    }
    const body = await responseJson(response);
    if (body.profile !== 'notification-provider-lookup-v1') throw new Error('invalid notification lookup profile');
    if ((body.status === 'accepted' || body.status === 'delivered')
      && typeof body.messageId === 'string' && body.messageId.length > 0 && body.messageId.length <= 256) {
      return { status: body.status, messageId: body.messageId };
    }
    if (body.status === 'failed' && typeof body.code === 'string' && safeCode.test(body.code)) {
      return { status: 'failed', code: body.code };
    }
    throw new Error('invalid notification lookup result');
  }

  private exchange(path: string, init: RequestInit): Promise<Response> {
    return fetch(new URL(path, this.baseUrl), { ...init, redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs), headers: { ...init.headers as Record<string, string>,
        authorization: `Bearer ${this.bearerToken}`, accept: 'application/json' } });
  }
}
