import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ZonesOwnerWorkspace } from '../features/zones/manage/workspace';
import { fixtureZone, zonesFixture, type Scenario } from '../features/zones/manage/fixtures';
import { pageLimit, type ListOutcome, type OwnedZone } from '../features/zones/manage/model';
import { OwnerLifetime } from '../features/zones/editor/owner-lifetime';
import { sessionQuery } from '../session/query';
import { zonesNavigation } from '../features/zones/manage/navigation';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const longName = '読書と旅の記録 — مكتبة الرحلات والقراءة — Carnets de lecture et de voyage';
const trashZone = fixtureZone(true);
const deadline = trashZone.restoreUntil!;
const desktopGlobals = { viewport: { value: 'desktop1280', isRotated: false } };
const phoneGlobals = { viewport: { value: 'phone390', isRotated: false } };
type Example = Scenario | 'empty-trash' | 'long-active' | 'long-trash' | 'growth' | 'retired';

function ControlsExample({
  example = 'long-active',
  rtl = false,
  independent = false,
}: {
  example?: Example;
  rtl?: boolean;
  independent?: boolean;
}) {
  const locale = getLocale();
  const deleted = ['trash', 'expired', 'empty-trash', 'long-trash'].includes(example);
  const api = useMemo(
    () =>
      zonesFixture(
        example === 'retired'
          ? 'list'
          : example.startsWith('long-') || example === 'growth'
            ? 'empty'
            : example === 'empty-trash'
              ? 'empty'
              : (example as Scenario),
      ),
    [example],
  );
  const owner = useMemo(() => {
    if (example !== 'retired') return undefined;
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'synthetic-owner',
      csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    return new OwnerLifetime(client, '/my/zones');
  }, [example]);
  const [outcome, setOutcome] = useState<ListOutcome>(() => {
    if (['denied', 'unavailable', 'stale', 'actor', 'closed', 'missing'].includes(example))
      return { kind: example as 'denied' | 'unavailable' | 'stale' | 'actor' | 'closed' | 'missing' };
    if (example.startsWith('long-') || example === 'growth') {
      const zones: OwnedZone[] = Array.from({ length: example === 'growth' ? pageLimit : 2 }, (_, index) => ({
        ...(deleted ? trashZone : fixtureZone()),
        id: `0192f3a0-6c1e-7b2a-9d4e-${String(index).padStart(12, '0')}`,
        labels: { ja: `${longName} ${index + 1}` },
        primaryLanguage: 'ja',
        visibility: index % 2 ? 'unlisted' : 'private',
        ...(deleted && index !== 0 ? { deletedAt: '2019-12-02T00:00:00.000Z' } : {}),
        restoreUntil: deleted ? (index === 0 ? deadline : '2020-01-01T00:00:00.000Z') : null,
      }));
      return { kind: 'ready', page: { zones, next: 'opaque+/cursor==' } };
    }
    return { ...api.initial(), ...(owner ? { ownerObservation: owner.capture()!.observation } : {}) };
  });
  return (
    <PatternStory path={`/my/zones?deleted=${deleted}`} visitor="Signed In">
      <AppShell navigation={zonesNavigation}>
        <div dir={rtl ? 'rtl' : 'ltr'} lang={locale} className="min-w-0 space-y-10">
          <ZonesOwnerWorkspace
            locale={locale}
            input={{ deleted, cursor: 'opaque+/previous==' }}
            outcome={outcome}
            {...(owner ? { owner } : {})}
            onChange={async (command, capture) => {
              const response = api.change(command);
              if (example === 'retired') owner!.end();
              const result = await response;
              return { ...result, ...(capture ? { ownerObservation: capture.observation } : {}) };
            }}
            onReload={async () => setOutcome(await api.list({ deleted }))}
          />
          {independent ? <ControlsExampleInstance /> : null}
        </div>
      </AppShell>
    </PatternStory>
  );
}

function ControlsExampleInstance() {
  const locale = getLocale();
  const api = useMemo(() => zonesFixture('list'), []);
  const [outcome, setOutcome] = useState<ListOutcome>(api.initial);
  return (
    <ZonesOwnerWorkspace
      locale={locale}
      input={{ deleted: false }}
      outcome={outcome}
      onChange={api.change}
      onReload={async () => setOutcome(await api.list({ deleted: false }))}
    />
  );
}

