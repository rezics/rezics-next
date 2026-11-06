import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { CommunityPresentation } from './community-presentation-model.ts';
export type RulesReference = Readonly<{
    postId: string;
    revisionId: string;
}>;
export type PresentedRules = Extract<CommunityPresentation['rules'], {
    state: 'available';
}>['value'];
export declare const rulesKey: (ref: RulesReference, realmId: string) => string;
/** No injected success proof: the existing Content native read formula owns every source check. */
export declare function prepareRealmRulesSelection(deps: Readonly<{
    pool: Pool;
    access: Access;
    clock: () => Date;
}>, actor: Actor, realmId: string, reference: RulesReference, context: {
    deadline: number;
}): Promise<void>;
