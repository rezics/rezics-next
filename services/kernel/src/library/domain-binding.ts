/** Process composition binds the Library domain once. Compatibility entries read this handle. */

import type { LibraryDomain } from './contract/index.ts';

let domain: LibraryDomain | undefined;

export function bindLibraryDomain(value: LibraryDomain): LibraryDomain {
  domain = value;
  return value;
}

export function peekLibraryDomain(): LibraryDomain | undefined {
  return domain;
}

export function requireLibraryDomain(): LibraryDomain {
  if (!domain) throw new TypeError('Library domain is not composed');
  return domain;
}
