'use client';

import { useLayoutEffect, useRef } from 'react';

/** Keep the native field uncontrolled, adopt typing/autofill on hydration, and
 * still apply deliberate changes such as clearing a refused password. React's
 * input contract: https://react.dev/reference/react-dom/components/input */
export function useFormValue(value: string, onChange: (value: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  const previous = useRef(value);
  const mounted = useRef(false);
  const changed = useRef(onChange);
  changed.current = onChange;
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    if (!mounted.current) {
      mounted.current = true;
      if (input.value !== value) changed.current(input.value);
    } else if (previous.current !== value && input.value !== value) {
      input.value = value;
    }
    previous.current = value;
  }, [value]);
  return { ref, defaultValue: value };
}
