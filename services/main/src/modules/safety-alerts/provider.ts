import type { Pool } from 'pg';
import type {
  DeliveryProvider,
  ProviderLookup,
  ProviderResult,
  ProviderSend,
} from '../notification/dispatcher.ts';
import { SAFETY_ALERT_BASIS } from './store.ts';

/** Routes only safety alert email to Account; other channels retain their adapter.
 * SMTP acceptance is the delivery evidence (RFC 5321 section 4.2.5), not queue
 * intake: https://www.rfc-editor.org/rfc/rfc5321.html#section-4.2.5 */
export class SafetyAlertProvider implements DeliveryProvider {
  readonly name: string;
  constructor(
    private readonly access: Pool,
    private readonly issuer: string,
    private readonly accountUrl: string,
    private readonly secret: string,
    private readonly fallback?: DeliveryProvider,
  ) {
    this.name = fallback?.name ?? 'account-safety';
  }

  private async recipient(deliveryId: string) {
    return (
      await this.access.query<{ account_subject: string; account_issuer: string }>(
        `SELECT p.account_subject,p.account_issuer
      FROM access.notification_delivery d JOIN access.notification_item i ON i.id = d.item_id
      JOIN access.principal p ON p.id = d.principal_id
      WHERE d.id = $1 AND d.channel = 'email' AND i.disclosure_basis = $2`,
        [deliveryId, SAFETY_ALERT_BASIS],
      )
    ).rows[0];
  }

  private async exchange(path: string, init: RequestInit) {
    const response = await fetch(new URL(path, this.accountUrl), {
      ...init,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return { status: 'not_found' as const };
    }
    if (response.status === 409) {
      await response.body?.cancel();
      return { status: 'failed' as const, code: 'account_intake_rejected' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Account safety delivery unavailable');
    }
    // This exact internal contract has two fixed-size fields. Bound even a broken response.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Account safety delivery response missing');
    let body = '';
    try {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1024) {
          await reader.cancel();
          throw new Error('Account safety delivery response too large');
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(body);
    const result = parsed as { state?: string; messageId?: string } | null;
    if (!result || typeof result !== 'object' || !/^[0-9a-f-]{36}$/.test(result.messageId ?? '')) {
      throw new Error('Account safety delivery response invalid');
    }
    if (result.state === 'sent')
      return { status: 'delivered' as const, messageId: result.messageId! };
    if (result.state === 'expired')
      return { status: 'failed' as const, code: 'account_mail_expired' };
    // Account intentionally never guesses after ambiguous SMTP DATA. Do not turn
    // queued, sending or uncertain into delivered, or resend uncertain mail.
    throw new Error('Account safety delivery unconfirmed');
  }

  async send(input: ProviderSend): Promise<ProviderResult> {
    const recipient = await this.recipient(input.deliveryId);
    if (!recipient)
      return this.fallback
        ? this.fallback.send(input)
        : { status: 'rejected', permanent: true, code: 'provider_unconfigured' };
    if (recipient.account_issuer !== this.issuer)
      return { status: 'rejected', permanent: true, code: 'issuer_mismatch' };
    const result = await this.exchange('/api/internal/safety-alerts', {
      method: 'POST',
      body: JSON.stringify({
        deliveryId: input.deliveryId,
        userId: recipient.account_subject,
        deadline: input.payload.deadline,
        reason: input.payload.reason,
      }),
    });
    if (result.status === 'delivered') return { status: 'accepted', messageId: result.messageId };
    if (result.status === 'failed')
      return { status: 'rejected', permanent: true, code: result.code };
    throw new Error('Account safety intake missing');
  }

  async lookup(deliveryId: string): Promise<ProviderLookup> {
    const recipient = await this.recipient(deliveryId);
    if (!recipient)
      return this.fallback ? this.fallback.lookup(deliveryId) : { status: 'not_found' };
    if (recipient.account_issuer !== this.issuer)
      return { status: 'failed', code: 'issuer_mismatch' };
    return this.exchange(`/api/internal/safety-alerts/${deliveryId}`, { method: 'GET' });
  }
}
