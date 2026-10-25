import type { Access, ActionCatalogue } from '../request/access.ts';
/** Trusted composition-root data, never request JSON. Organization owner/member
 * membership roles are unrelated to these resource-local grant role identifiers.
 * Arbitrary definitions must resolve entirely against mounted action metadata.
 * The reserved governance role is composed from explicit platform action data.
 */
export type ResourceRoleCatalogue = Readonly<{
    roles: Readonly<Record<string, readonly string[]>>;
    types: Readonly<Record<string, Readonly<{
        owner?: string;
        standing: readonly string[];
    }>>>;
}>;
export type ResourceRoleTemplate = Readonly<{
    owner?: string;
    standing: readonly string[];
}>;
export type ResolvedResourceRoles = Readonly<{
    roles: ReadonlyMap<string, readonly string[]>;
    types: ReadonlyMap<string, ResourceRoleTemplate>;
}>;
/** Copy and validate once per app. Predeclared, unmounted types remain unusable.
 * Extensions cannot replace a built-in definition, including the empty report
 * template. Missing roles/actions disable the whole referring template.
 */
export declare function resolveResourceRoles(actions: ActionCatalogue, extension?: ResourceRoleCatalogue): ResolvedResourceRoles;
export declare function installResourceRoleCatalogue(access: Access, catalogue: ResolvedResourceRoles): void;
export declare function resourceRoleCatalogue(access: Access): ResolvedResourceRoles | undefined;
