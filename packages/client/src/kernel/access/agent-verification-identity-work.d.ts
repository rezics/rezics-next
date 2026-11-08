import { type AccessWorkDimensions } from './core/index.ts';
import { ACCOUNT_IDENTITY_FENCE_SQL } from './agent-verification-identity-literals.ts';
export type AccountIdentityWorkDeclaration = Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export { ACCOUNT_IDENTITY_FENCE_SQL };
/** Subject-only technical role inventory; LIMIT 2 refuses a widened payload. */
export declare const ACCOUNT_IDENTITY_TECHNICAL_ROLE_SQL = "SELECT role_account_id::text AS account_id,roles FROM access.agent_identity_technical_role\n     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4\n     ORDER BY role_account_id LIMIT 2 FOR SHARE";
export declare function ACCOUNT_IDENTITY_FENCE_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export declare function ACCOUNT_IDENTITY_INTENT_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export declare function ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export declare function ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION(): import("./contract/bounds.ts").AccessWorkDeclaration;
export declare function ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** Technical fallback: receiver + accepted binding + role inventory. Three statements. */
export declare function ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** One original-home reader body. Fence + intent + technical fallback; Core stays outside. */
export declare function ACCOUNT_IDENTITY_SOURCE_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** Source disposition names this getter; it is the same reader body, not a second price. */
export declare const ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION: typeof ACCOUNT_IDENTITY_SOURCE_DECLARATION;
/** Admission repeats the reader body at original/prepare/checkpoint/finish; Core debits once. */
export declare function ACCOUNT_IDENTITY_SOURCE_ADMISSION_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export declare function ACCOUNT_IDENTITY_SETTLEMENT_SELECT_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
export declare function ACCOUNT_IDENTITY_RETAINED_REFERENCE_DECLARATION(): import("./contract/bounds.ts").AccessWorkDeclaration;
export declare function ACCOUNT_IDENTITY_OBLIGATION_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** One receipt's technical + bound + receiver recheck walk inside settlementFor. */
export declare function ACCOUNT_IDENTITY_SETTLEMENT_RECEIPT_WALK_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** Read runs settlementFor under the selected Core no-effect profile. */
export declare function ACCOUNT_IDENTITY_REVERSAL_READ_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** Verify re-locks settlementFor inside the live command; Core is not charged again. */
export declare function ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION(): Readonly<{
    work: AccessWorkDimensions;
    engineRequests: 0;
}>;
/** Source disposition names this getter; it is settlementFor, not a second walk. */
export declare const ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION: typeof ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION;
export declare function accountIdentityNativeStep(work: AccessWorkDimensions): Readonly<{
    rows: number;
    points: number;
    statements: number;
    bytes: number;
    engineRequests: 0;
}>;
