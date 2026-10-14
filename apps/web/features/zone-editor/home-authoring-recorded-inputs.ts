import { browserMainApi } from '../api/browser.ts';
import { browserZoneNavigation, type ZoneNavigationClient } from './api.ts';
import { foldMountPages, zoneMountPage } from './navigation.ts';

/** The home proof captures Main's default navigation page, with route-segment fallback names.
 * Replay that request and map its captured page; the navigation proof covers explicit-size and name reads. */
export function recordedHomeNavigation(main: ReturnType<typeof browserMainApi>): ZoneNavigationClient {
  return { ...browserZoneNavigation(main),
    async readNavigation(zoneId, actingSubject) {
      const answer = await main.v1.zones({ id: zoneId }).get({ query: { actingSubject } });
      const page = zoneMountPage(answer.data);
      const snapshot = page ? foldMountPages([page]) : null;
      return snapshot ? { ok: true, data: snapshot } : { ok: false, failure: 'unavailable' };
    },
  };
}
