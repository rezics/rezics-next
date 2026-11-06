import { memoizedValue } from '../../memoized.ts';
import { derivedId, partitionOf, routeOf } from '../../route/route.ts';
import type { RoutePort } from '../contract/domain-ports.ts';

/** Native routed IDs. Composition binds this; cores never import the route encoder. */
export function nativeRouting(): RoutePort {
  return memoizedValue(nativeRouting, () =>
    Object.freeze({
      routeOf,
      derivedId,
      partitionOf,
    }),
  );
}
