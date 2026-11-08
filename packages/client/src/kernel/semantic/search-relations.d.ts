import { type ConceptStatementReader } from '../search/concept-browse-statements.ts';
import type { ConceptBrowseBinding, ConceptBrowseSource, ConceptDescendantSelection } from '../search/concept-browse.ts';
import { type Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { type CompleteWorkLinkReservation, type NativeWorkLinkValue, type IndexedStatement, type RelationFacetMatch, type RelationFacetProbe, type RetainedRelationFacetPage } from '../search/source.ts';
import { activeRelease } from './definition-release-read.ts';
export type SelectedStatement = {
    route: number;
    subject_id: string;
    slot_id: string;
    candidate_id: string;
    property: string;
    rank: 'normal' | 'preferred';
    ordinal: number;
    revision: number;
    body: unknown;
    release: string;
    source: unknown;
    relation: boolean;
    eligible: boolean | null;
};
/** Conservative native allowance reserved before each hierarchy observation or seek. */
export type ConceptBrowseNativeReservation = Readonly<{
    keys: number;
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    emptySeeks: number;
}>;
export type ConceptBrowseNativeReserve = (reservation: ConceptBrowseNativeReservation) => void;
type SourceSubject = {
    id: string;
    route: number;
    type: string;
    visibility: string;
    redirect: string | null;
    currentRelease: string | null;
    securityRevision: string;
    current_revision: number | null;
    selection_ready: boolean;
};
type Prepared = {
    partition: number;
    runtime: Awaited<ReturnType<typeof activeRelease>>;
    rows: SelectedStatement[];
    releases: Map<string, Release | null>;
    subjects: {
        subject: SourceSubject;
        properties: string[];
    }[];
};
/** A raw key budget bounds rejects as well as published rows. No permission survives a call. */
export declare function relationSource(pool: Pool, routeKey?: Uint8Array): {
    readConceptStatements: ConceptStatementReader;
    prepare(client: PoolClient, subjects: readonly SourceSubject[], releases: ReadonlyMap<string, Release>, partition: number): Promise<Prepared>;
    finish(prepared: Prepared): Promise<Map<string, {
        statements: IndexedStatement[];
        overflow: string[];
    }>>;
    readCompleteWorkLinks(partition: number, submittedIds: readonly string[], options?: Readonly<{
        reserve?: (reservation: CompleteWorkLinkReservation) => void;
    }>): Promise<Map<any, {
        complete: boolean;
        values: NativeWorkLinkValue[];
    }> | Map<string, Readonly<{
        complete: boolean;
        values: readonly NativeWorkLinkValue[];
    }>>>;
    match(partition: number, probes: readonly RelationFacetProbe[]): Promise<RelationFacetMatch[]>;
    preparePage(input: readonly RelationFacetProbe[]): Promise<RetainedRelationFacetPage>;
    conceptBrowse: (selection: ConceptDescendantSelection, identity: Pick<ConceptBrowseBinding, 'principal' | 'request'>, reserve?: ConceptBrowseNativeReserve) => ConceptBrowseSource;
};
export {};
