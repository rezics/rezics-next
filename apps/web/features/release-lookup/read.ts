import { failureOf } from '../work-page/failure.ts';
import { reader } from '../work-page/read.ts';
import type { Loaded } from '../work-page/types.ts';
import type { ReleasePage } from '../work-levels/types.ts';
import type { ReleaseIdentifier } from './route.ts';

/**
 * Releases carrying a provider-qualified identifier, as Main resolves it. Main answers 409 when the graph moved
 * during the read; a first page starts again once, as the ISBN lookup does.
 */
export async function readReleasesByIdentifier({ provider, identifier }: ReleaseIdentifier, cursor?: string):
  Promise<Loaded<ReleasePage>> {
  const { main, actingSubject } = await reader();
  try {
    let { data, error } = await main.v1.releases.get({ query: { provider, identifier, actingSubject, cursor } });
    if (error?.status === 409 && !cursor) ({ data, error } = await main.v1.releases.get({ query: { provider, identifier, actingSubject } }));
    if (error) return { ok: false, failure: failureOf(error.status) };
    return data ? { ok: true, data } : { ok: false, failure: 'unavailable' };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
