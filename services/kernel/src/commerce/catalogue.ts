import type { ParentAnchor } from '../access/index.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { Offer } from './model.ts';
import { readOffer } from './store.ts';

/** Offers are created under the platform's Global Context. */
export const platformRootAnchor: ParentAnchor = Object.freeze({
  resource: Object.freeze({ route: 0, id: GLOBAL_CONTEXT }),
  async validate(_client, time) {
    authoritativeTimeValue(time);
    return true;
  },
});

/** An anchor belongs to one command invocation; each retry retains its own read at T.
 * Availability is checked in the body, after receipts: a delisted offer still
 * has its ordinary order:create grants, so authorized replays can complete.
 */
export function offerParentAnchor(id: string): ParentAnchor & { at(time: AuthoritativeTime): Offer } {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Invalid offer ID');
  const reads = new WeakMap<AuthoritativeTime, Offer>();
  return {
    resource: Object.freeze({ route, id }),
    async validate(client, time) {
      authoritativeTimeValue(time);
      const offer = await readOffer(client, route, id);
      if (!offer) return false;
      reads.set(time, offer);
      return true;
    },
    at(time) {
      authoritativeTimeValue(time);
      const offer = reads.get(time);
      if (!offer) throw new TypeError('No offer read for this command attempt');
      return offer;
    },
  };
}
