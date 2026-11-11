import { expect, userEvent, within } from 'storybook/test';

type OptionSelection = string | string[] | HTMLOptionElement | HTMLOptionElement[];

function submittedValueInput(trigger: HTMLElement) {
  const submittedValue = trigger.nextElementSibling;
  if (submittedValue?.tagName !== 'INPUT' || submittedValue.getAttribute('aria-hidden') !== 'true') {
    throw new Error('SelectTrigger must be followed by the shared Select submitted-value input');
  }
  return submittedValue as HTMLInputElement;
}

export function readSelectValue(trigger: HTMLElement) {
  return trigger.tagName === 'SELECT' ? (trigger as HTMLSelectElement).value : submittedValueInput(trigger).value;
}

export async function chooseSelectValue(trigger: HTMLElement, selection: OptionSelection) {
  if (trigger.tagName === 'SELECT') {
    await userEvent.selectOptions(
      trigger as HTMLSelectElement,
      selection as string | string[] | HTMLOptionElement | HTMLOptionElement[],
    );
    return;
  }

  const values = (Array.isArray(selection) ? selection : [selection]).map((item) =>
    typeof item === 'string' ? item : item.value,
  );
  if (values.length !== 1) throw new Error('A single Select cannot choose multiple values');
  const value = values[0]!;
  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  const option = (await body.findAllByRole('option')).find((item) => item.getAttribute('data-value') === value);
  if (!option) throw new Error(`Select option not found for value: ${value}`);
  await userEvent.click(option);
}

export async function chooseSelectOptionByName(trigger: HTMLElement, name: string | RegExp) {
  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  await userEvent.click(await body.findByRole('option', { name }));
}

export async function chooseCurrentSelectOption(trigger: HTMLElement) {
  if (trigger.tagName === 'SELECT') {
    const select = trigger as HTMLSelectElement;
    await userEvent.selectOptions(select, select.value);
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
    const present = [...(trigger as HTMLSelectElement).querySelectorAll('option')].some(
      (option) => option.value === value,
    );
    expect(present).toBe(available);
    return;
  }

  const body = within(trigger.ownerDocument.body);
  await userEvent.click(trigger);
  const option = (await body.findAllByRole('option')).find((item) => item.getAttribute('data-value') === value);
  expect(!!option).toBe(available);
  await userEvent.keyboard('{Escape}');
}
