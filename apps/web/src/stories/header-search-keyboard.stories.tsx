import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import emptySearch from '../kernel/recorded/search-empty.json';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Discovery/Header Search',
  id: 'patterns-header-search',
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

/** Exercises the signed-in Subject route through AppShell's actual default HeaderSearch owner. */
export const SubjectDefaultCompositionNaming: Story = {
  globals: {},
  render: () => <PageStory visitor="Signed In" path={pagePaths.subject} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const owner = context.canvasElement.querySelector<HTMLElement>('[data-header-search]');
    const trigger = owner?.querySelector<HTMLButtonElement>('.header-search-trigger');
    const input = owner?.querySelector<HTMLInputElement>('input[role="combobox"]');
    const help = owner?.querySelector<HTMLElement>('[id$="-keyboard-help"]');
    if (!owner || !trigger || !input || !help) throw new Error('The default shell search naming surface is missing.');

    await expect(trigger).toBeVisible();
    const visibleName = trigger.innerText.replace(/\s+/gu, ' ').trim();
    await expect(trigger).toHaveAccessibleName(visibleName);
    await expect(trigger).toHaveAttribute('aria-label', visibleName);
    await expect(trigger).toHaveAccessibleDescription(m.header_search_keyboard_help());
    await expect(trigger).toHaveAttribute('aria-keyshortcuts', 'Control+k Meta+k');
    await expect(trigger).toHaveAttribute('aria-describedby', help.id);

    await expect(input).toHaveAttribute('aria-label', m.search_label());
    await expect(input).toHaveAttribute('aria-keyshortcuts', 'Control+k Meta+k');
    if (!input.getAttribute('aria-describedby')?.split(/\s+/u).includes(help.id)) {
      throw new Error('The search field lost its keyboard help description.');
    }

    await userEvent.click(trigger);
    const expandedInput = await canvas.findByRole('combobox', { name: m.search_label() });
    await expect(expandedInput).toHaveAccessibleName(m.search_label());
    await expect(expandedInput).toHaveFocus();
    await userEvent.type(expandedInput, 'Visible draft');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toBeVisible());

    const queryName = trigger.innerText.replace(/\s+/gu, ' ').trim();
    await expect(trigger).toHaveAccessibleName(queryName);
    await expect(trigger).toHaveAttribute('aria-label', queryName);
    await expect(trigger).toHaveAccessibleDescription(m.header_search_keyboard_help());
    await expect(canvas.getByRole('button', { name: queryName })).toBeVisible();
  },
};
