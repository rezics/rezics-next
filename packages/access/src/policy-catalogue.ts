import {
  MAX_POLICY_ACTIONS,
  MAX_POLICY_ACTIONS_PER_RESOURCE_TYPE,
  MAX_POLICY_ACTION_TYPE_REFERENCES,
  MAX_POLICY_CATALOGUE_BYTES,
  MAX_POLICY_RESOURCE_TYPES,
  MAX_POLICY_ROLE_REFERENCES_PER_ACTION,
  MAX_POLICY_TYPE_ROLE_REFERENCES,
  type PolicyAction,
  type PolicyCatalogue,
  type PolicyCatalogueError,
  type PolicyCatalogueInput,
  type PolicyCatalogueResult,
  type PolicyResourceType,
  type PolicyRole,
} from './policy-contract.ts';

const ACTION = /^[a-z][a-z0-9_-]{0,62}:[a-z][a-z0-9_-]{0,62}$/;
const IDENTIFIER = /^[a-z][a-z0-9_.-]*$/;
const ACTION_FIELDS = ['action', 'anonymous', 'authority', 'resourceTypes', 'globalReach'];
const ROLE_FIELDS = ['role', 'actions'];
const TYPE_FIELDS = ['type', 'ownerRole', 'standingRoles'];

function record(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key !== 'string' || !fields.includes(key))) return undefined;
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
  }
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, maximum: number): unknown[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const own = Reflect.ownKeys(value);
  if (
    own.length !== value.length + 1 ||
    own.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
  )
    return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return undefined;
  }
  return value;
}

function sortedErrors(errors: PolicyCatalogueError[]): readonly PolicyCatalogueError[] {
  return Object.freeze(
    errors
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : left.index - right.index))
      .map((error) => Object.freeze(error)),
  );
}

