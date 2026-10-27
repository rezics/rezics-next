import type { SearchDriver } from '../../../../specs/search-driver.ts';
import { createDriverClient } from './support/driver-client.ts';

/** One isolated real Auth supervisor and default kernel worker per factory. */
export function createSearchDriver(): Promise<SearchDriver> {
  return createDriverClient().init();
}
