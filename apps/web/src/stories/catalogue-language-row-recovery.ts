import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

type CreateCall = { method: string; path: string; body: unknown; key: string | null };
export type ObserveCreate = (calls: CreateCall[]) => void;
export const createObserver = () => fn<ObserveCreate>();

/** Shared interactions only: each story still mounts its default creator and original request transport. */
export async function recoverLanguageRow(
  canvasElement: HTMLElement,
  submit: string,
  observed: ReturnType<typeof createObserver>,
  primaryName: string,
  translationName: string,
) {
  const canvas = within(canvasElement);
  const terms = within(await canvas.findByRole('group', { name: m.catalogue_create_terms() }));
  const primaryLanguage = terms.getByRole('textbox', { name: m.catalogue_create_language() });
  const primary = within(primaryLanguage.closest('fieldset')!);
  await expect(primary.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(primaryName);
  await userEvent.clear(primaryLanguage);
  await userEvent.type(primaryLanguage, 'en');
  await userEvent.type(primary.getByRole('textbox', { name: m.catalogue_create_description() }), 'Primary description');
  await userEvent.type(
    primary.getByRole('textbox', { name: m.catalogue_create_aliases() }),
    'First alias\nSecond alias',
  );
  await expect(primary.queryByRole('button', { name: m.catalogue_create_remove_language() })).toBeNull();

  const add = terms.getByRole('button', { name: m.catalogue_create_add_language() });
  await expect(add).toHaveAttribute('type', 'button');
  await userEvent.click(add);
  await userEvent.click(add);
  const [unwantedRow, retainedRow] = terms.getAllByRole('group', { name: m.catalogue_create_language() });
  const retained = within(retainedRow!);
  const language = retained.getByRole('textbox', { name: m.catalogue_create_language() });
  const label = retained.getByRole('textbox', { name: m.catalogue_create_label() });
  const labelId = label.id;
  await userEvent.type(language, 'ja');
  await userEvent.type(label, translationName);
  await userEvent.type(
    retained.getByRole('textbox', { name: m.catalogue_create_description() }),
    'Translation description',
  );
  await userEvent.type(
    retained.getByRole('textbox', { name: m.catalogue_create_aliases() }),
    'First translation alias\nSecond translation alias',
  );
  await expect(observed).not.toHaveBeenCalled();

  // A blank row must still fail validation until the person explicitly removes it.
  await userEvent.click(canvas.getByRole('button', { name: submit }));
  await canvas.findAllByRole('alert');
  await expect(observed).not.toHaveBeenCalled();
  const remove = within(unwantedRow!).getByRole('button', { name: m.catalogue_create_remove_language() });
  await expect(remove).toHaveAttribute('type', 'button');
  await expect(remove).toHaveAttribute('aria-controls', unwantedRow!.id);
  await userEvent.click(remove);
  await expect(unwantedRow).not.toBeInTheDocument();
  await expect(terms.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(2);
  await expect(terms.getByRole('group', { name: 'ja' })).toBe(retainedRow);
  await expect(retained.getByRole('textbox', { name: m.catalogue_create_label() })).toBe(label);
  await expect(label).toHaveAttribute('id', labelId);
  await userEvent.click(retained.getByText(m.catalogue_create_label(), { exact: true }));
  await expect(label).toHaveFocus();
  await expect(observed).not.toHaveBeenCalled();

  // Removing the middle row must leave duplicate-language validation intact too.
  await userEvent.clear(language);
  await userEvent.type(language, 'en');
  await userEvent.click(canvas.getByRole('button', { name: submit }));
  await canvas.findAllByRole('alert');
  await expect(observed).not.toHaveBeenCalled();
  await userEvent.clear(language);
  await userEvent.type(language, 'ja');
  // Exercise the retained row's change handler after its predecessor disappeared.
  await userEvent.type(retained.getByRole('textbox', { name: m.catalogue_create_description() }), ' retained');
  await expect(primary.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue(primaryName);
  await expect(label).toHaveValue(translationName);
  return {
    labels: { en: primaryName, ja: translationName },
    descriptions: { en: 'Primary description', ja: 'Translation description retained' },
    aliases: { en: ['First alias', 'Second alias'], ja: ['First translation alias', 'Second translation alias'] },
  };
}

export async function retryLanguageRecovery(
  canvasElement: HTMLElement,
  submit: string,
  retry: string,
  observed: ReturnType<typeof createObserver>,
  expected: unknown,
) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: submit }));
  await waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
  const retryButton = await canvas.findByRole('button', { name: retry });
  await waitFor(() => expect(retryButton).toBeEnabled());
  const remove = canvas.getByRole('button', { name: m.catalogue_create_remove_language() });
  await expect(remove).toBeDisabled();
  await expect(canvas.getByRole('button', { name: m.catalogue_create_add_language() })).toBeDisabled();
  remove.click();
  await expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })).toHaveLength(2);
  await userEvent.click(retryButton);
  await waitFor(() => expect(observed).toHaveBeenCalledTimes(2));
  const writes = observed.mock.calls[1]![0].filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
  await expect(writes).toHaveLength(2);
  await expect(writes[0]!.body).toEqual(expected);
  await expect(writes[1]!.body).toEqual(expected);
  await expect(writes[1]!.body).toEqual(writes[0]!.body);
  await expect(writes[0]!.key).toBeTruthy();
  await expect(writes[1]!.key).toBe(writes[0]!.key);
}
