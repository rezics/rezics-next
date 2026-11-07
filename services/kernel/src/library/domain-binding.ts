import type { NativeCopyListContext } from '../semantic/adapters/index.ts';
/** Process composition binds the Library domain once. Compatibility entries read this handle. */

import type { CopyApplicationPorts } from './contract/index.ts';
import type { NativeCopyConfig, NativeCopyTypes } from './adapters/copies.ts';
import type { NativeLibraryPresentation } from './adapters/presentation.ts';
import type { LibraryDomain } from './contract/index.ts';
import type { NativePreparationWorkFactory, NativeScopeWork } from './adapters/preparation-work.ts';
import type { LibraryMembersPreparationRuntime } from './domain.ts';

export type NativeLibraryDomain = LibraryDomain &
  Readonly<{
    preparationWork?: NativePreparationWorkFactory;
    scopeWork?: NativeScopeWork;
    copyContext?: NativeCopyListContext;
    copyPorts?: (config: NativeCopyConfig) => CopyApplicationPorts<NativeCopyTypes>;
    presentation?: NativeLibraryPresentation;
    membersPreparation?: LibraryMembersPreparationRuntime;
  }>;

let binding: { domain?: NativeLibraryDomain; presentation?: NativeLibraryPresentation } = {};

export function bindLibraryDomain(value: NativeLibraryDomain): NativeLibraryDomain {
  binding = { domain: value, ...(value.presentation ? { presentation: value.presentation } : {}) };
  return value;
}

export function peekLibraryDomain(): NativeLibraryDomain | undefined {
  return binding.domain;
}

export function requireLibraryDomain(): NativeLibraryDomain {
  if (!binding.domain) throw new TypeError('Library domain is not composed');
  return binding.domain;
}

export function requireLibraryMembersPreparation(): LibraryMembersPreparationRuntime {
  const runtime = binding.domain?.membersPreparation;
  if (!runtime) throw new TypeError('Library members preparation is not composed');
  return runtime;
}

/** Tests restore the process binding; createKernel/server/worker rebind native adapters. */
export function unbindLibraryDomain(): void {
  binding = {};
}

/** The single Library domain binding also owns its native presentation capabilities. */
export function requireLibraryPresentation(): NativeLibraryPresentation {
  const presentation = binding.presentation;
  if (!presentation) throw new TypeError('Library presentation is not composed');
  return presentation;
}

/** Direct native readers install the presentation slice without inventing a Source capability. */
export function bindLibraryPresentation(presentation: NativeLibraryPresentation): void {
  binding = { ...binding, presentation };
}
