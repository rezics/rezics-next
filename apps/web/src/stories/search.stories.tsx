import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Discovery/Search',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ResultFilters: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-facet-active']} />,
  play: async (context) => {
    await pageReady(context);
    const main = within(context.canvasElement).getByRole('main');
    const canvas = within(main);
    const trigger = await canvas.findByRole('button', { name: new RegExp(`^${m.search_filters()} \\(`) });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    const heading = canvas.getByRole('heading', { level: 1, name: m.search_heading() });
    const results = canvas.getByText(m.search_results(), { exact: true });
    await expect(Math.abs(results.getBoundingClientRect().left - heading.getBoundingClientRect().left)).toBeLessThan(8);
    await userEvent.click(trigger);
    const body = within(context.canvasElement.ownerDocument.body);
    const type = await body.findByRole('combobox', { name: m.search_subject_type() });
    await expect(type).toHaveValue('schema:Book');
    await expect(body.getByText(m.search_all_kinds(), { exact: true })).toBeVisible();
    await userEvent.click(body.getByText(m.search_choose_kinds(), { exact: true }));
    const kinds = body.getByRole('region', { name: m.search_result_kinds() });
    const choice = within(kinds).getByRole('checkbox');
    const choiceName = choice.getAttribute('aria-label')!;
    await userEvent.click(choice);
    await waitFor(() => expect(body.getByRole('checkbox', { name: choiceName })).toBeChecked());
    await expect(body.getByRole('combobox', { name: m.search_subject_type() })).toHaveValue('schema:Book');
  },
};
