import type { Access, ActionCatalogue } from '../request/access.ts';
import defaults from './resource-roles.json';

/** Trusted composition-root data, never request JSON. Organization owner/member
 * membership roles are unrelated to these resource-local grant role identifiers.
 * Definitions must resolve entirely against mounted OpenAPI x-action metadata.
 */
export type ResourceRoleCatalogue = Readonly<{
  roles: Readonly<Record<string, readonly string[]>>;
  types: Readonly<Record<string, Readonly<{ owner?: string; standing: readonly string[] }>>>;
}>;
export type ResourceRoleTemplate = Readonly<{ owner?: string; standing: readonly string[] }>;
export type ResolvedResourceRoles = Readonly<{
  roles: ReadonlyMap<string, readonly string[]>;
  types: ReadonlyMap<string, ResourceRoleTemplate>;
}>;
const installed = new WeakMap<Access, ResolvedResourceRoles>();
const identifier = /^[a-z][a-z0-9_.-]*$/;
const actionName = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;

/** Copy and validate once per app. Predeclared, unmounted types remain unusable.
 * Extensions cannot replace a built-in definition, including the empty report
 * template. Missing roles/actions disable the whole referring template.
 */
export function resolveResourceRoles(
  actions: ActionCatalogue,
  extension?: ResourceRoleCatalogue,
): ResolvedResourceRoles {
  const definitions: Record<string, readonly string[]> = { ...defaults.roles };
  const templates: Record<string, ResourceRoleTemplate> = { ...defaults.types };
  for (const [role, values] of Object.entries(extension?.roles ?? {})) {
    if (Object.hasOwn(definitions, role)) throw new TypeError('Duplicate resource role definition');
    definitions[role] = values;
  }
  for (const [type, template] of Object.entries(extension?.types ?? {})) {
    if (Object.hasOwn(templates, type)) throw new TypeError('Duplicate resource type template');
    templates[type] = template;
  }
  const roles = new Map<string, readonly string[]>();
  for (const [role, values] of Object.entries(definitions)) {
    if (
      !identifier.test(role) ||
      !Array.isArray(values) ||
      !values.length ||
      values.some((action) => typeof action !== 'string' || !actionName.test(action) || !actions.has(action))
    )
      continue;
    roles.set(role, Object.freeze([...new Set(values)].sort()));
  }
  const types = new Map<string, ResourceRoleTemplate>();
  for (const [type, template] of Object.entries(templates)) {
    if (
      !identifier.test(type) ||
      !template ||
      !Array.isArray(template.standing) ||
      (template.owner !== undefined && !roles.has(template.owner)) ||
      template.standing.some((role) => !roles.has(role))
    )
      continue;
    types.set(
      type,
      Object.freeze({
        ...(template.owner === undefined ? {} : { owner: template.owner }),
        standing: Object.freeze([...new Set(template.standing)]),
      }),
    );
  }
  return { roles, types };
}
export function installResourceRoleCatalogue(access: Access, catalogue: ResolvedResourceRoles): void {
  installed.set(access, catalogue);
}
export function resourceRoleCatalogue(access: Access): ResolvedResourceRoles | undefined {
  return installed.get(access);
}
