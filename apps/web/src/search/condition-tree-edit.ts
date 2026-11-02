import { FILTER_LIMITS, type FilterDocument } from '@rezics/filter';

export type ConditionTreePath = readonly (number | 'and' | 'or' | 'not')[];
export type ConditionTreeEdit =
  | { type: 'operator'; operator: 'and' | 'or' | 'not' }
  | { type: 'unwrap' }
  | { type: 'append'; value: FilterDocument }
  | { type: 'replace'; value: FilterDocument }
  | { type: 'remove' };
export type ConditionTreeEditResult = { accepted: true; value: FilterDocument | undefined } | { accepted: false };

const rejected = Symbol('rejected');
type EditValue = FilterDocument | undefined | typeof rejected;

function updateAt(
  value: FilterDocument,
  path: ConditionTreePath,
  update: (current: FilterDocument) => EditValue,
): EditValue {
  if (path.length === 0) return update(value);

  if ('and' in value || 'or' in value) {
    const operator = 'and' in value ? 'and' : 'or';
    const children: readonly FilterDocument[] = 'and' in value ? value.and : value.or;
    const [group, index, ...rest] = path;
    if (
      group !== operator ||
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= children.length
    )
      return rejected;
    const next = updateAt(children[index]!, rest, update);
    if (next === rejected) return rejected;
    const updated =
      next === undefined
        ? children.filter((_, at) => at !== index)
        : children.map((child, at) => (at === index ? next : child));
    return operator === 'and' ? { and: updated } : { or: updated };
  }

  if ('not' in value) {
    if (path[0] !== 'not') return rejected;
    const next = updateAt(value.not, path.slice(1), update);
    return next === rejected ? rejected : next === undefined ? undefined : { not: next };
  }

  return rejected;
}

function withinStructuralLimits(value: FilterDocument | undefined): boolean {
  let leaves = 0;

  const visit = (node: FilterDocument, depth: number, underNot: boolean): boolean => {
    if ('and' in node || 'or' in node) {
      const operator = 'and' in node ? 'and' : 'or';
      const children: readonly FilterDocument[] = 'and' in node ? node.and : node.or;
      if (depth >= FILTER_LIMITS.depth || (operator === 'or' && children.length > FILTER_LIMITS.or)) return false;
      return children.every((child) => visit(child, depth + 1, false));
    }
    if ('not' in node) {
      if (underNot || depth >= FILTER_LIMITS.depth) return false;
      return visit(node.not, depth + 1, true);
    }
    leaves += 1;
    return leaves <= FILTER_LIMITS.leaves;
  };

  return value === undefined || visit(value, 1, false);
}

function containsEmptyGroup(value: FilterDocument): boolean {
  if ('and' in value || 'or' in value) {
    const children = 'and' in value ? value.and : value.or;
    return children.length === 0 || children.some(containsEmptyGroup);
  }
  return 'not' in value && containsEmptyGroup(value.not);
}

export function conditionTreeCanSubmit(value: FilterDocument | undefined): boolean {
  return value === undefined || (withinStructuralLimits(value) && !containsEmptyGroup(value));
}

export function editConditionTree(
  tree: FilterDocument,
  path: ConditionTreePath,
  edit: ConditionTreeEdit,
): ConditionTreeEditResult {
  const next = updateAt(tree, path, (current): EditValue => {
    if (edit.type === 'remove') return undefined;
    if (edit.type === 'unwrap') return 'not' in current ? current.not : rejected;
    if (edit.type === 'replace') return edit.value;
    if (edit.type === 'append') {
      if ('and' in current) return { and: [...current.and, edit.value] };
      if ('or' in current) return { or: [...current.or, edit.value] };
      return rejected;
    }
    if (edit.operator === 'not') return 'not' in current ? rejected : { not: current };
    const children = 'and' in current ? current.and : 'or' in current ? current.or : [current];
    return edit.operator === 'and' ? { and: children } : { or: children };
  });
  if (next === rejected || !withinStructuralLimits(next)) return { accepted: false };
  return { accepted: true, value: next };
}
