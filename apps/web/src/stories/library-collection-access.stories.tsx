import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CollectionAccessState } from '../library/collection-access';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Library/Collection access',
  parameters: {
    docs: {
      description: {
        component:
          'The Collection route uses these access states while private navigation resolves after hydration. Review the same story IDs at phone390 and desktop1280 with locale and theme globals. Screenshot review is pending integration.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function renderState(state: Parameters<typeof CollectionAccessState>[0]['state']) {
  return (
    <PatternStory visitor="Signed Out" path={pagePaths['library-collection']}>
      <CollectionAccessState state={state} />
    </PatternStory>
  );
}

export const Loading: Story = {
  render: () => renderState('loading'),
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('main', { name: 'Loading' })).toHaveAttribute('aria-busy', 'true');
    await expect(within(canvasElement).queryByRole('heading')).toBeNull();
  },
};

export const Concealed: Story = {
  render: () => renderState('not-found'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.not_found_heading() })).toBeVisible();
    const search = view.getByRole('link', { name: m.status_search() });
    await userEvent.tab();
    await userEvent.tab();
    search.focus();
    await expect(search).toHaveFocus();
    await expect(search).toHaveAttribute('href', expect.stringMatching(/\/search$/));
  },
};

export const Unavailable: Story = {
  render: () => renderState('unavailable'),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.error_heading() })).toBeVisible();
    const home = view.getByRole('link', { name: m.status_home() });
    await userEvent.hover(home);
    home.focus();
    await expect(home).toHaveFocus();
  },
};
