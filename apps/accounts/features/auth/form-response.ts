'use client';

import { useEffect, useRef } from 'react';
import type { AuthFormState } from './form-state.ts';

/** A submit caught by React during hydration may finish as an action after
 * mount. Adopt that response too; the initial SSR state was already read by
 * useState, and must not overwrite typing that the fields just adopted. */
export function useFormResponse(state: AuthFormState, receive: (state: AuthFormState) => void) {
  const previous = useRef(state);
  const callback = useRef(receive);
  callback.current = receive;
  useEffect(() => {
    if (state === previous.current) return;
    previous.current = state;
    callback.current(state);
  }, [state]);
}
