import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { hostedFailure } from './hosted-native';
import type { SourceConsentTransport } from './hosted-source-consent';
import { sourceConsentReceipt } from './hosted-source-consent-contract';

export const sourceConsentUnknown = () =>
  hostedFailure('uncertain', 'The source permission result is unknown. Retry the same command.');

/** Use the installed generated Post operations, without a Book read or a permission projection. */
export function createSourceConsentTransport(client: KernelClient): SourceConsentTransport {
  return async (input, signal) => {
    const post = client.posts({ id: input.body.target.postId });
    const options = {
      headers: { 'idempotency-key': JSON.stringify(input.idempotencyKey) },
      fetch: { signal, cache: 'no-store' as const, redirect: 'manual' as const },
    };
    let response;
    try {
      response =
        input.kind === 'issue'
          ? await post.$issueRevisionDisclosure.post(input.body, options)
          : await post.$revokeRevisionDisclosure.post(input.body, options);
    } catch {
      return sourceConsentUnknown();
    }
    if (response.status === 401 || response.status === 403)
      return hostedFailure('denied', 'The native source service denied this command under current admission.');
    if (response.status === 404)
      return hostedFailure('unavailable', 'The exact source permission is unavailable under current admission.');
    if (response.status === 412)
      return hostedFailure('stale', 'The reviewed source is no longer current for this command.');
    if ([400, 413, 422].includes(response.status))
      return hostedFailure('invalid', 'The native source service rejected this command.');
    if (response.status !== 200 || response.error) return sourceConsentUnknown();
    const parsed = v.safeParse(sourceConsentReceipt, response.data);
    // A different Book, receipt or operation state must not acknowledge the pending command.
    if (
      !parsed.success ||
      parsed.output.catalogueId !== input.body.catalogueId ||
      parsed.output.state !== (input.kind === 'issue' ? 'issued' : 'revoked') ||
      (input.kind === 'revoke' && parsed.output.disclosureId !== input.body.disclosureId)
    )
      return sourceConsentUnknown();
    return { ok: true, value: parsed.output };
  };
}
