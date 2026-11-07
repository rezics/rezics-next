import type { NativeCopyListContext } from '../semantic/adapters/index.ts';
/** Process composition binds the Library domain once. Compatibility entries read this handle. */

import type { CopyApplicationPorts } from './contract/index.ts';
import type { NativeCopyConfig, NativeCopyTypes } from './adapters/copies.ts';
import type { LibraryDomain } from './contract/index.ts';
import type { NativePreparationWorkFactory, NativeScopeWork } from './adapters/preparation-work.ts';

export type NativeLibraryDomain = LibraryDomain &
  Readonly<{
    preparationWork?: NativePreparationWorkFactory;
    scopeWork?: NativeScopeWork;
    copyContext?: NativeCopyListContext;
    copyPorts?: (config: NativeCopyConfig) => CopyApplicationPorts<NativeCopyTypes>;
  }>;

let domain: NativeLibraryDomain | undefined;

export function bindLibraryDomain(value: NativeLibraryDomain): NativeLibraryDomain {
  domain = value;
  return value;
}

export function peekLibraryDomain(): NativeLibraryDomain | undefined {
  return domain;
}

export function requireLibraryDomain(): NativeLibraryDomain {
  if (!domain) throw new TypeError('Library domain is not composed');
  return domain;
}

/** Tests restore the process binding; createKernel/server/worker rebind native adapters. */
export function unbindLibraryDomain(): void {
  domain = undefined;
}
