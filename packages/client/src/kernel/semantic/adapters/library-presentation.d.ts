import type { Pool } from 'pg';
import type { SubjectIdentityCapability, SubjectReferenceObservation } from '../../library/contract/index.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import { type Access, type AccessContext, type Actor } from '../../request/access.ts';
import type { IdentityMapping } from '../contract/index.ts';
import type { SummaryReaderDependencies } from '../summaries.ts';
import type { LibrarySemanticObservationCapability, LibrarySemanticObservationResult } from '../../library/contract/semantic-observation.ts';
import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
export type LibrarySubjectIdentityContext = Readonly<{
    pool: Pool;
    access: Access;
    actor: Actor;
    at?: AuthoritativeTime;
    context: AccessContext;
}>;
/** Uses the single Identity producer. Mapping never supplies authorization or native disclosure. */
export type LibrarySubjectReferenceResult = SubjectReferenceObservation & Readonly<{
    work: WorkDimensions;
}>;
export type LibrarySubjectIdentityAdapter = SubjectIdentityCapability<LibrarySubjectIdentityContext, IdentityMapping, LibrarySubjectReferenceResult>;
export declare function createLibrarySubjectIdentityAdapter(observations: LibrarySemanticObservationCapability): LibrarySubjectIdentityAdapter;
/** One native bounded summary observation; all its Source, cover and disclosure fences survive composition. */
export declare function observeLibrarySubjectSummaries(observations: LibrarySemanticObservationCapability, deps: SummaryReaderDependencies, ids: readonly string[]): Promise<Readonly<{
    value: Readonly<{
        summaries: ReadonlyMap<string, unknown | null>;
        current(): Promise<LibrarySemanticObservationResult<boolean>>;
    }>;
    work: WorkDimensions;
}>>;
/** Original inputs retain the exact producer mapping including epoch, pending job and unavailable reason. */
export declare function readLibraryIdentityMappings(observations: LibrarySemanticObservationCapability, pool: Pool, ids: readonly string[]): Promise<{
    work: WorkDimensions;
    value: readonly IdentityMapping[];
}>;
