import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { chooseOption } from '../stories/choose-option.ts';
import type { PageChoice, PageSearchResult, ZoneNavigationClient } from './api.ts';
import { copyOf } from './messages.ts';
import { PageSearchPicker } from './page-search-picker.tsx';

const choice: PageChoice = { target: 'https://rezics.com/id/00000000-0000-4000-8000-000000000811', name: 'Harbor story' };

function PageSearchStory({ mode }: { mode: 'unavailable' | 'partial' | 'more' }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PageChoice | null>(null);
  const [api] = useState<Pick<ZoneNavigationClient, 'findPages'>>(() => {
    let calls = 0;
    return { async findPages(value): Promise<PageSearchResult> {
      await expect(value).toBe('Harbor');
      calls += 1;
      if (mode !== 'more' && calls === 1) return { ok: false, failure: mode };
      return { ok: true, data: { choices: [choice], hasMore: mode === 'more' } };
    } };
  });
  return <main className="mx-auto grid max-w-lg gap-4 p-6">
    <h1 className="text-xl font-semibold">Choose a page</h1>
    <PageSearchPicker query={query} picked={picked} locale="en" copy={copyOf('en')} disabled={false}
      signInHref="/auth/start" api={api} onQueryChange={value => { setPicked(null); setQuery(value); }}
      onChoose={value => { setPicked(value); setQuery(value.name); }} />
    {picked ? <p role="status">Selected {picked.name}</p> : null}
  </main>;
}

const meta = { title: 'Zone editor/Page suggestions', render: () => <PageSearchStory mode="unavailable" /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnavailableSuggestionsCanRetry: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: /^Page$/ }), 'Harbor');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Page suggestions could not be loaded. Your search is still here.');
    await expect(canvas.queryByText('No page with that name.')).toBeNull();
    await expect(canvas.getByRole('textbox', { name: /^Page$/ })).toHaveValue('Harbor');
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await chooseOption(canvas, 'Harbor story');
    await expect(canvas.getByRole('status')).toHaveTextContent('Selected Harbor story');
  },
};

export const PartialSuggestionsRemainActionable: Story = {
  render: () => <PageSearchStory mode="partial" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: /^Page$/ }), 'Harbor');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Some page suggestions could not be read. Try again.');
    await expect(canvas.queryByRole('option')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Try again' })).toBeVisible();
  },
};

export const MoreSuggestionsNeedRefinement: Story = {
  render: () => <PageSearchStory mode="more" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: /^Page$/ }), 'Harbor');
    await expect(await canvas.findByRole('option', { name: 'Harbor story' })).toBeVisible();
    await expect(canvas.getByText('More pages match. Refine the name to narrow the suggestions.')).toBeVisible();
    await expect(canvas.queryByText('No page with that name.')).toBeNull();
  },
};
