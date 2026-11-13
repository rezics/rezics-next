import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { StudioResult } from './contract';
import { hostedFailure } from './hosted-native';
import { baselineProgress, type BaselineProgress, type BaselineRequest } from './hosted-legacy-baseline-contract';

export type BaselineAdvance = (
  request: BaselineRequest,
  signal: AbortSignal,
  csrfToken: string,
) => Promise<StudioResult<BaselineProgress>>;

export const baselineUnknown = () =>
  hostedFailure('uncertain', 'The preparation result is unknown. Retry the same step.');

/** Receipt-only transport. Neither successful nor failed commands trigger owner readback. */
export function createBaselineAdvance(client: KernelClient): BaselineAdvance {
  return async (input, signal) => {
    let response: Awaited<
      ReturnType<ReturnType<KernelClient['hostedCatalogues']>['$advanceLegacyPublicBaseline']['post']>
    >;
    try {
      response = await client
        .hostedCatalogues({ id: input.catalogueId })
        .$advanceLegacyPublicBaseline.post(input.body, {
          headers: { 'idempotency-key': JSON.stringify(input.idempotencyKey) },
          fetch: { signal, cache: 'no-store', redirect: 'manual' },
        });
    } catch {
      return baselineUnknown();
    }
    if (response.status === 412)
      return hostedFailure('stale', 'The original structure or public version changed. Review again.');
    if (response.status === 401 || response.status === 403)
      return hostedFailure('denied', 'This author session cannot prepare the Book.');
    if (response.status === 404)
      return hostedFailure('unavailable', 'The selected Book or original public version is unavailable.');
    if ([400, 413, 422].includes(response.status))
      return hostedFailure('invalid', 'The preparation step was rejected. Review the Book again.');
    if (response.status !== 200 || response.error) return baselineUnknown();
    const parsed = v.safeParse(baselineProgress, response.data);
    if (
      !parsed.success ||
      parsed.output.catalogueId !== input.catalogueId ||
      parsed.output.sourcePublicationId !== input.body.expectedPublicationId
    )
      return baselineUnknown();
    return { ok: true, value: parsed.output };
  };
}
