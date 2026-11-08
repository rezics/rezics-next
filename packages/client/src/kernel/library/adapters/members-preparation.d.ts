/** Install the supplied native owner-filter implementation and reservation capability in one application. */
import type { LibraryDomain } from '../contract/index.ts';
import type { LibraryMembersPreparationRuntime } from '../domain.ts';
type Capabilities = Pick<LibraryDomain, 'authorization' | 'identityDisclosure' | 'searchPreparation' | 'memberPreparation'>;
/** Each caller supplies its current Pool/Access/work client; no registry is consulted by the app. */
export declare function createMembersPreparationAdapter(capabilities: Capabilities): LibraryMembersPreparationRuntime;
export {};