/** Compile copied plain-data declarations before any policy fact is acquired. */
export function compilePolicyCatalogue(input: PolicyCatalogueInput): PolicyCatalogueResult {
  try {
    const root = record(input, ['actions', 'roles', 'resourceTypes']);
    if (!root) return { ok: false, errors: sortedErrors([{ code: 'invalid-input', index: 0 }]) };
    const rawActions = dataArray(root.actions, MAX_POLICY_ACTIONS);
    const rawRoles = dataArray(root.roles, MAX_POLICY_ACTIONS * MAX_POLICY_ROLE_REFERENCES_PER_ACTION);
    const rawTypes = dataArray(root.resourceTypes, MAX_POLICY_RESOURCE_TYPES);
    if (!rawActions || !rawRoles || !rawTypes) {
      const code =
        Array.isArray(root.actions) && root.actions.length > MAX_POLICY_ACTIONS
          ? 'too-many-actions'
          : Array.isArray(root.resourceTypes) && root.resourceTypes.length > MAX_POLICY_RESOURCE_TYPES
            ? 'too-many-resource-types'
            : Array.isArray(root.roles) &&
                root.roles.length > MAX_POLICY_ACTIONS * MAX_POLICY_ROLE_REFERENCES_PER_ACTION
              ? 'too-many-role-references'
              : 'invalid-input';
      return { ok: false, errors: sortedErrors([{ code, index: 0 }]) };
    }

    const errors: PolicyCatalogueError[] = [];
    let catalogueBytes = 0;
    const charge = (value: unknown, index: number): value is string => {
      if (typeof value !== 'string') return false;
      catalogueBytes += value.length + 1;
      if (catalogueBytes > MAX_POLICY_CATALOGUE_BYTES) {
        errors.push({ code: 'catalogue-too-large', index });
        return false;
      }
      return true;
    };

    const actions: PolicyAction[] = [];
    const actionNames = new Set<string>();
    const actionRoleCounts = new Map<string, number>();
    let actionTypeReferenceCount = 0;
    for (let index = 0; index < rawActions.length; index += 1) {
      const item = record(rawActions[index], ACTION_FIELDS);
      if (
        !item ||
        !charge(item.action, index) ||
        !ACTION.test(item.action) ||
        typeof item.anonymous !== 'boolean' ||
        typeof item.globalReach !== 'boolean'
      ) {
        errors.push({ code: 'invalid-action', index });
        continue;
      }
      if (item.authority !== 'resource' && item.authority !== 'own-account') {
        errors.push({ code: 'invalid-profile', index });
        continue;
      }
      const name = item.action;
      if (actionNames.has(name)) errors.push({ code: 'duplicate-action', index });
      actionNames.add(name);
      const resourceTypes = dataArray(
        item.resourceTypes,
        Math.min(MAX_POLICY_RESOURCE_TYPES, MAX_POLICY_ACTION_TYPE_REFERENCES - actionTypeReferenceCount),
      );
      if (!resourceTypes) {
        errors.push({ code: 'invalid-action', index });
        continue;
      }
      const copiedTypes: string[] = [];
      const seenTypes = new Set<string>();
      let valid = true;
      for (const resourceType of resourceTypes) {
        if (!charge(resourceType, index) || !IDENTIFIER.test(resourceType)) {
          valid = false;
          continue;
        }
        if (seenTypes.has(resourceType)) valid = false;
        seenTypes.add(resourceType);
        copiedTypes.push(resourceType);
        actionTypeReferenceCount += 1;
      }
      if (!valid) errors.push({ code: 'invalid-action', index });
      actions.push(
        Object.freeze({
          action: name,
          anonymous: item.anonymous,
          authority: item.authority,
          resourceTypes: Object.freeze([...new Set(copiedTypes)].sort()),
          globalReach: item.globalReach,
        }),
      );
    }

    const roles: PolicyRole[] = [];
    const roleNames = new Set<string>();
    let actionRoleReferenceCount = 0;
    for (let index = 0; index < rawRoles.length; index += 1) {
      const item = record(rawRoles[index], ROLE_FIELDS);
      if (!item || !charge(item.role, index) || !IDENTIFIER.test(item.role)) {
        errors.push({ code: 'invalid-role', index });
        continue;
      }
      const name = item.role;
      if (roleNames.has(name)) errors.push({ code: 'duplicate-role', index });
      roleNames.add(name);
      const roleActions = dataArray(
        item.actions,
        Math.min(MAX_POLICY_ACTIONS, MAX_POLICY_TYPE_ROLE_REFERENCES - actionRoleReferenceCount),
      );
      if (!roleActions || roleActions.length === 0) {
        errors.push({ code: 'invalid-role', index });
        continue;
      }
      const copiedActions: string[] = [];
      const seenActions = new Set<string>();
      for (const action of roleActions) {
        if (!charge(action, index) || !ACTION.test(action)) {
          errors.push({ code: 'invalid-role', index });
          continue;
        }
        if (seenActions.has(action)) errors.push({ code: 'invalid-role', index });
        seenActions.add(action);
        copiedActions.push(action);
        actionRoleCounts.set(action, (actionRoleCounts.get(action) ?? 0) + 1);
        actionRoleReferenceCount += 1;
      }
      roles.push(Object.freeze({ role: name, actions: Object.freeze([...new Set(copiedActions)].sort()) }));
    }

    for (let index = 0; index < roles.length; index += 1) {
      for (const action of roles[index]!.actions) {
        if (!actionNames.has(action)) errors.push({ code: 'unknown-role-action', index });
      }
    }
    for (const [action, count] of actionRoleCounts) {
      if (count > MAX_POLICY_ROLE_REFERENCES_PER_ACTION) {
        errors.push({
          code: 'too-many-role-references',
          index: Math.max(
            0,
            actions.findIndex((item) => item.action === action),
          ),
        });
      }
    }

    const resourceTypes: PolicyResourceType[] = [];
    const typeNames = new Set<string>();
    let typeRoleReferenceCount = 0;
    for (let index = 0; index < rawTypes.length; index += 1) {
      const item = record(rawTypes[index], TYPE_FIELDS);
      if (!item || !charge(item.type, index) || !IDENTIFIER.test(item.type)) {
        errors.push({ code: 'invalid-resource-type', index });
        continue;
      }
      const name = item.type;
      if (typeNames.has(name)) errors.push({ code: 'duplicate-resource-type', index });
      typeNames.add(name);
      const standingRoles = dataArray(
        item.standingRoles,
        Math.min(rawRoles.length, MAX_POLICY_TYPE_ROLE_REFERENCES - typeRoleReferenceCount),
      );
      const ownerRole = item.ownerRole;
      if (!standingRoles || (ownerRole !== undefined && (!charge(ownerRole, index) || !IDENTIFIER.test(ownerRole)))) {
        errors.push({ code: 'invalid-resource-type', index });
        continue;
      }
      const copiedStanding: string[] = [];
      const seenRoles = new Set<string>();
      for (const role of standingRoles) {
        if (!charge(role, index) || !IDENTIFIER.test(role)) {
          errors.push({ code: 'invalid-resource-type', index });
          continue;
        }
        if (seenRoles.has(role)) errors.push({ code: 'invalid-resource-type', index });
        seenRoles.add(role);
        copiedStanding.push(role);
        typeRoleReferenceCount += 1;
      }
      resourceTypes.push(
        Object.freeze({
          type: name,
          ...(typeof ownerRole === 'string' ? { ownerRole } : {}),
          standingRoles: Object.freeze([...new Set(copiedStanding)].sort()),
        }),
      );
    }

    for (let index = 0; index < actions.length; index += 1) {
      for (const type of actions[index]!.resourceTypes) {
        if (!typeNames.has(type)) errors.push({ code: 'unknown-resource-action', index });
      }
    }
    for (const type of resourceTypes) {
      const count = actions.reduce((total, action) => total + Number(action.resourceTypes.includes(type.type)), 0);
      if (count > MAX_POLICY_ACTIONS_PER_RESOURCE_TYPE) {
        errors.push({ code: 'too-many-actions', index: Math.max(0, resourceTypes.indexOf(type)) });
      }
    }
    for (let index = 0; index < resourceTypes.length; index += 1) {
      const type = resourceTypes[index]!;
      if (type.ownerRole && !roleNames.has(type.ownerRole)) errors.push({ code: 'unknown-owner-role', index });
      for (const role of type.standingRoles) {
        if (!roleNames.has(role)) errors.push({ code: 'unknown-standing-role', index });
      }
    }

    if (errors.length > 0) return { ok: false, errors: sortedErrors(errors) };
    const sortedActions = Object.freeze(
      [...actions].sort((left, right) => (left.action < right.action ? -1 : left.action > right.action ? 1 : 0)),
    );
    const sortedRoles = Object.freeze(
      [...roles].sort((left, right) => (left.role < right.role ? -1 : left.role > right.role ? 1 : 0)),
    );
    const sortedTypes = Object.freeze(
      [...resourceTypes].sort((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0)),
    );
    const actionByName: Record<string, PolicyAction> = Object.create(null);
    const roleByName: Record<string, PolicyRole> = Object.create(null);
    const resourceTypeByName: Record<string, PolicyResourceType> = Object.create(null);
    for (const item of sortedActions) actionByName[item.action] = item;
    for (const item of sortedRoles) roleByName[item.role] = item;
    for (const item of sortedTypes) resourceTypeByName[item.type] = item;
    return {
      ok: true,
      catalogue: Object.freeze({
        actions: sortedActions,
        roles: sortedRoles,
        resourceTypes: sortedTypes,
        actionByName: Object.freeze(actionByName),
        roleByName: Object.freeze(roleByName),
        resourceTypeByName: Object.freeze(resourceTypeByName),
      }),
    };
  } catch {
    return { ok: false, errors: sortedErrors([{ code: 'invalid-input', index: 0 }]) };
  }
}
