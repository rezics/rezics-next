import type { CredentialEffectBinding } from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type CommandOutcome } from '../command/command.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type Access, type Actor, type ActionCatalogue } from '../request/access.ts';
import type { LifecycleRequest, OpeningManagement } from './lifecycle.ts';
export declare const OPERATOR_RECEIPT_TTL_MS = 60000;
export declare class OperatorDeniedError extends Error {
    readonly status = 403;
    constructor();
}
/** The management decision installed with the operator commands built on this Access, if any. */
export declare function openingManagement(access: Access): OpeningManagement | undefined;
export type OperatorPurpose = 'session' | 'credential-management';
export type OperatorResponsibility = {
    operatorAccountId: string;
    subjectAccountId: string;
    reservationId: string;
};
export type OperatorRelation = OperatorResponsibility & {
    version: string;
};
export type OperatorOpening = OperatorRelation & {
    receiptId: string;
    actingHumanId: string;
    purpose: OperatorPurpose;
    clientId: string;
    scopes: string[];
    requestedBy: string | null;
    expiresAt: string;
};
export type OperatorConfig = {
    pool: Pool;
    access: Access;
    /** The mounted kernel catalogue, not an Access-maintained action registry. */
    actions: ActionCatalogue;
    /** Registered colon-form account/access permission protecting the operator resource. */
    managementAction: string;
    /** Trusted kernel clock; defaults to the clock installed on Access. */
    clock?: KernelClock;
    /** Trusted shared token keys; required only for responsibility pages. */
    cursorKeys?: KeyRing;
};
/** Internal trusted application boundary, deliberately absent from public routes.
 * Each mutation runs the kernel executor on exactly one account anchor. No body
 * accepts actorId, clientId, scopes, authorization booleans or serialized evidence.
 * The coordinator supplies kernel-verified context to approval AND consumption.
 * Auth may issue for value.subjectAccountId only after successful consumption.
 */
export declare function createOperatorCommands(config: OperatorConfig): {
    /** Committed mechanical work only. Lock relation and slot with the account,
     * then use the native fence mutation in that same subject transaction. */
    fenceOperatedSubject(input: OperatorResponsibility & {
        key: string;
    }): Promise<CommandOutcome<{
        accountId: string;
        fenced: boolean;
        receiptId: null;
    } | {
        accountId: string;
        fenced: boolean;
        receiptId: string;
    }>>;
    /** Explicit trusted registration/organization step. Not called by approval.
     * Owners exercise a normal owner-role grant, including ordinary denials and
     * client scope intersection. Revocation never gets repaired by a read path.
     */
    provisionManagementDefaults(input: {
        operatorAccountId: string;
        key: string;
    }): Promise<CommandOutcome<{
        operatorAccountId: string;
        action: string;
    }>>;
    /** Acquire before linking. Pending and live reservations are deliberately
     * indistinguishable; both indefinitely block deletion and automation through
     * lifecycle's existing guard. Membership/owner holds use that same guard.
     */
    reserveResponsibility(input: {
        operatorAccountId: string;
        subjectAccountId: string;
        key: string;
    }): Promise<CommandOutcome<{
        operatorAccountId: string;
        subjectAccountId: string;
        reservationId: string;
    }>>;
    /** Trusted coordinator step, including transfer. The new hold must already
     * exist; no command writes either operator partition. Old slot retirement is
     * atomic with the subject relation change. Resource grants are never touched.
     */
    recordOperatorRelation(input: OperatorResponsibility & {
        expectedOperatorAccountId: string | null;
        expectedVersion: string;
        key: string;
    }): Promise<CommandOutcome<{
        subjectAccountId: string;
        operatorAccountId: string;
        reservationId: string;
        version: string;
    }>>;
    /** Cancel a pending link, or confirm unlink/deletion, on the subject anchor.
     * A terminal slot makes a delayed link impossible. The coordinator must do
     * this BEFORE releasing the hold; absence of a relationship alone is unsafe.
     */
    retireResponsibility(input: OperatorResponsibility & {
        key: string;
    }): Promise<CommandOutcome<{
        operatorAccountId: string;
        subjectAccountId: string;
        reservationId: string;
    }>>;
    /** Release only from permanent subject-local terminal evidence, never an
     * eventually consistent reverse scan or a timeout. The read ends before
     * operator checkout. Terminal slots can never be reopened by these commands.
     */
    releaseResponsibility(input: OperatorResponsibility & {
        key: string;
    }): Promise<CommandOutcome<{
        operatorAccountId: string;
        subjectAccountId: string;
        reservationId: string;
    }>>;
    /** Bounded operator-local observation, including pending reservations; not relation authority.
     * Trusted composition supplies the authenticated viewer, never a request body's viewer id.
     */
    responsibilityPage: (input: {
        operatorAccountId: string;
        limit?: number;
        cursor?: string;
    }, viewer?: Actor) => Promise<{
        operators: {
            reservationId: string;
            subjectAccountId: string;
        }[];
        next: string | null;
    }>;
    /** Internal fanout work cursors stay on the seal and never reach a list reader. */
    responsibilityWorkPage: (input: {
        operatorAccountId: string;
        limit?: number;
        cursor?: string;
    }) => Promise<{
        operators: {
            reservationId: string;
            subjectAccountId: string;
        }[];
        next: string | null;
    }>;
    /** Advisory local eligibility. The actual lifecycle tombstone rechecks holds
     * with the locked account and database guard, atomically with deletion.
     */
    deletionEligibility(accountId: string): Promise<{
        accountId: string;
        safe: boolean;
    }>;
    /** Authorization replay returns the original receipt after checking current
     * authority. Only session issuance or the bound credential effect consumes it.
     */
    authorizeOpening(context: LifecycleRequest, input: {
        operatorAccountId: string;
        subjectAccountId: string;
        purpose: OperatorPurpose;
        key: string;
        credential?: CredentialEffectBinding;
    }): Promise<CommandOutcome<OperatorOpening>>;
    consumeOpening(context: LifecycleRequest, input: {
        operatorAccountId: string;
        subjectAccountId: string;
        receiptId: string;
        purpose: OperatorPurpose;
        key: string;
        credential?: CredentialEffectBinding;
    }): Promise<CommandOutcome<OperatorOpening>>;
};
