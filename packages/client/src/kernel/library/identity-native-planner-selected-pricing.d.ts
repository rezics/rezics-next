import type { WorkDimensions } from './collection-source.ts';
type Query = {
    sql: string;
    params: readonly string[];
};
export declare const nativeIdentityPartitionQuery: Query;
export declare function isNativeIdentitySourceBasisSQL(sql: string): boolean;
/** Shared by actual native dispatch and static installed pricing. No runtime grant,
 * callback, ledger or executable owner module is loaded to construct this data.
 */
export declare function nativeIdentitySourceBasisFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export declare function declareNativeIdentitySourceBasisStatements(): readonly Readonly<{
    sql: string;
    work: WorkDimensions;
    engineRequests: 0;
}>[];
/** The selected native body literals; ordinary pages retain their <=100 bound.
 * Multiplicity and selected limit1 are enforced separately before dispatch.
 */
export declare function libraryIdentitySelectedFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
export {};
