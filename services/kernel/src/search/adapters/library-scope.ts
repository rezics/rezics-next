/** Search construction of the supplied Library scoped-Source capability. Composition installs this. */

import { createScopedSearchLibraryOperations } from '../../library/adapters/index.ts';
import type { SearchLibraryScopePort } from '../library-scope-port.ts';

/** Construct limits, receiving costs and native Source operations for one Search application. */
export function createSearchLibraryScopePort(): SearchLibraryScopePort {
  return createScopedSearchLibraryOperations();
}
