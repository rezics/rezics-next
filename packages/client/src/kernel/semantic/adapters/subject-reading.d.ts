import type { Pool, PoolClient } from 'pg';
import type { Release } from '@rezics/definitions';
import type { ContentCoverRef } from '../contract/domain-ports.ts';
import type { SubjectReadingNativePort, SubjectReadingFence, SubjectReadingFenceTuple } from '../contract/index.ts';
import type { ContextRecord } from '../context.ts';
import { readCurrentContentDocument } from '../../content/adapters/index.ts';
import { readCharacterPublicDocuments } from '../character-public-reading-documents.ts';
import { type SubjectReadingRuntime } from '../subject-reading-application.ts';
import type { SubjectReadingApplication } from '../subject-reading-application.ts';
type Connection = Pool | Pick<PoolClient, 'query'>;
type NativeFenceTuple = SubjectReadingFenceTuple & {
    field_group: 'facts' | 'summary' | 'cover';
};
type NativeFence = SubjectReadingFence & {
    field_group: 'facts' | 'summary' | 'cover';
};
type CurrentDocumentRead = Awaited<ReturnType<typeof readCurrentContentDocument>>;
type CharacterDocumentsRead = Awaited<ReturnType<typeof readCharacterPublicDocuments>>;
/** Native Content and Semantic producers used by the ordinary Subject reading composition. */
export declare function createNativeSubjectReadingPort(): SubjectReadingNativePort<SubjectReadingRuntime, Connection, Release, ContextRecord, CurrentDocumentRead, CharacterDocumentsRead, ContentCoverRef, NativeFenceTuple, NativeFence>;
/** Install the process's native reading application once for compatibility clients and composed hosts. */
export declare function installNativeSubjectReadingApplication(create: () => SubjectReadingApplication): SubjectReadingApplication;
/** Compatibility clients share the application installed by composition, creating it lazily for old hosts. */
export declare function nativeSubjectReadingApplication(): SubjectReadingApplication;
export {};
