import type { GrantedAccount, LibraryAccountActor } from '../contract/index.ts';
/** The same current account fence applies to every logical built-in read. */
export declare function currentLibraryAccount(actor: LibraryAccountActor, current: GrantedAccount | null): boolean;
