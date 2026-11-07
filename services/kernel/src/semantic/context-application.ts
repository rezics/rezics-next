import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import {
  CONTEXT_GLOBAL_ID,
  type ContextAccessHandle,
  type ContextAccessPort,
  type ContextActor,
  type ContextDirectoryEntry,
  type ContextDirectoryPage,
  type ContextDirectoryQuery,
  type ContextDirectoryRead,
  type ContextQueryClient,
  type ContextRoleOccurrenceInput,
  ContextDirectoryPreparingError,
} from './context-access-port.ts';
import {
  CONTEXT_DIRECTORY_CHANGED,
  ContextDirectoryEntrySchema,
  contextDirectoryEffect,
  createContextDirectory,
  populateContextDirectory,
  registerContextDirectoryWork,
  stepContextDirectory,
  type ContextDirectory,
} from './context-directory.ts';
import {
  authorizedContextMetadata,
  contextNativeActions,
  readNativeContextMetadata,
  type NativeContextMetadata,
} from './context-lifecycle-read.ts';
import { changeContextLifecycle, ContextLifecycleConflictError } from './context-lifecycle.ts';
import {
  contextLabels,
  contextSnapshot,
  contextTarget,
  ContextAccessDeniedError,
  ContextNotFoundError,
  CREATE_CONTEXT,
  createContext,
  editorialContextAnchor,
  globalContextAnchor,
  publicContextEligibility,
  readContext,
  type ContextRecord,
} from './context.ts';
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
  list(
    dependencies: ContextApplicationDependencies,
    input: ContextDirectoryRead & ContextDirectoryQuery,
  ): Promise<ContextDirectoryPage>;
  lifecycle(
    dependencies: ContextApplicationDependencies,
    input: ContextDirectoryRead & { id: string },
  ): Promise<ContextDirectoryEntry | null>;
  authorizedMetadata: typeof authorizedContextMetadata;
  nativeActions: typeof contextNativeActions;
  readNativeMetadata: typeof readNativeContextMetadata;
  changeLifecycle: typeof changeContextLifecycle;
  create: typeof createContext;
  read: typeof readContext;
  snapshot: typeof contextSnapshot;
  publicEligibility: typeof publicContextEligibility;
  enrollRoleProvenance: typeof enrollContextRoleProvenance;
  stepDirectory: typeof stepContextDirectory;
  populateDirectory: typeof populateContextDirectory;
  directoryEffect: typeof contextDirectoryEffect;
  registerDirectoryWork: typeof registerContextDirectoryWork;
}>;

let bound: ContextApplication | undefined;

/** Use cases over the Semantic-owned Context Access port. Native Access is never imported here. */
export function createContextApplication(port: ContextAccessPort): ContextApplication {
  const directory = (dependencies: ContextApplicationDependencies) =>
    createContextDirectory({ ...dependencies, ports: port });
  return Object.freeze({
    access: port,
    createDirectory: directory,
    list(dependencies, input) {
      return directory(dependencies).list(input);
    },
    lifecycle(dependencies, input) {
      return directory(dependencies).lifecycle(input);
    },
    authorizedMetadata: authorizedContextMetadata,
    nativeActions: contextNativeActions,
    readNativeMetadata: readNativeContextMetadata,
    changeLifecycle: changeContextLifecycle,
    create: createContext,
    read: readContext,
    snapshot: contextSnapshot,
    publicEligibility: publicContextEligibility,
    enrollRoleProvenance: enrollContextRoleProvenance,
    stepDirectory: stepContextDirectory,
    populateDirectory: populateContextDirectory,
    directoryEffect: contextDirectoryEffect,
    registerDirectoryWork: registerContextDirectoryWork,
  });
}

export function bindContextApplication(application: ContextApplication): ContextApplication {
  bound = application;
  return application;
}

export function contextApplication(): ContextApplication {
  if (!bound) throw new Error('Context application is not bound');
  return bound;
}

export function tryContextApplication(): ContextApplication | undefined {
  return bound;
}

/** Tests restore the process binding; createKernel rebinds native ports. */
export function unbindContextApplication(): void {
  bound = undefined;
}

export {
  CONTEXT_DIRECTORY_CHANGED,
  CONTEXT_GLOBAL_ID,
  CREATE_CONTEXT,
  ContextAccessDeniedError,
  ContextDirectoryEntrySchema,
  ContextDirectoryPreparingError,
  ContextLifecycleConflictError,
  ContextNotFoundError,
  authorizedContextMetadata,
  changeContextLifecycle,
  contextDirectoryEffect,
  contextLabels,
  contextNativeActions,
  contextSnapshot,
  contextTarget,
  createContext,
  createContextDirectory,
  editorialContextAnchor,
  enrollContextRoleProvenance,
  globalContextAnchor,
  populateContextDirectory,
  publicContextEligibility,
  readContext,
  readNativeContextMetadata,
  registerContextDirectoryWork,
  stepContextDirectory,
};
export type {
  ContextAccessHandle,
  ContextAccessPort,
  ContextActor,
  ContextDirectory,
  ContextDirectoryEntry,
  ContextDirectoryPage,
  ContextDirectoryQuery,
  ContextDirectoryRead,
  ContextQueryClient,
  ContextRecord,
  ContextRoleEnrollmentResult,
  ContextRoleOccurrenceInput,
  NativeContextMetadata,
};
