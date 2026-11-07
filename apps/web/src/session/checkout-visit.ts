import type { QueryClient } from '@tanstack/react-query';
import type { CheckoutCurrentVisit } from '../checkout/reader-origin';
import { browserObservation } from './observation';

/** Reuse the mounted observation, including equal-success and ABA retirement, without another session read. */
export function checkoutCurrentVisit(client: QueryClient): CheckoutCurrentVisit {
  const observation = browserObservation(client);
  return {
    publish: observation.publish,
    subscribeRetirement(retire) {
      const session = observation.subscribeRetirement(retire);
      const exposure = observation.subscribeCache((event) => {
        const current = observation.getSnapshot();
        const key = event.query.queryKey;
        if (
          current.state === 'signed-in' &&
          key[0] === 'exposure' &&
          key[1] === 'viewer' &&
          key[2] === current.observation.subject &&
          key[3] === current.observation.id &&
          event.type === 'updated' &&
          ['success', 'error', 'invalidate'].includes(event.action.type)
        )
          retire();
      });
      return () => {
        session();
        exposure();
      };
    },
  };
}
