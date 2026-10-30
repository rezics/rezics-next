import type { Pool } from 'pg';
import { type PublicSubjectPageCandidate } from './subject-page-navigation.ts';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type PublicationEntry } from './subject-page-publication-store.ts';
import type { SubjectPagePublication } from './subject-page-publication.ts';
/** The crawler advances one raw source home, including omitted candidates. */
export declare function createSubjectPageFeed(config: {
    pool: Pool;
    access: Access;
    clock: KernelClock;
    routeKey: Uint8Array;
    tokens: KeyRing;
    publication: SubjectPagePublication;
}): {
    page(options: {
        limit?: number;
        cursor?: string;
    }): Promise<{
        subjectPages: (PublicationEntry & {
            target: PublicSubjectPageCandidate['target'];
            views: string[];
        })[];
        next: string | null;
    }>;
};
export type SubjectPageFeed = ReturnType<typeof createSubjectPageFeed>;
