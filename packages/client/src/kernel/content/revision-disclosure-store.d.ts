import type { AccessClient } from '../request/access.ts';
import { type RevisionDisclosureCatalogue, type RevisionDisclosureIncarnation, type RevisionDisclosureObservation, type RevisionDisclosureRow, type RevisionDisclosureSource, type RevisionDisclosureTarget } from './revision-disclosure-model.ts';
export declare function revisionDisclosureDigest(value: unknown): string;
export declare function revisionDisclosureHex(bytes: Uint8Array): string;
export declare function sameRevisionDisclosureTarget(a: RevisionDisclosureTarget | null | undefined, b: RevisionDisclosureTarget): a is RevisionDisclosureTarget;
export declare function sameRevisionDisclosureIncarnation(a: RevisionDisclosureIncarnation | null | undefined, b: RevisionDisclosureIncarnation): a is RevisionDisclosureIncarnation;
export declare function sameRevisionDisclosureSource(a: RevisionDisclosureSource | null | undefined, b: RevisionDisclosureSource): a is RevisionDisclosureSource;
export declare function targetOf(row: RevisionDisclosureRow): RevisionDisclosureTarget;
export declare function catalogueOf(row: RevisionDisclosureRow): RevisionDisclosureCatalogue;
export declare function incarnationOf(row: RevisionDisclosureRow): RevisionDisclosureIncarnation;
export declare function sourceOf(row: RevisionDisclosureRow): RevisionDisclosureSource;
export declare function observationOf(row: RevisionDisclosureRow): RevisionDisclosureObservation;
export declare function sameRevisionDisclosureRow(a: RevisionDisclosureRow | null | undefined, b: RevisionDisclosureRow): a is RevisionDisclosureRow;
export declare function routedRevisionDisclosureId(id: string, expected?: number): number | null;
export declare function revisionDisclosureSourceHome(target: RevisionDisclosureTarget): number | null;
export declare function revisionDisclosureCatalogueHome(catalogueId: string): number | null;
type RevisionDisclosureSqlRow = {
    [K in keyof RevisionDisclosureRow]: K extends 'actor_scopes' ? readonly (string | null)[] : RevisionDisclosureRow[K];
};
/** Compiled SQL types `text[]` as `(string | null)[]`; stored scopes match AccountActor. */
export declare function revisionDisclosureFromSql(row: RevisionDisclosureSqlRow | null | undefined): RevisionDisclosureRow | null;
export declare function revisionDisclosureRow(client: AccessClient, disclosureId: string): Promise<RevisionDisclosureRow | null>;
export declare function lockRevisionDisclosureRow(client: AccessClient, disclosureId: string): Promise<RevisionDisclosureRow | null>;
export declare function lookupIssuedRevisionDisclosure(client: AccessClient, catalogueId: string, target: RevisionDisclosureTarget): Promise<RevisionDisclosureRow | null>;
export declare function revisionDisclosurePartition(route: number): number;
export {};
