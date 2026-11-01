import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import emptySearch from '../kernel/recorded/search-empty.json';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Patterns/Header Search',
  parameters: { layout: 'fullscreen' },
  render: () => <PageStory visitor="Signed Out" path={pagePaths['search-typed']} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Uses AppShell's default owner and recorded page boundary; this is not native search evidence. */
export const KeyboardEntry: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const origin = canvas.getByRole('main');
    origin.focus();
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await canvas.findByRole('combobox', { name: m.search_label() });
    await waitFor(() => expect(input).toHaveFocus());
    await expect(input).toHaveAccessibleName(m.search_label());
    await expect(input).toHaveAttribute('aria-keyshortcuts', 'Control+k Meta+k');
    await expect(context.canvasElement.querySelectorAll('[data-header-search]')).toHaveLength(1);
    await userEvent.clear(input);
    await expect(input).toHaveAccessibleDescription(m.header_search_keyboard_help());
    await userEvent.type(input, 'A retained draft');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(origin).toHaveFocus());
    if (window.matchMedia('(max-width: 1023px)').matches) {
      const trigger = canvas.getByRole('button', { name: 'A retained draft Ctrl/⌘ K' });
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAccessibleName('A retained draft Ctrl/⌘ K');
      await expect(trigger).toHaveAccessibleDescription(m.header_search_keyboard_help());
    }
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await waitFor(() => expect(input).toHaveFocus());
    await expect(input).toHaveValue('A retained draft');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(origin).toHaveFocus());
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() => expect(input).toHaveFocus());
    await userEvent.clear(input);
    await userEvent.type(input, emptySearch.query);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(input).toHaveAttribute('aria-expanded', 'false'));
    await expect(await within(canvas.getByRole('main')).findByText(m.search_no_results())).toBeVisible();
  },
};
