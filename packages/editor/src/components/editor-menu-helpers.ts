import type { Editor } from '@tiptap/core';

export const bubbleOptions = { placement: 'top' as const, offset: 8, flip: true, shift: { padding: 8 }, inline: true };
export const pressedTone = 'aria-pressed:bg-primary/10 aria-pressed:text-primary';

/** A deferred return never steals focus from a control chosen after dismissal. */
export const returnFocus =
  (editor: Editor, isCurrent: () => boolean = () => true) =>
  () => {
    if (!isCurrent() || editor.isDestroyed || !editor.isEditable) return false;
    const document = editor.view.dom.ownerDocument;
    const owner = document.activeElement;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        isCurrent() &&
        !editor.isDestroyed &&
        editor.isEditable &&
        (active === owner || active === document.body || editor.view.dom.contains(active))
      )
        editor.view.focus();
    });
    return false;
  };
