import { CONDITION_POINTER } from './condition-editor-model';

export type ConditionErrorTarget = { kind: 'field' | 'group' | 'summary'; element: HTMLElement };

function pointerSegments(pointer: string): string[] | undefined {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  const segments = pointer.slice(1).split('/');
  if (segments.some((segment) => /~(?:[^01]|$)/.test(segment))) return undefined;
  return segments.map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isPrefix(prefix: readonly string[], path: readonly string[]) {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

function samePath(first: readonly string[] | undefined, second: readonly string[] | undefined) {
  return first !== undefined && second !== undefined && first.length === second.length && isPrefix(first, second);
}

function isVisible(element: HTMLElement, editor: HTMLElement) {
  if (!editor.contains(element)) return false;
  const closedDetails = element.closest('details:not([open])');
  if (closedDetails && !closedDetails.querySelector(':scope > summary')?.contains(element)) return false;

  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
    const style = current.ownerDocument.defaultView?.getComputedStyle(current);
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
    if (style?.opacity === '0' || style?.contentVisibility === 'hidden') return false;
  }
  return true;
}

function canFocus(element: HTMLElement, editor: HTMLElement) {
  return (
    isVisible(element, editor) &&
    !element.matches(':disabled') &&
    element.getAttribute('aria-disabled') !== 'true' &&
    !('readOnly' in element && (element as HTMLInputElement).readOnly)
  );
}

function fieldControl(field: HTMLElement, editor: HTMLElement) {
  return (
    Array.from(field.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, [contenteditable="true"]')).find(
      (control) => canFocus(control, editor),
    ) ?? undefined
  );
}

export function isConditionEditorPointer(pointer: string) {
  const path = pointerSegments(pointer);
  const condition = pointerSegments(CONDITION_POINTER);
  return path !== undefined && condition !== undefined && isPrefix(condition, path);
}

/** Resolve only within this editor, preferring an editable field and then the closest matching group. */
export function findConditionErrorTarget(editor: HTMLElement | null, pointer: string): ConditionErrorTarget | undefined {
  if (!editor?.matches('[data-condition-editor]')) return undefined;
  const path = pointerSegments(pointer);
  if (path) {
    const field = Array.from(editor.querySelectorAll<HTMLElement>('[data-condition-field-pointer]')).find((element) =>
      samePath(pointerSegments(element.dataset.conditionFieldPointer ?? ''), path),
    );
    const control = field && fieldControl(field, editor);
    if (control) return { kind: 'field', element: control };

    let nearest: { element: HTMLElement; depth: number } | undefined;
    for (const element of editor.querySelectorAll<HTMLElement>('[data-condition-pointer]')) {
      const candidate = pointerSegments(element.dataset.conditionPointer ?? '');
      if (candidate && isPrefix(candidate, path) && (!nearest || candidate.length > nearest.depth) && canFocus(element, editor)) {
        nearest = { element, depth: candidate.length };
      }
    }
    if (nearest) return { kind: 'group', element: nearest.element };
  }

  const summary = editor.querySelector<HTMLElement>('[data-condition-errors]');
  return summary && canFocus(summary, editor) ? { kind: 'summary', element: summary } : undefined;
}
