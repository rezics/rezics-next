import type { ReadContext } from './model.ts';
import { type ContentReadDependencies } from './reads.ts';
export type SubjectThreadContext = Readonly<{
    subject: Readonly<{
        id: string;
        label: Readonly<{
            value: string;
            language: string;
        }> | null;
        source: Readonly<{
            partition: number;
            epoch: number;
            position: string;
        }>;
    }>;
    place: Readonly<{
        kind: 'global';
        id: string;
    }> | Readonly<{
        kind: 'realm';
        id: string;
        title: string;
        spaceId: string;
        headRevisionId: string;
    }>;
    kind: 'discussion' | 'review';
}>;
/** Current list identity only. It conveys no creation or command authority. */
export declare function prepareSubjectThreadContext(deps: ContentReadDependencies, subjectId: string, placeId: string, kind: SubjectThreadContext['kind'], context: ReadContext): Promise<Readonly<{
    initial: SubjectThreadContext;
    finish(): Promise<SubjectThreadContext>;
}>>;
