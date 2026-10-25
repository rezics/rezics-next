import type { ParentAnchor } from '../access/index.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { Offer } from './model.ts';
import { readOffer } from './store.ts';

/** Commerce owns a fixed root, separate from the semantic Global Context. */
export const COMMERCE_CATALOGUE = '00000000-0000-8000-8000-000000000002';
export const commerceCatalogueAnchor: ParentAnchor = Object.freeze({
  resource: Object.freeze({ route: 0, id: COMMERCE_CATALOGUE }),
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
