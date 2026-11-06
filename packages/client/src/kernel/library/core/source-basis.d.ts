/** Source observation comparison and private-working versus activated-public classification. */
import type { CollectionSourceAuthority, CollectionSourceObservation } from '../contract/index.ts';
export declare function sameSource(left: CollectionSourceObservation, right: CollectionSourceObservation): boolean;
export declare function isPrivateWorkingAuthority(authority: CollectionSourceAuthority): boolean;
export declare function isActivatedPublicAuthority(authority: CollectionSourceAuthority): boolean;
export declare function classifySourceOutput(observation: CollectionSourceObservation): 'private_working' | 'activated_public' | 'frozen';
