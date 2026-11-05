import { createHmac } from 'node:crypto';
import type { AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import controllerRead from './rating-counter.sql';

export type RatingCounter = (client: AccessClient, accountId: string, at: string | Date) => Promise<string>;

/** Trusted kernel composition supplies a stable, private secret shared by all rating workers. */
export function createRatingCounter(config: { secret: Uint8Array }): RatingCounter {
  if (config.secret.byteLength < 32) throw new TypeError('Rating counter secret must contain at least 32 bytes');
  const secret = Buffer.from(config.secret);
  return async function ratingCounter(client, accountId, at) {
    const route = routeOf(accountId);
    const instant = at instanceof Date ? at.toISOString() : at;
    if (route === null || !Number.isFinite(Date.parse(instant))) throw new TypeError('Invalid rating counter input');
    const row = await controllerRead.run(client, { route, account_id: accountId, at: instant });
    if (!row) throw new TypeError('Rating counter account unavailable');
    // Domain separation prevents correlation with any other kernel HMAC port.
    return createHmac('sha256', secret).update(`access.rating-counter.v1\0${row.controllerId}`).digest('hex');
  };
}
