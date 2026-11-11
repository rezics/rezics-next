import { expect, userEvent, within } from 'storybook/test';

function submittedValueInput(trigger: HTMLElement) {
  const submittedValue = trigger.nextElementSibling;
  if (submittedValue?.tagName !== 'INPUT' || submittedValue.getAttribute('aria-hidden') !== 'true') {
    throw new Error('SelectTrigger must be followed by the shared Select submitted-value input');
  }
  return submittedValue as HTMLInputElement;
}

export function readSelectValue(trigger: HTMLElement) {
  return trigger.tagName === 'SELECT'
    ? (trigger as unknown as { value: string }).value
    : submittedValueInput(trigger).value;
}

export async function chooseSelectValue(trigger: HTMLElement, selection: string) {
  if (trigger.tagName === 'SELECT') {
    const nativeSelect = trigger as unknown as Parameters<typeof userEvent.selectOptions>[0];
    await userEvent.selectOptions(nativeSelect, selection as Parameters<typeof userEvent.selectOptions>[1]);
    return;
  }

  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  const option = (await body.findAllByRole('option')).find((item) => item.getAttribute('data-value') === selection);
  if (!option) throw new Error(`Select option not found for value: ${selection}`);
  await userEvent.click(option);
}

export async function chooseSelectOptionByName(trigger: HTMLElement, name: string | RegExp) {
  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  await userEvent.click(await body.findByRole('option', { name }));
}

export async function chooseCurrentSelectOption(trigger: HTMLElement) {
  if (trigger.tagName === 'SELECT') {
    const value = (trigger as unknown as { value: string }).value;
    const nativeSelect = trigger as unknown as Parameters<typeof userEvent.selectOptions>[0];
    await userEvent.selectOptions(nativeSelect, value);
    return;
  }

  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  await userEvent.click(await body.findByRole('option', { selected: true }));
}

export async function expectSelectValue(trigger: HTMLElement, value: string) {
  if (trigger.tagName === 'SELECT') {
    await expect(trigger).toHaveValue(value);
    return;
  }
  await expect(submittedValueInput(trigger)).toHaveValue(value);
}

export async function expectSelectOptionAvailability(trigger: HTMLElement, value: string, available: boolean) {
  if (trigger.tagName === 'SELECT') {
    const present = [...trigger.querySelectorAll('option')].some((option) => option.getAttribute('value') === value);
    expect(present).toBe(available);
    return;
  }

  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  const option = (await body.findAllByRole('option')).find((item) => item.getAttribute('data-value') === value);
  expect(!!option).toBe(available);
  await userEvent.keyboard('{Escape}');
}
