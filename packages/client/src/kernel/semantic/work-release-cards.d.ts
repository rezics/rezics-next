import { type SubjectSummary } from './summaries.ts';
import { type Statement } from './item.ts';
import type { WorkReleaseCardsInput } from './copy-work-reader-port.ts';
import { workReleaseCardProperties } from './copy-work-reader-port.ts';
export { workReleaseCardFieldLimit, workReleaseCardLimit, workReleaseCardProperties, workReleaseCardQualifierLimit, workReleaseCardReferenceLimit, workReleaseCardReferencePartLimit, workReleaseCardResponseBytes, workReleaseCardStatementBytes, } from './copy-work-reader-port.ts';
export type WorkReleaseCardField = {
    state: 'unsupported' | 'withheld' | 'missing' | 'unavailable';
} | {
    state: 'available';
    statements: Statement[];
    related: Record<string, SubjectSummary>;
};
export type WorkReleaseCard = {
    subject: string;
    type: string;
    summary: SubjectSummary;
    membership: Statement;
    related: Record<string, SubjectSummary>;
    fields: Record<(typeof workReleaseCardProperties)[number], WorkReleaseCardField>;
};
export type WorkReleaseCards = {
    state: 'unavailable';
} | {
    state: 'available';
    cards: WorkReleaseCard[];
};
/** Read only the finite selected facts used by public release comparison cards for the supplied page. */
export declare function readNativeWorkReleaseCards(input: WorkReleaseCardsInput): Promise<WorkReleaseCards>;
export { readWorkReleaseCards } from './copy-work-application.ts';
