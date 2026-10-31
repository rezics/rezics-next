import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { RecentHistoryView, type RecentState, emptyRecent, localChange, type LocalRecent } from '../search/recent';
import { HeaderSearchView } from '../search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../search/header-search/state';
import { m } from '../paraglide/messages.js';

const meta = { title: 'Patterns/Search/History', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const local = localChange(
  emptyRecent(),
  { kind: 'use', entry: { kind: 'query', text: 'Kokoro', languages: ['en'] } },
  false,
);
function Example({
  initial = local,
  status = 'local',
  history = false,
}: {
  initial?: LocalRecent;
  status?: RecentState;
  history?: boolean;
}) {
  const [state, setState] = useState(initial);
  const section = (
    <RecentHistoryView
      entries={state.entries}
      status={status}
      history={history}
      onRemove={(id) => setState((s) => localChange(s, { kind: 'remove', id }, false))}
      onClear={() => setState((s) => localChange(s, { kind: 'clear' }, false))}
    />
  );
  return history ? (
    section
  ) : (
    <HeaderSearchView
      id="recent-example"
      locale="en"
      region={null}
      state={reduceHeaderSearchState(initialHeaderSearchState(), { type: 'focus' })}
      recent={section}
    />
  );
}
export const LocalQueries: Story = {
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = within(await canvas.findByRole('search', { name: m.search_label() }));
    await expect(await search.findByRole('combobox', { name: m.search_label(), expanded: true })).toBeVisible();
    const recent = within(await search.findByRole('region', { name: m.search_recent() }));
    const remove = await recent.findByRole('button', { name: m.search_history_remove({ name: 'Kokoro' }) });
    await expect(recent.getByText('Kokoro', { exact: true })).toBeVisible();
    await expect(remove).toBeVisible();
    await expect(remove).toBeEnabled();
    await expect(recent.queryByText(m.search_history_empty())).not.toBeInTheDocument();
  },
};
export const Empty: Story = { render: () => <Example initial={emptyRecent()} /> };
export const History: Story = {
  render: () => <Example history />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const history = within(await canvas.findByRole('region', { name: m.search_recent() }));
    const clear = await history.findByRole('button', { name: m.search_history_clear() });
    await expect(history.getByRole('heading', { name: m.search_history() })).toBeVisible();
    await expect(history.getByText('Kokoro', { exact: true })).toBeVisible();
    await expect(clear).toBeVisible();
    await expect(clear).toBeEnabled();
    await expect(history.queryByText(m.search_history_empty())).not.toBeInTheDocument();
  },
};
export const RemoveLocalQuery: Story = {
  tags: ['!dev'],
  render: () => <Example />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.search_history_remove({ name: 'Kokoro' }) }));
    await expect(await canvas.findByText(m.search_history_empty())).toBeVisible();
  },
};
export const ClearHistory: Story = {
  tags: ['!dev'],
  render: () => <Example history />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.search_history_clear() }));
    await expect(await canvas.findByText(m.search_history_empty())).toBeVisible();
  },
};
const unavailable = localChange(
  emptyRecent(),
  { kind: 'use', entry: { kind: 'scope', scope: { kind: 'realm', id: '019f0000-0000-7000-8000-734100000001' } } },
  false,
);
export const UnavailableScope: Story = { render: () => <Example initial={unavailable} /> };
export const Offline: Story = { render: () => <Example status="unavailable" /> };
export const Conflict: Story = { render: () => <Example status="conflict" history /> };
