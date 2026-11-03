import type { FilterDocument } from '@rezics/filter';
import type { ConditionIssue } from './condition-editor-model';

export type RequestResourceKind = 'collection' | 'realm';
export type RequestResourceLeaf =
  | { readonly collection: { readonly id: string } }
  | { readonly realm: { readonly id: string } };
export type RequestResourceLabel = {
  kind: RequestResourceKind;
  id: string;
  labels: Record<string, string>;
};
export type RequestResourceInput = { labels?: readonly RequestResourceLabel[] };

const resourceKinds = new Set<RequestResourceKind>(['collection', 'realm']);
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SavedReference = { id: string; pointer: string };
export type RequestResourceShadow = {
  condition: FilterDocument;
  issues: ConditionIssue[];
  ownerPointers: string[];
  saved: SavedReference[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(value: object, key: string): { found: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? { found: true, value: descriptor.value }
    : { found: false, value: undefined };
}

function pointerPart(value: string | number) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPointer(pointer: string, key: string | number) {
  return `${pointer}/${pointerPart(key)}`;
}

function issue(issues: ConditionIssue[], pointer: string, code: string) {
  issues.push({ pointer, code });
}

/** Request resources are shadowed only for shared structural admission; the authored value stays untouched. */
export function requestResourceAdmissionShadow(condition: FilterDocument): RequestResourceShadow {
  const issues: ConditionIssue[] = [];
  const ownerPointers: string[] = [];
  const saved: SavedReference[] = [];
  const ancestors = new Set<object>();

  const visit = (node: unknown, pointer: string): unknown => {
    if (!isRecord(node) || ancestors.has(node)) return node;
    ancestors.add(node);
    const keys = Object.getOwnPropertyNames(node);

    if (keys.length === 1 && resourceKinds.has(keys[0] as RequestResourceKind)) {
      const kind = keys[0] as RequestResourceKind;
      const selectorPointer = childPointer(pointer, kind);
      const selector = own(node, kind).value;
      if (!isRecord(selector)) {
        issue(issues, selectorPointer, 'invalid_type');
      } else {
        for (const key of Object.getOwnPropertyNames(selector))
          if (key !== 'id') issue(issues, childPointer(selectorPointer, key), 'unknown_field');
        const idPointer = childPointer(selectorPointer, 'id');
        const id = own(selector, 'id');
        if (!id.found) issue(issues, idPointer, 'required');
        else if (typeof id.value !== 'string') issue(issues, idPointer, 'invalid_type');
        else if (!requestResourceIsCanonicalId(id.value)) issue(issues, idPointer, 'invalid_format');
      }
      ancestors.delete(node);
      return { owner: { presence: true } };
    }

    if (keys.length === 1 && keys[0] === 'owner') ownerPointers.push(childPointer(pointer, 'owner'));
    if (keys.length === 1 && keys[0] === 'saved') {
      const reference = own(node, 'saved');
      if (reference.found && typeof reference.value === 'string') saved.push({ id: reference.value, pointer });
    }

    if (keys.length === 1 && (keys[0] === 'and' || keys[0] === 'or')) {
      const operator = keys[0];
      const children = own(node, operator).value;
      if (Array.isArray(children)) {
        const updated = children.map((child, index) => visit(child, childPointer(childPointer(pointer, operator), index)));
        ancestors.delete(node);
        return { [operator]: updated };
      }
    }
    if (keys.length === 1 && keys[0] === 'not') {
      const child = visit(own(node, 'not').value, childPointer(pointer, 'not'));
      ancestors.delete(node);
      return { not: child };
    }

    ancestors.delete(node);
    return node;
  };

  return {
    condition: visit(condition, '/and/0') as FilterDocument,
    issues,
    ownerPointers,
    saved,
  };
}

export function requestResourceKind(value: unknown): RequestResourceKind | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.getOwnPropertyNames(value);
  return keys.length === 1 && resourceKinds.has(keys[0] as RequestResourceKind)
    ? (keys[0] as RequestResourceKind)
    : undefined;
}

export function requestResourceId(value: unknown, kind: RequestResourceKind): string | undefined {
  if (!isRecord(value)) return undefined;
  const selector = own(value, kind);
  if (!selector.found || !isRecord(selector.value)) return undefined;
  const id = own(selector.value, 'id');
  return id.found && typeof id.value === 'string' ? id.value : undefined;
}

export function requestResourceIsCanonicalId(id: string) {
  return canonicalUuid.test(id);
}
