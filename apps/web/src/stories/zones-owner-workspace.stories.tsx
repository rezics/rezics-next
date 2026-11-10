import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ZonesOwnerWorkspace } from '../features/zones/manage/workspace';
import { zonesFixture, type Scenario } from '../features/zones/manage/fixtures';
import type { ListOutcome } from '../features/zones/manage/model';
import { zonesNavigation } from '../features/zones/manage/navigation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function WorkspaceStory({ scenario = 'list' }: { scenario?: Scenario | 'loading' }) {
  const locale = getLocale();
  const fixture = useMemo(() => zonesFixture(scenario === 'loading' ? 'list' : scenario), [scenario]);
  const deleted = scenario === 'trash' || scenario === 'expired';
  const [outcome, setOutcome] = useState<ListOutcome | null>(() => {
    if (scenario === 'loading') return null;
    if (['denied', 'actor', 'closed', 'missing', 'stale', 'unavailable'].includes(scenario))
      return { kind: scenario as Exclude<ListOutcome['kind'], 'ready'> };
    return fixture.initial();
  });
  return (
    <PatternStory path={`/my/zones?deleted=${deleted}`} visitor="Signed In">
      <AppShell navigation={zonesNavigation}>
        <ZonesOwnerWorkspace
          locale={locale}
          input={{ deleted }}
          outcome={outcome}
          onChange={fixture.change}
          onReload={async () => setOutcome(await fixture.list({ deleted }))}
        />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Zones/Owner workspace',
  id: 'pages-zones-owner-workspace',
  component: WorkspaceStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Synthetic owner-only native responses; review at 390 and 1280 in every locale and theme. These stories do not establish visual or native acceptance.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const List: Story = {
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list', { name: m.zones_owner_active() });
    const row = within(within(list).getAllByRole('listitem')[0]!);
    const title = row.getByRole('heading', { level: 2 }).textContent!;
    const primary = row.getByRole('link', { name: m.zones_owner_configure_named({ title }) });
    expect(primary).toHaveAttribute('href', expect.stringContaining('/edit'));
    primary.focus();
    await userEvent.tab();
    expect(row.getByRole('link', { name: m.zones_owner_open() })).toHaveFocus();
    await userEvent.tab();
    expect(row.getByRole('link', { name: m.zones_owner_configure() })).toHaveFocus();
    await userEvent.tab();
    expect(row.getByRole('button', { name: m.zones_owner_trash_action() })).toHaveFocus();
  },
};
export const ListPhone: Story = { ...List, globals: {} };
export const Empty: Story = { args: { scenario: 'empty' } };
export const Trash: Story = {
  args: { scenario: 'trash' },
  globals: {},
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole('list', { name: m.zones_owner_trash() });
    const row = within(within(list).getAllByRole('listitem')[0]!);
    expect(row.getByRole('heading', { level: 2 })).toBeVisible();
    expect(row.queryAllByRole('link')).toHaveLength(0);
    const restore = row.getByRole('button', { name: m.zones_owner_restore() });
    restore.focus();
    expect(restore).toHaveFocus();
    expect(restore).toBeEnabled();
  },
};
export const TrashPhone: Story = { ...Trash, globals: {} };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Denied: Story = { args: { scenario: 'denied' } };
export const ActorDenied: Story = { args: { scenario: 'actor' } };
export const FeatureClosed: Story = { args: { scenario: 'closed' } };
export const Missing: Story = { args: { scenario: 'missing' } };
export const StaleCursor: Story = { args: { scenario: 'stale' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const Expired: Story = { args: { scenario: 'expired' } };

async function deleteZone(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const trigger = (await canvas.findAllByRole('button', { name: m.zones_owner_trash_action() }))[0]!;
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  const dialog = await within(document.body).findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('button', { name: m.zones_owner_trash_action() }));
  return canvas;
}
export const MoveToTrash: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await deleteZone(canvasElement);
    expect(await canvas.findByText(m.zones_owner_trashed())).toBeVisible();
  },
};
export const Restore: Story = {
  args: { scenario: 'trash' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.zones_owner_restore() }));
    expect(await canvas.findByText(m.zones_owner_restored())).toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    const canvas = await deleteZone(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_conflict());
    expect(canvas.getByRole('link', { name: m.zones_owner_open() })).toBeVisible();
  },
};
export const WriteFenced: Story = { ...Conflict, args: { scenario: 'fenced' } };
export const UncertainRetry: Story = {
  args: { scenario: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = await deleteZone(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.zones_owner_retry() }));
    expect(await canvas.findByText(m.zones_owner_trashed())).toBeVisible();
  },
};
