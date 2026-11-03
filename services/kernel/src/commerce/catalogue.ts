import type { ParentAnchor } from '../access/index.ts';
import { readAccount } from '../access/account-data.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { Offer } from './model.ts';
import { readOffer } from './store.ts';

/** Offers are created under the platform's Global Context. */
export const platformRootAnchor: ParentAnchor = Object.freeze({
  resource: Object.freeze({ route: 0, id: '00000000-0000-8000-8000-000000000000' }),
  async validate(_client, time) {
    authoritativeTimeValue(time);
    return true;
  },
});

/** An anchor belongs to one command invocation; each retry retains its own read at T.
 * Availability is checked in the body, after receipts: a delisted offer still
 * has its ordinary order:create grants, so authorized replays can complete.
 */
export function offerParentAnchor(id: string): ParentAnchor & {
  at(time: AuthoritativeTime): Offer;
  availableAt(time: AuthoritativeTime): boolean;
} {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Invalid offer ID');
  const reads = new WeakMap<AuthoritativeTime, { offer: Offer; available: boolean }>();
  return {
    resource: Object.freeze({ route, id }),
    async validate(client, time) {
      authoritativeTimeValue(time);
      const offer = await readOffer(client, route, id);
      if (!offer) return false;
      // Offers live on their creator's home. Prepare at authoritative T and release
      // this source connection before the buyer command; no foreign lock crosses homes.
      const creator = await readAccount(client, route, offer.creatorAccountId);
      reads.set(time, { offer, available: creator !== null && creator.state !== 'deleted' });
      return true;
    },
    at(time) {
      authoritativeTimeValue(time);
      const offer = reads.get(time);
      if (!offer) throw new TypeError('No offer read for this command attempt');
      return offer.offer;
    },
    availableAt(time) {
      authoritativeTimeValue(time);
      const read = reads.get(time);
      if (!read) throw new TypeError('No offer read for this command attempt');
      return read.available;
    },
  };
}
