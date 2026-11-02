import { CONDITION_POINTER } from './condition-editor-model';
import type { ConditionDraftNode } from './condition-tree-edit';

const CONTROL_SELECTOR =
  'select:not(:disabled), input:not([type="hidden"]):not(:disabled), button:not(:disabled)';

export type ConditionEditFocusHost = {
  root(): HTMLElement | null;
  current(): boolean;
};

export type ConditionEditFocusTarget = {
  pointer: string;
  nodeKey?: number | undefined;
  source: EventTarget | null;
};

/** Walk the session draft tree; leaf remainders stay on the occurrence that owns them. */
export function conditionDraftNodeAt(
  node: ConditionDraftNode | undefined,
  pointer: string,
): ConditionDraftNode | undefined {
  if (!node) return;
  if (pointer === CONDITION_POINTER) return node;
  const prefix = `${CONDITION_POINTER}/`;
  if (!pointer.startsWith(prefix)) return;
  let current = node;
  const segments = pointer.slice(prefix.length).split('/');
  for (let index = 0; index < segments.length; ) {
    const operator = segments[index];
    if (operator === 'not') {
      if (current.operator !== 'not' || !current.children[0]) return;
      current = current.children[0];
      index += 1;
      continue;
    }
    if (operator === 'and' || operator === 'or') {
      const at = Number(segments[index + 1]);
      if (current.operator !== operator || !Number.isInteger(at) || !current.children[at]) return;
      current = current.children[at]!;
      index += 2;
      continue;
    }
    break;
  }
  return current;
}

export function conditionEditFocusRegion(
  editor: HTMLElement,
  pointer: string,
  nodeKey?: number | undefined,
): HTMLElement | undefined {
  const match = Array.from(editor.querySelectorAll<HTMLElement>('[data-condition-pointer]')).find(
    (element) => element.dataset.conditionPointer === pointer,
  );
  if (match) {
    if (nodeKey !== undefined && Number(match.dataset.conditionNode) !== nodeKey) return;
    return match;
  }
  return nodeKey === undefined ? editor : undefined;
}

/** Bind one queued recovery to the initiating action and the current editing session. */
export function createConditionEditFocus(host: ConditionEditFocusHost) {
  let token = 0;
  let frame = 0;

  const cancel = () => {
    token += 1;
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const recover = (target: ConditionEditFocusTarget) => {
    cancel();
    if (!host.current()) return;
    const scheduled = token;
    frame = requestAnimationFrame(() => {
      if (scheduled !== token) return;
      frame = 0;
      const editor = host.root();
      if (!editor || !host.current()) return;
      const ownerDocument = editor.ownerDocument;
      const active = ownerDocument.activeElement;
      if (active !== target.source && active !== ownerDocument.body && active !== ownerDocument.documentElement) return;
      conditionEditFocusRegion(editor, target.pointer, target.nodeKey)
        ?.querySelector<HTMLElement>(CONTROL_SELECTOR)
        ?.focus();
    });
  };

  return { recover, cancel };
}
