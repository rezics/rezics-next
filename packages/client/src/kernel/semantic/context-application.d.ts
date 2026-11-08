import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { CONTEXT_GLOBAL_ID, type ContextAccessHandle, type ContextAccessPort, type ContextActor, type ContextDirectoryEntry, type ContextDirectoryPage, type ContextDirectoryQuery, type ContextDirectoryRead, type ContextQueryClient, type ContextRoleOccurrenceInput, ContextDirectoryPreparingError } from './context-access-port.ts';
import { CONTEXT_DIRECTORY_CHANGED, ContextDirectoryEntrySchema, contextDirectoryEffect, createContextDirectory, populateContextDirectory, registerContextDirectoryWork, stepContextDirectory, type ContextDirectory } from './context-directory.ts';
import { authorizedContextMetadata, contextNativeActions, readNativeContextMetadata, type NativeContextMetadata } from './context-lifecycle-read.ts';
import { changeContextLifecycle, ContextLifecycleConflictError } from './context-lifecycle.ts';
import { contextLabels, contextSnapshot, contextTarget, ContextAccessDeniedError, ContextNotFoundError, CREATE_CONTEXT, createContext, editorialContextAnchor, globalContextAnchor, publicContextEligibility, readContext, type ContextRecord } from './context.ts';
import { enrollContextRoleProvenance, type ContextRoleEnrollmentResult } from './context-role-provenance.ts';
export type ContextApplicationDependencies = Readonly<{
    pool: Pool;
    access: ContextAccessHandle;
    tokens: KeyRing;
    clock?: () => Date;
}>;
/** Installed Context directory, lifecycle and provenance operations. */
export type ContextApplication = Readonly<{
    access: ContextAccessPort;
    createDirectory(dependencies: ContextApplicationDependencies): ContextDirectory;
    list(dependencies: ContextApplicationDependencies, input: ContextDirectoryRead & ContextDirectoryQuery): Promise<ContextDirectoryPage>;
    lifecycle(dependencies: ContextApplicationDependencies, input: ContextDirectoryRead & {
        id: string;
    }): Promise<ContextDirectoryEntry | null>;
    authorizedMetadata(dependencies: Parameters<typeof authorizedContextMetadata>[0], input: Parameters<typeof authorizedContextMetadata>[1]): ReturnType<typeof authorizedContextMetadata>;
    nativeActions: typeof contextNativeActions;
    readNativeMetadata(pool: Parameters<typeof readNativeContextMetadata>[0], ids: Parameters<typeof readNativeContextMetadata>[1], actor: Parameters<typeof readNativeContextMetadata>[2], at: Parameters<typeof readNativeContextMetadata>[3], deadline: Parameters<typeof readNativeContextMetadata>[4]): ReturnType<typeof readNativeContextMetadata>;
    changeLifecycle(pool: Parameters<typeof changeContextLifecycle>[0], options: Parameters<typeof changeContextLifecycle>[1]): ReturnType<typeof changeContextLifecycle>;
    create(pool: Parameters<typeof createContext>[0], options: Parameters<typeof createContext>[1]): ReturnType<typeof createContext>;
    read(pool: Parameters<typeof readContext>[0], id: Parameters<typeof readContext>[1], authorize: Parameters<typeof readContext>[2]): ReturnType<typeof readContext>;
    snapshot(pool: Parameters<typeof contextSnapshot>[0], id: Parameters<typeof contextSnapshot>[1]): ReturnType<typeof contextSnapshot>;
    publicEligibility(resource: Parameters<typeof publicContextEligibility>[0]): ReturnType<typeof publicContextEligibility>;
    enrollRoleProvenance(tx: Parameters<typeof enrollContextRoleProvenance>[0], input: Parameters<typeof enrollContextRoleProvenance>[1]): ReturnType<typeof enrollContextRoleProvenance>;
    stepDirectory(pool: Parameters<typeof stepContextDirectory>[0], home: Parameters<typeof stepContextDirectory>[1], clock?: Parameters<typeof stepContextDirectory>[2]): ReturnType<typeof stepContextDirectory>;
    populateDirectory(pool: Parameters<typeof populateContextDirectory>[0], clock?: Parameters<typeof populateContextDirectory>[1], steps?: Parameters<typeof populateContextDirectory>[2]): ReturnType<typeof populateContextDirectory>;
    directoryEffect(pool: Parameters<typeof contextDirectoryEffect>[0], clock?: Parameters<typeof contextDirectoryEffect>[1]): ReturnType<typeof contextDirectoryEffect>;
    registerDirectoryWork(context: Parameters<typeof registerContextDirectoryWork>[0]): ReturnType<typeof registerContextDirectoryWork>;
}>;
/** Use cases over the Semantic-owned Context Access port. Native Access is never imported here. */
export declare function createContextApplication(port: ContextAccessPort): ContextApplication;
export declare function bindContextApplication(application: ContextApplication): ContextApplication;
export declare function contextApplication(): ContextApplication;
export declare function tryContextApplication(): ContextApplication | undefined;
/** Tests restore the process binding; createKernel rebinds native ports. */
export declare function unbindContextApplication(): void;
export { CONTEXT_DIRECTORY_CHANGED, CONTEXT_GLOBAL_ID, CREATE_CONTEXT, ContextAccessDeniedError, ContextDirectoryEntrySchema, ContextDirectoryPreparingError, ContextLifecycleConflictError, ContextNotFoundError, authorizedContextMetadata, changeContextLifecycle, contextDirectoryEffect, contextLabels, contextNativeActions, contextSnapshot, contextTarget, createContext, createContextDirectory, editorialContextAnchor, enrollContextRoleProvenance, globalContextAnchor, populateContextDirectory, publicContextEligibility, readContext, readNativeContextMetadata, registerContextDirectoryWork, stepContextDirectory, };
export type { ContextAccessHandle, ContextAccessPort, ContextActor, ContextDirectory, ContextDirectoryEntry, ContextDirectoryPage, ContextDirectoryQuery, ContextDirectoryRead, ContextQueryClient, ContextRecord, ContextRoleEnrollmentResult, ContextRoleOccurrenceInput, NativeContextMetadata, };
