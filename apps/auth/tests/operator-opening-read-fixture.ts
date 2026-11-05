import { spyOn } from 'bun:test';
import { operatorOpeningBrowserTransport, parseOpenedSessionObservation } from '../src/operator-session-opening';

/** Route tests control BFF delivery; the installed native transport has separate stream coverage. */
export function openingReadbackFixture() {
  return spyOn(operatorOpeningBrowserTransport, 'session').mockImplementation(async (input, signal) => {
    const response = await fetch('/session', { signal });
    return response.status === 200
      ? parseOpenedSessionObservation(await response.json(), input, 4)
      : { kind: 'unknown' };
  });
}
