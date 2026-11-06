import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { type SubjectSummary, type SummaryDependencies } from './summaries.ts';
import { type Statement } from './item.ts';
import type { SessionComponent } from '../tokens/session.ts';
export declare const workReleaseCardLimit = 20;
export declare const workReleaseCardFieldLimit = 32;
export declare const workReleaseCardProperties: readonly ['schema:gamePlatform', 'schema:inLanguage', 'schema:datePublished', 'schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus', 'schema:contentRating', 'schema:publisher', 'schema:producer', 'wdt:P178', 'wdt:P162', 'wdt:P2899'];
export declare const workReleaseCardQualifierLimit = 64;
export declare const workReleaseCardReferenceLimit = 32;
export declare const workReleaseCardReferencePartLimit = 64;
export declare const workReleaseCardStatementBytes: number;
export declare const workReleaseCardResponseBytes: number;
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
type MembershipLink = {
    subject: string;
    property: string;
    statement: string;
    assertion?: Statement;
    related?: Record<string, SubjectSummary>;
    summary?: SubjectSummary | null;
};
/** Read only the finite selected facts used by public release comparison cards for the supplied page. */
export declare function readWorkReleaseCards(input: {
    pool: Pool;
    routeKey: Uint8Array;
    subject: string;
    context?: string;
    defaults?: Readonly<Record<string, 'inherit' | 'suppress'>>;
    links: readonly MembershipLink[];
    caughtUp: boolean;
    release: Release;
    languages: readonly string[];
    deadline: number;
    seen: readonly SessionComponent[];
    authorizeSummary?: SummaryDependencies['authorize'];
}): Promise<WorkReleaseCards>;
export {};