const meta = {
  title: 'Pages/Zones/Owner controls family',
  component: ControlsExample,
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
          'UNRUN actual workspace examples connected to zonesFixture and the native request adapter. Review every locale/theme at 390 and 1280. Long names use the supplied Japanese fallback language, including mixed RTL text; no description or identifier absent from the owner summary is invented. Supplied-data growth is capped at the actual pageLimit=20. Rendering adds zero IO and no population traversal. Authored DOM/play assertions are not geometry, browser, native lifecycle or physical growth proof.',
      },
    },
  },
} satisfies Meta<typeof ControlsExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveDesktop: Story = {
  globals: desktopGlobals,
  play: async ({ canvasElement }) => {
    const list = await within(canvasElement).findByRole('list', { name: m.zones_owner_active() });
    const row = within(within(list).getAllByRole('listitem')[0]!);
    expect(row.getByRole('heading', { level: 2 })).toHaveTextContent(`${longName} 1`);
    expect(row.getByRole('heading', { level: 2 })).toHaveAttribute('lang', 'ja');
    const primary = row.getAllByRole('link')[0]!;
    primary.focus();
    await userEvent.tab();
    expect(row.getByRole('link', { name: m.zones_owner_open() })).toHaveFocus();
    await userEvent.tab();
    expect(row.getByRole('link', { name: m.zones_owner_configure() })).toHaveFocus();
    await userEvent.tab();
    expect(row.getByRole('button', { name: m.zones_owner_trash_action() })).toHaveFocus();
  },
};
export const ActivePhone: Story = { ...ActiveDesktop, globals: phoneGlobals };
export const RtlPhone: Story = { ...ActivePhone, args: { rtl: true } };
export const TrashDesktop: Story = {
  args: { example: 'long-trash' },
  globals: desktopGlobals,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list', { name: m.zones_owner_trash() }));
    const rows = list.getAllByRole('listitem');
    expect(list.queryAllByRole('link')).toHaveLength(0);
    expect(rows[0]!.querySelector('time')).toHaveAttribute('datetime', deadline);
    expect(within(rows[0]!).getByRole('button', { name: m.zones_owner_restore() })).toBeEnabled();
    expect(within(rows[1]!).getByRole('button', { name: m.zones_owner_restore() })).toBeDisabled();
    expect(within(rows[1]!).getByRole('status')).toHaveTextContent(m.zones_owner_expired());
  },
};
export const TrashPhone: Story = { ...TrashDesktop, globals: phoneGlobals };
export const EmptyActive: Story = { args: { example: 'empty' } };
export const EmptyTrash: Story = { args: { example: 'empty-trash' } };
export const Denied: Story = { args: { example: 'denied' } };
export const Unavailable: Story = { args: { example: 'unavailable' } };
export const StaleCursor: Story = { args: { example: 'stale' } };
export const BoundedSuppliedPage: Story = { args: { example: 'growth' }, globals: phoneGlobals };

async function openConfirmation(canvasElement: HTMLElement) {
  const trigger = (await within(canvasElement).findAllByRole('button', { name: m.zones_owner_trash_action() }))[0]!;
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  return { trigger, dialog: await within(document.body).findByRole('alertdialog') };
}
export const KeyboardCancelAndConfirm: Story = {
  args: { example: 'list' },
  play: async ({ canvasElement }) => {
    const { trigger, dialog } = await openConfirmation(canvasElement);
    expect(dialog).toHaveAccessibleName(m.zones_owner_confirm_title({ title: fixtureZone().labels[getLocale()]! }));
    within(dialog).getByRole('button', { name: m.zones_owner_cancel() }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
    const reopened = await openConfirmation(canvasElement);
    within(reopened.dialog).getByRole('button', { name: m.zones_owner_trash_action() }).focus();
    await userEvent.keyboard('{Enter}');
    expect(await within(canvasElement).findByText(m.zones_owner_trashed())).toBeVisible();
  },
};
export const IndependentInstances: Story = {
  ...KeyboardCancelAndConfirm,
  args: { example: 'list', independent: true },
};
export const LongConfirmationPhone: Story = {
  globals: phoneGlobals,
  play: async ({ canvasElement }) => {
    const { trigger, dialog } = await openConfirmation(canvasElement);
    expect(dialog).toHaveAccessibleName(m.zones_owner_confirm_title({ title: `${longName} 1` }));
    within(dialog).getByRole('button', { name: m.zones_owner_cancel() }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
export const Conflict: Story = {
  args: { example: 'conflict' },
  play: async ({ canvasElement }) => {
    const { dialog } = await openConfirmation(canvasElement);
    await userEvent.click(within(dialog).getByRole('button', { name: m.zones_owner_trash_action() }));
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_conflict());
    await userEvent.click(canvas.getByRole('button', { name: m.zones_owner_retry() }));
    await waitFor(() => expect(canvas.queryByRole('alert')).toBeNull());
  },
};
export const UncertainRetry: Story = {
  args: { example: 'uncertain' },
  play: async ({ canvasElement }) => {
    const { dialog } = await openConfirmation(canvasElement);
    await userEvent.click(within(dialog).getByRole('button', { name: m.zones_owner_trash_action() }));
    const canvas = within(canvasElement);
    expect(await canvas.findByRole('alert')).toHaveTextContent(m.zones_owner_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.zones_owner_retry() }));
    expect(await canvas.findByText(m.zones_owner_trashed())).toBeVisible();
  },
};
export const Restore: Story = {
  args: { example: 'trash' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.zones_owner_restore() }));
    expect(await canvas.findByText(m.zones_owner_restored())).toBeVisible();
  },
};
export const RetiredOwner: Story = {
  args: { example: 'retired' },
  play: async ({ canvasElement }) => {
    const { dialog } = await openConfirmation(canvasElement);
    await userEvent.click(within(dialog).getByRole('button', { name: m.zones_owner_trash_action() }));
    expect(await within(canvasElement).findByRole('status')).toHaveTextContent(m.zones_owner_loading());
    expect(within(canvasElement).queryByRole('list', { name: m.zones_owner_active() })).toBeNull();
    expect(within(canvasElement).queryByText(m.zones_owner_trashed())).toBeNull();
  },
};
