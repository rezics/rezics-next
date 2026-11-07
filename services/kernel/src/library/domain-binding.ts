import type { LibraryAccessPorts } from './access-port.ts';
import type { NativeCopyListContext } from '../semantic/adapters/index.ts';
/** Process composition binds the Library domain once. Compatibility entries read this handle. */
import type { CopyApplicationPorts, CopyOperationWork } from './contract/index.ts';
import type { NativeCopyTypes } from './adapters/copies.ts';
import type { NativeCopyConfig, NativeCopyProducers } from './copy-model.ts';
import type { NativeLibraryPresentation } from './adapters/presentation.ts';
import type { LibraryDomain } from './contract/index.ts';
import type { NativePreparationWorkFactory, NativeScopeWork } from './adapters/preparation-work.ts';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import type { Pool } from 'pg';
import type { NativePublicOutputApplication } from './contract/native-public-output.ts';
import type { LibraryMembersPreparationRuntime } from './domain.ts';

export type NativeLibraryDomain = LibraryDomain &
  Readonly<{
    preparationWork?: NativePreparationWorkFactory;
    scopeWork?: NativeScopeWork;
    copyContext?: NativeCopyListContext;
    copyPorts?: (config: NativeCopyConfig) => CopyApplicationPorts<NativeCopyTypes>;
    presentation?: NativeLibraryPresentation;
    nativePublicOutput?: NativePublicOutputApplication<CommandTransaction, Pool, AuthoritativeTime>;
    membersPreparation?: LibraryMembersPreparationRuntime;
  }>;

export type NativeLibraryCopyBinding = Readonly<{
  producers(config: NativeCopyConfig): NativeCopyProducers;
  ports(config: NativeCopyConfig): CopyApplicationPorts<NativeCopyTypes>;
  work: CopyOperationWork;
}>;

let binding: {
  domain?: NativeLibraryDomain;
  presentation?: NativeLibraryPresentation;
  access?: LibraryAccessPorts;
  copy?: NativeLibraryCopyBinding;
} = {};

export function bindLibraryDomain(value: NativeLibraryDomain): NativeLibraryDomain {
  binding = {
    ...(binding.access ? { access: binding.access } : {}),
    ...(binding.copy ? { copy: binding.copy } : {}),
    domain: value,
    ...(value.presentation ? { presentation: value.presentation } : {}),
  };
  return value;
}

export function peekLibraryDomain(): NativeLibraryDomain | undefined {
  return binding.domain;
}

export function peekLibraryPresentation(): NativeLibraryPresentation | undefined {
  return binding.presentation;
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
  binding = {
    ...(binding.access ? { access: binding.access } : {}),
    ...(binding.copy ? { copy: binding.copy } : {}),
  };
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

/** Composition installs real native copy producers for server, worker and standalone construction. */
export function bindLibraryCopy(value: NativeLibraryCopyBinding): void {
  binding = { ...binding, copy: value };
}
export function requireLibraryCopyBinding(): NativeLibraryCopyBinding {
  return binding.copy!;
}
export function requireLibraryCopyWork(): CopyOperationWork {
  return requireLibraryCopyBinding().work;
}
