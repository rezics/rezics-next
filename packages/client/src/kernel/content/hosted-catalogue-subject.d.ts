import type { AnchoredPosition, ReadContext } from './model.ts';
import { type HostedDependencies } from './hosted-chapters-model.ts';
import { type HostedSubjectCataloguePage, type HostedSubjectCatalogueQuery } from './hosted-catalogue-subject-model.ts';
export type { HostedSubjectCatalogueItem, HostedSubjectCataloguePage, HostedSubjectCatalogueQuery, HostedSubjectCatalogueRow, } from './hosted-catalogue-subject-model.ts';
export { hostedSubjectPageLimit, isCurrentPublicCatalogueCandidate } from './hosted-catalogue-subject-model.ts';
export { hostedSubjectCursorBinding } from './hosted-catalogue-subject-cursor.ts';
/** Bounded current public hosted catalogues associated with an existing Subject.
 * Candidates come from indexed subject_thread rows and same-route published catalogue-post
 * subject references. TOC withdrawal (empty publication) removes a catalogue from this page.
 * Concealed rows consume a slot and are not refilled. */
export declare function listHostedCataloguesForSubject(deps: HostedDependencies, subjectId: string, query: HostedSubjectCatalogueQuery, context: ReadContext): Promise<{
    value: HostedSubjectCataloguePage;
    anchors: AnchoredPosition[];
}>;
export declare const HOSTED_SUBJECT_PAGE_LIMIT = 20;
