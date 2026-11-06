/** Live account authority for a private Collection. A token cached before suspension is not enough. */
import type { GrantedAccount, LibraryAccountActor } from '../contract/index.ts';
export declare function grantCapable(account: GrantedAccount, viewer: LibraryAccountActor): boolean;
