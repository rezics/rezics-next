import type { SummaryReaderDependencies } from './summaries.ts';
export type PublicSubjectPageCandidate = {
    id: string;
    target: {
        family: 'subject';
        subjectId: string;
    } | {
        family: 'account';
        accountId: string;
        canonicalPath: string;
    };
    views: readonly string[];
};
/** Released native observations bracket the publication reader's existing proof, without new leaf reads. */
export declare function preparePublicSubjectPageCandidates(deps: SummaryReaderDependencies, subjectIds: readonly string[]): Promise<{
    finish(): Promise<Map<string, PublicSubjectPageCandidate | null>>;
}>;
/** Current anonymous navigation data, never publication, permission, ordering or custody authority. */
export declare function readPublicSubjectPageCandidates(deps: SummaryReaderDependencies, subjectIds: readonly string[]): Promise<Map<string, PublicSubjectPageCandidate | null>>;
