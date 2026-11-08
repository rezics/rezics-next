import { type CommandAuthorization } from '../command/command.ts';
import { type Access } from './check.ts';
import { type GrantCommandContext } from './grant-command.ts';
import type { ParentAnchor } from './parent-creation.ts';
/** Narrow, one-time trusted setup. The owning module supplies the real parent
 * port and an already validated, parent-bound command authority from its initial
 * setup workflow. These are service capabilities, never request JSON/env flags.
 * Delegated actions are additionally checked through Access; normal owner
 * administration uses createGrantCommands, including subsequent revocation.
 * The durable marker prevents reinstall even after grants are removed. The fixed
 * receipt replays setup atomically without acquiring continuing bootstrap power.
 */
export declare function installStandingParentGrant(input: {
    access: Access;
    parent: ParentAnchor;
    authority: CommandAuthorization;
    context: GrantCommandContext;
    actions: readonly string[];
}): Promise<import("../command/command.ts").CommandOutcome<{
    resource: Readonly<{
        route: number;
        id: string;
        authenticatedBenefit?: import("./authenticated-benefit.ts").ContentEditionBenefit;
        eligibility?: import("./eligibility.ts").ResourceEligibility;
        anonymousEligibility?: import("./eligibility.ts").ResourceEligibility;
    }>;
    actions: string[];
}>>;
