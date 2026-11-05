import type { SearchDriver } from '../../../../specs/search-driver.ts';
import { createDriverClient } from './support/driver-client.ts';

/** Original suites explicitly open advanced Search in their isolated native fixture. */
export function createSearchDriver(): Promise<SearchDriver> {
  return createDriverClient(undefined, { advancedSearch: true }).init();
}
