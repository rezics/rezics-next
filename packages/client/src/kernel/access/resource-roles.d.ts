import type { Access, ActionCatalogue, ActionMetadata } from '../request/access.ts';
/** Trusted composition-root data, never request JSON. Organization owner/member
 * membership roles are unrelated to these resource-local grant role identifiers.
 * Arbitrary definitions must resolve entirely against supported action metadata.
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
    /** Action to the resource types that action's command declares. */
    declaredTypes?: ReadonlyMap<string, readonly string[]>;
}>;
export type UnresolvedResourceType = Readonly<{
    type: string;
    missingRoles: readonly string[];
    unmountedActions: readonly string[];
}>;
type RoleActions = ReadonlyMap<string, Partial<ActionMetadata>>;
/** Copy and validate once per app. Predeclared, unmounted types remain unusable.
 * Extensions cannot replace a built-in definition, including the empty report
 * template. Missing roles/actions disable the whole referring template.
 */
export declare function resolveResourceRoles(actions: RoleActions, extension?: ResourceRoleCatalogue): ResolvedResourceRoles;
/** Names why a type did not resolve. Undefined means the same rules kept the type. */
export declare function explainUnresolvedResourceType(actions: RoleActions, type: string, extension?: ResourceRoleCatalogue): UnresolvedResourceType | undefined;
/** Refuses composition when a mounted command declares a resource type that does not resolve. */
export declare function assertDeclaredResourceTypes(app: object, extension: ResourceRoleCatalogue | undefined, actions: ActionCatalogue): void;
export declare function installResourceRoleCatalogue(access: Access, catalogue: ResolvedResourceRoles): void;
export declare function resourceRoleCatalogue(access: Access): ResolvedResourceRoles | undefined;
export {};
