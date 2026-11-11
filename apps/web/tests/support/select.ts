import { act } from 'react';

/** Exercise the installed Select rather than assigning values to a native select. */
export function selectTrigger(root: unknown, index = 0): HTMLButtonElement {
  return (root as ParentNode).querySelectorAll<HTMLButtonElement>('[data-slot="select-trigger"]')[index]!;
}

export function selectValue(trigger: unknown): string {
  return ((trigger as Element).nextElementSibling as HTMLInputElement).value;
}

export async function selectOptions(trigger: unknown): Promise<HTMLElement[]> {
  const control = trigger as HTMLButtonElement;
  await act(async () => control.click());
  const list = control.ownerDocument.getElementById(control.getAttribute('aria-controls')!)!;
  const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  await act(async () => control.click());
  return options;
}

export async function chooseSelect(trigger: unknown, value: string): Promise<void> {
  const control = trigger as HTMLButtonElement;
  // Retained callbacks test attempts against disabled controls as well as enabled ones.
  if (control.matches(':disabled')) return;
  await act(async () => control.click());
  const list = control.ownerDocument.getElementById(control.getAttribute('aria-controls')!)!;
  const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.getAttribute('data-value') === value,
  )!;
  await act(async () => {
    option.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
