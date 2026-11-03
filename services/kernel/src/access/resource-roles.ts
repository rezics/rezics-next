import type { Access, ActionCatalogue, ActionMetadata } from '../request/access.ts';
import { accessRoot } from './derived-access.ts';
import defaults from './resource-roles.json';
import governance from './platform-governance.json';

/** Trusted composition-root data, never request JSON. Organization owner/member
 * membership roles are unrelated to these resource-local grant role identifiers.
 * Arbitrary definitions must resolve entirely against supported action metadata.
 * The reserved governance role is composed from explicit platform action data.
 */
export type ResourceRoleCatalogue = Readonly<{
  roles: Readonly<Record<string, readonly string[]>>;
  types: Readonly<Record<string, Readonly<{ owner?: string; standing: readonly string[] }>>>;
}>;
export type ResourceRoleTemplate = Readonly<{ owner?: string; standing: readonly string[] }>;
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
// Function declarations stay callable during circular Access composition; module
// consts remain uninitialized while http/request loads this file.
function isRoleIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_.-]*$/.test(value);
}
function isActionName(value: string): boolean {
  return /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(value);
}
function resourceRoleInstalled(): WeakMap<Access, ResolvedResourceRoles> {
  const holder = resourceRoleInstalled as typeof resourceRoleInstalled & {
    map?: WeakMap<Access, ResolvedResourceRoles>;
  };
  return (holder.map ??= new WeakMap());
}
// Role compilation uses mounted names and creation declarations only. Anonymous
// admission remains owned by the full ActionCatalogue in the Access evaluator.
type RoleActions = ReadonlyMap<string, Partial<ActionMetadata>>;

type CompiledResourceRoles = {
  roles: Map<string, readonly string[]>;
  types: Map<string, ResourceRoleTemplate>;
  templates: Readonly<Record<string, ResourceRoleTemplate>>;
  dropped: ReadonlyMap<string, readonly string[]>;
  declaredTypes: ReadonlyMap<string, readonly string[]>;
};

function unmountedActions(actions: RoleActions, values: unknown): readonly string[] {
  if (!Array.isArray(values)) return [];
  const missing = new Set<string>();
  for (const action of values) {
    if (typeof action !== 'string' || !isActionName(action) || !actions.has(action)) {
      if (typeof action === 'string') missing.add(action);
    }
  }
  return [...missing].sort();
}

function roleResolves(actions: RoleActions, role: string, values: unknown): values is readonly string[] {
  return (
    isRoleIdentifier(role) &&
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((action) => typeof action === 'string' && isActionName(action) && actions.has(action))
  );
}

function declaredResourceTypes(actions: RoleActions): ReadonlyMap<string, readonly string[]> {
  const declared = new Map<string, readonly string[]>();
  for (const [action, metadata] of actions) {
    const types = metadata['x-resource-types'];
    if (types === undefined) continue;
    if (
      !Array.isArray(types) ||
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !isRoleIdentifier(type)) ||
      new Set(types).size !== types.length
    )
      throw new TypeError(`${action} declares invalid resource types`);
    declared.set(action, Object.freeze([...types]));
  }
  return declared;
}

/** Shared drop rules for resolution and the composition explanation. */
function compileResourceRoles(actions: RoleActions, extension?: ResourceRoleCatalogue): CompiledResourceRoles {
  if (
    !Array.isArray(governance.globalReach) ||
    governance.globalReach.some((action) => !governance.actions.includes(action))
  )
    throw new TypeError('Global governance reach must be held by the platform.governance role');
  const definitions: Record<string, readonly string[]> = {
    ...defaults.roles,
    // Only this reserved built-in role is composed from mounted platform gates.
    // Arbitrary roles still require every declared action to be mounted below.
    [governance.role]: governance.actions.filter((action) => actions.has(action)),
  };
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
  const dropped = new Map<string, readonly string[]>();
  for (const [role, values] of Object.entries(definitions)) {
    if (!roleResolves(actions, role, values)) {
      if (isRoleIdentifier(role)) dropped.set(role, unmountedActions(actions, values));
      continue;
    }
    roles.set(role, Object.freeze([...new Set(values)].sort()));
  }
  const types = new Map<string, ResourceRoleTemplate>();
  for (const [type, template] of Object.entries(templates)) {
    if (
      !isRoleIdentifier(type) ||
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
  return { roles, types, templates, dropped, declaredTypes: declaredResourceTypes(actions) };
}

/** Copy and validate once per app. Predeclared, unmounted types remain unusable.
 * Extensions cannot replace a built-in definition, including the empty report
 * template. Missing roles/actions disable the whole referring template.
 */
export function resolveResourceRoles(actions: RoleActions, extension?: ResourceRoleCatalogue): ResolvedResourceRoles {
  const compiled = compileResourceRoles(actions, extension);
  return { roles: compiled.roles, types: compiled.types, declaredTypes: compiled.declaredTypes };
}

/** Names why a type did not resolve. Undefined means the same rules kept the type. */
export function explainUnresolvedResourceType(
  actions: RoleActions,
  type: string,
  extension?: ResourceRoleCatalogue,
): UnresolvedResourceType | undefined {
  const compiled = compileResourceRoles(actions, extension);
  if (compiled.types.has(type)) return undefined;
  const template = compiled.templates[type];
  const referenced: string[] = [];
  if (template && Array.isArray(template.standing)) {
    if (typeof template.owner === 'string') referenced.push(template.owner);
    for (const role of template.standing) if (typeof role === 'string') referenced.push(role);
  }
  const missingRoles = [...new Set(referenced.filter((role) => !compiled.roles.has(role)))];
  const unmounted = [...new Set(missingRoles.flatMap((role) => compiled.dropped.get(role) ?? []))].sort();
  return { type, missingRoles, unmountedActions: unmounted };
}

/** Refuses composition when a mounted command declares a resource type that does not resolve. */
export function assertDeclaredResourceTypes(
  _app: object,
  extension: ResourceRoleCatalogue | undefined,
  actions: ActionCatalogue,
): void {
  const declared = new Set<string>();
  for (const metadata of actions.values()) {
    for (const type of metadata['x-resource-types'] ?? []) declared.add(type);
  }
  const failures: string[] = [];
  for (const type of [...declared].sort()) {
    const unresolved = explainUnresolvedResourceType(actions, type, extension);
    if (!unresolved) continue;
    failures.push(
      `Resource type ${unresolved.type} does not resolve: missing roles ${unresolved.missingRoles.join(', ')}; unmounted actions ${unresolved.unmountedActions.join(', ')}`,
    );
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
}

export function installResourceRoleCatalogue(access: Access, catalogue: ResolvedResourceRoles): void {
  const root = accessRoot(access);
  const previous = resourceRoleInstalled().get(root)?.declaredTypes;
  if (catalogue.declaredTypes !== undefined || previous === undefined) {
    resourceRoleInstalled().set(root, catalogue);
    return;
  }
  resourceRoleInstalled().set(root, { roles: catalogue.roles, types: catalogue.types, declaredTypes: previous });
}
export function resourceRoleCatalogue(access: Access): ResolvedResourceRoles | undefined {
  return resourceRoleInstalled().get(accessRoot(access));
}
