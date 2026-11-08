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
export type NativeLibraryDomain = LibraryDomain & Readonly<{
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
export declare function bindLibraryDomain(value: NativeLibraryDomain): NativeLibraryDomain;
export declare function peekLibraryDomain(): NativeLibraryDomain | undefined;
export declare function peekLibraryPresentation(): NativeLibraryPresentation | undefined;
export declare function requireLibraryDomain(): NativeLibraryDomain;
export declare function requireLibraryMembersPreparation(): LibraryMembersPreparationRuntime;
/** Tests restore the process binding; createKernel/server/worker rebind native adapters. */
export declare function unbindLibraryDomain(): void;
/** The single Library domain binding also owns its native presentation capabilities. */
export declare function requireLibraryPresentation(): NativeLibraryPresentation;
/** Direct native readers install the presentation slice without inventing a Source capability. */
export declare function bindLibraryPresentation(presentation: NativeLibraryPresentation): void;
/** The same native Access binding serves presentation-only preloads and full domain composition. */
export declare function bindLibraryAccess(access: LibraryAccessPorts): void;
export declare function requireLibraryAccess(): LibraryAccessPorts;
/** Composition installs real native copy producers for server, worker and standalone construction. */
export declare function bindLibraryCopy(value: NativeLibraryCopyBinding): void;
export declare function requireLibraryCopyBinding(): NativeLibraryCopyBinding;
export declare function requireLibraryCopyWork(): CopyOperationWork;
