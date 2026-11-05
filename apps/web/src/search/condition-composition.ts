import { useRef, type CompositionEvent, type KeyboardEvent } from 'react';

/** Native events update refs before React renders or an implicit form submit arrives. */
export function useConditionComposition(owner: string) {
  const current = useRef({
    owner,
    target: null as EventTarget | null,
    keyboard: false,
  });
  if (current.current.owner !== owner) current.current = { owner, target: null, keyboard: false };

  const isComposing = (event?: KeyboardEvent<HTMLElement>) =>
    current.current.target !== null ||
    current.current.keyboard ||
    Boolean(event?.nativeEvent.isComposing || event?.nativeEvent.keyCode === 229);

  return {
    isComposing,
    handlers: {
      onCompositionStartCapture(event: CompositionEvent<HTMLElement>) {
        current.current.target = event.target;
      },
      onCompositionEndCapture() {
        current.current.target = null;
        // Keep a candidate-confirming key until keyup, even if compositionend precedes submit.
      },
      onKeyDownCapture(event: KeyboardEvent<HTMLElement>) {
        current.current.keyboard = Boolean(
          current.current.target !== null || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229,
        );
        if (isComposing(event) && event.key === 'Escape') event.stopPropagation();
      },
      onKeyUpCapture() {
        current.current.keyboard = false;
      },
      onPointerDownCapture() {
        current.current.keyboard = false;
      },
      onBlurCapture() {
        current.current.target = null;
        current.current.keyboard = false;
      },
    },
  };
}
