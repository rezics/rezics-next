/** Copy-native capability shapes. This module imports no foreign implementations. */
import type { Pool } from 'pg';
import type { Release } from '@rezics/definitions';
import type { AuthoritativeTime, CommandTransaction } from '../command/command.ts';
import type { createLibraryCommandRunner } from './command-support.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, AccountActor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { CopyAccountAuthority, CopyReleasedDefinitions, CopyOperationWork } from './contract/index.ts';
import type {
  LibraryProfileAnchor,
  LibraryProfileSourceDependencies,
  readLibraryProfileSourceObservation,
} from './profile-source.ts';

export { CopyConflictError, CopyInvalidError } from './contract/index.ts';
export type { CopyPresentation } from './contract/index.ts';
export type NativeCopyConfig = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
export type NativeCopyDefinitions = CopyReleasedDefinitions<Pool | CommandTransaction, Release>;
export type CopySourceObservation = Awaited<ReturnType<typeof readLibraryProfileSourceObservation>>;
export interface CopyProfileSource {
  observe(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<CopySourceObservation>;
  anchor(deps: LibraryProfileSourceDependencies, subjectId: string): Promise<LibraryProfileAnchor | null>;
}
export type NativeCopyProducers = {
  account: CopyAccountAuthority<CommandTransaction, AccountActor, AuthoritativeTime>;
  definitions: NativeCopyDefinitions;
  profileSource: CopyProfileSource;
  work: CopyOperationWork;
  commands: Pick<ReturnType<typeof createLibraryCommandRunner>, 'ownAccountPrepared'>;
};

/** Source currentness is compared without loading either foreign producer. */
export function sameCopyProfileAnchor(before: LibraryProfileAnchor, after: LibraryProfileAnchor | null): boolean {
  return (
    after !== null &&
    before.subjectId === after.subjectId &&
    before.requestedSubjectId === after.requestedSubjectId &&
    before.acceptingType === after.acceptingType &&
    before.identityEpoch === after.identityEpoch &&
    before.component.partition === after.component.partition &&
    before.component.epoch === after.component.epoch &&
    before.component.position === after.component.position
  );
}
