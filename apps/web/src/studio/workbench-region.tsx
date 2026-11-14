import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';

/** Collapsing a region preserves its mounted command, confirmation and form owners. */
export function WorkbenchRegion({
  title,
  children,
  attention = false,
}: {
  title: string;
  children: ReactNode;
  /** An active review or unresolved command must remain visible until its owner settles it. */
  attention?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const open = attention || expanded;
  return (
    <section className="studio-workbench-region" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>
        <Button
          type="button"
          variant="ghost"
          className="studio-region-trigger"
          aria-expanded={open}
          aria-controls={`${id}-content`}
          onClick={() => setExpanded(!open)}
          disabled={attention}
        >
          {title}
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </Button>
      </h2>
      <div id={`${id}-content`} hidden={!open} className="studio-region-content studio-stack">
        {children}
      </div>
    </section>
  );
}

type AuthoringSelection = {
  generation: string;
  target: HTMLElement;
  text: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null;
  range: Range | null;
  backward: boolean;
};

/** DOM selection only: the shared editor remains the document and undo owner. */
export function useAuthoringSelection(canvas: RefObject<HTMLElement | null>, generation: string) {
  const saved = useRef<AuthoringSelection | null>(null);
  return {
    remember(target: HTMLElement) {
      if (
        (target instanceof window.HTMLInputElement && target.type === 'text') ||
        target instanceof window.HTMLTextAreaElement
      ) {
        saved.current = {
          generation,
          target,
          text: {
            start: target.selectionStart ?? 0,
            end: target.selectionEnd ?? 0,
            direction: target.selectionDirection ?? 'none',
          },
          range: null,
          backward: false,
        };
      } else if (target.isContentEditable || target.getAttribute('role') === 'textbox') {
        const selection = target.ownerDocument.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        saved.current = {
          generation,
          target,
          text: null,
          range,
          backward: Boolean(
            range &&
            !range.collapsed &&
            selection!.anchorNode === range.endContainer &&
            selection!.anchorOffset === range.endOffset,
          ),
        };
      }
    },
    restore() {
      const selection = saved.current;
      // Copying a saved version deliberately replaces the editor; its detached caret must not be restored.
      if (!selection || selection.generation !== generation) {
        canvas.current?.querySelector<HTMLElement>('[role="textbox"], input')?.focus({ preventScroll: true });
        return;
      }
      selection.target.focus({ preventScroll: true });
      if (selection.text) {
        (selection.target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
          selection.text.start,
          selection.text.end,
          selection.text.direction,
        );
      } else if (selection.range) {
        const current = selection.target.ownerDocument.getSelection()!;
        current.removeAllRanges();
        current.addRange(selection.range);
        if (selection.backward) {
          current.setBaseAndExtent(
            selection.range.endContainer,
            selection.range.endOffset,
            selection.range.startContainer,
            selection.range.startOffset,
          );
        }
      }
    },
  };
}
