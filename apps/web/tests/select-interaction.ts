import { act } from 'react';

/** Follow a Select's portalled choices rather than dispatching native change events. */
export async function chooseSelect(trigger: HTMLElement, label: string | RegExp) {
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    typeof label === 'string' ? node.textContent === label : label.test(node.textContent ?? ''),
  );
  if (!option) throw new Error(`Missing Select choice: ${label}`);
  await act(async () => option.click());
}
