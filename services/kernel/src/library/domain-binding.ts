import type { LibraryAccessPorts } from './access-port.ts';
import type { NativeCopyListContext } from '../semantic/adapters/index.ts';
/** Process composition binds the Library domain once. Compatibility entries read this handle. */
import type { CopyApplicationPorts } from './contract/index.ts';
import type { NativeCopyConfig, NativeCopyTypes } from './adapters/copies.ts';
import type { NativeLibraryPresentation } from './adapters/presentation.ts';
import type { LibraryDomain } from './contract/index.ts';
import type { NativePreparationWorkFactory, NativeScopeWork } from './adapters/preparation-work.ts';

export type NativeLibraryDomain = LibraryDomain &
  Readonly<{
    preparationWork?: NativePreparationWorkFactory;
    scopeWork?: NativeScopeWork;
    copyContext?: NativeCopyListContext;
    copyPorts?: (config: NativeCopyConfig) => CopyApplicationPorts<NativeCopyTypes>;
    presentation?: NativeLibraryPresentation;
  }>;

let binding: { domain?: NativeLibraryDomain; presentation?: NativeLibraryPresentation; access?: LibraryAccessPorts } =
  {};

export function bindLibraryDomain(value: NativeLibraryDomain): NativeLibraryDomain {
  binding = {
    ...(binding.access ? { access: binding.access } : {}),
    domain: value,
    ...(value.presentation ? { presentation: value.presentation } : {}),
  };
  return value;
}

export function peekLibraryDomain(): NativeLibraryDomain | undefined {
  return binding.domain;
}

export function requireLibraryDomain(): NativeLibraryDomain {
  if (!binding.domain) throw new TypeError('Library domain is not composed');
  return binding.domain;
}

/** Tests restore the process binding; createKernel/server/worker rebind native adapters. */
export function unbindLibraryDomain(): void {
  binding = { ...(binding.access ? { access: binding.access } : {}) };
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

/** The same native Access binding serves presentation-only preloads and full domain composition. */
export function bindLibraryAccess(access: LibraryAccessPorts): void {
  binding = { ...binding, access };
}

export function requireLibraryAccess(): LibraryAccessPorts {
  return binding.access!;
}
