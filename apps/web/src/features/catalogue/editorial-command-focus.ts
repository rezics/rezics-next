import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';

/** Command orientation only; the editor's existing lifetime admits all work. */
export function useEditorialCommandFocus(active: () => boolean, busy: boolean) {
  const workspace = useRef<HTMLElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const keyboard = useRef(false);
  const [, settled] = useReducer((version: number) => version + 1, 0);
  const intent = useRef<
    | {
        opener: HTMLElement;
        active: () => boolean;
        complete: boolean;
        cancel: () => void;
      }
    | undefined
  >(undefined);

  useEffect(() => () => intent.current?.cancel(), []);
  useLayoutEffect(() => {
    const request = intent.current;
    if (!request) return;
    if (!request.active()) {
      request.cancel();
      return;
    }
    if (busy || !request.complete) return;
    request.cancel();
    const document = request.opener.ownerDocument;
    const focused = document.activeElement;
    if (focused !== request.opener && focused !== document.body && focused !== document.documentElement) return;
    const usable = (node: HTMLElement | null): node is HTMLElement => {
      if (!node?.isConnected || !workspace.current?.contains(node) || node.matches(':disabled')) return false;
      for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
        if (parent.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = document.defaultView?.getComputedStyle(parent);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse')
          return false;
        if (parent.matches('details:not([open])') && !parent.querySelector('summary')?.contains(node)) return false;
      }
      return true;
    };
    // Keep a surviving Retry; otherwise announce the settled native result and read availability together.
    const target = usable(request.opener) ? request.opener : result.current;
    if (usable(target) && focused !== target) target.focus();
  });

  return {
    workspace,
    result,
    onKeyDownCapture() {
      keyboard.current = true;
    },
    onClickCapture(event: { detail: number }) {
      keyboard.current = event.detail === 0;
    },
    onPointerDownCapture() {
      keyboard.current = false;
    },
    begin() {
      intent.current?.cancel();
      const document = workspace.current?.ownerDocument;
      const opener = document?.activeElement;
      if (!document || !keyboard.current || !opener || !workspace.current?.contains(opener) || !active()) return;
      const request = {
        opener: opener as HTMLElement,
        active,
        complete: false,
        finish() {
          if (intent.current !== request) return;
          request.complete = true;
          settled();
        },
        cancel() {
          document.removeEventListener('focusin', moved, true);
          document.removeEventListener('pointerdown', cancel, true);
          if (intent.current === request) intent.current = undefined;
        },
      };
      function moved(event: FocusEvent) {
        if (event.target === opener) return;
        // Removal/disable may return focus to the document without a reader choice.
        if (
          (event.target === document.body || event.target === document.documentElement) &&
          (!opener.isConnected || opener.matches(':disabled'))
        )
          return;
        request.cancel();
      }
      const cancel = () => request.cancel();
      document.addEventListener('focusin', moved, true);
      document.addEventListener('pointerdown', cancel, true);
      intent.current = request;
      return request;
    },
  };
}
