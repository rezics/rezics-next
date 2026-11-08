/** Search preparation adapter. Composition supplies Search; this file imports none of it. */
import type { PreparedSearchScope, SearchFilterLeafKind, SearchPreparationCapability } from '../contract/index.ts';
export type SearchPreparationAdapterPorts = Readonly<{
    prepareScope: SearchPreparationCapability['prepareScope'];
    filterLeaves(filter: unknown): readonly SearchFilterLeafKind[];
}>;
export declare function createSearchPreparationAdapter(ports?: SearchPreparationAdapterPorts): SearchPreparationCapability;
export type { PreparedSearchScope };
