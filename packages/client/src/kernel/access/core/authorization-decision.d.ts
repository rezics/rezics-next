import { type AccessDecision } from '../contract/index.ts';
import type { ResourceAuthorizationFacts } from '../contract/index.ts';
export declare function decideResourceAuthorization(facts: ResourceAuthorizationFacts): AccessDecision;
export declare function authorizationAllows(decision: AccessDecision): boolean;
