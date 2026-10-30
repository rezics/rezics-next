import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ContextCreateView, ContextDetailView, ContextDirectoryView } from '../features/contexts/view';
import { contextFixture, type Scenario } from '../features/contexts/fixtures';
import { directoryInput, type Result, type Workspace } from '../features/contexts/model';
import { contextsNavigation } from '../features/contexts/navigation';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

function WorkspaceStory({ scenario = 'directory' }: { scenario?: Scenario | 'loading' | 'search-empty' }) {
  const fixture = useMemo(
    () => contextFixture(scenario === 'loading' || scenario === 'search-empty' ? 'directory' : scenario),
    [scenario],
  );
  const locale = getLocale();
  const input = directoryInput({
    deleted: scenario === 'deleted',
    query: scenario === 'search-empty' ? 'No matches' : '',
  });
  const [directory, setDirectory] = useState(() => fixture.initialDirectory(input));
  const [detail, setDetail] = useState<Result<Workspace>>(() => fixture.initialDetail());
  const [creation, setCreation] = useState(() => fixture.initialCreation());
  const create = scenario === 'create' || scenario === 'create-denied';
  const list = ['directory', 'empty', 'search-empty', 'loading', 'unavailable', 'stale'].includes(scenario);
  const readDetail = async () => setDetail(await fixture.api.detail(fixture.id));
  return (
    <PatternStory
      path={create ? '/my/contexts/new' : list ? '/my/contexts' : `/my/contexts/${fixture.id}`}
      visitor="Signed In"
    >
      <AppShell navigation={contextsNavigation}>
        {create ? (
          <ContextCreateView
            locale={locale}
            actions={creation}
            reload={async () => setCreation(await fixture.api.creation())}
            submit={fixture.api.submit}
          />
        ) : list ? (
          <ContextDirectoryView
            locale={locale}
            input={input}
            data={scenario === 'loading' ? null : directory}
            reload={async () => setDirectory(await fixture.api.list(input))}
          />
        ) : (
          <ContextDetailView
            id={fixture.id}
            locale={locale}
            data={detail}
            reload={readDetail}
            submit={async (command) => {
              const result = await fixture.api.submit(command);
              if (result.kind === 'confirmed') setDetail(result.current);
              else await readDetail();
              return result;
            }}
            search={async () => [
              {
                id: '018f1234-5678-7000-8000-000000000022',
                title: 'Kokoro',
                types: ['core:book'],
                typeLabel: 'Book',
                cover: null,
              },
            ]}
          />
        )}
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  id: 'context-workspace',
  title: 'Pages/Contexts/Editorial workspace',
  component: WorkspaceStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Synthetic native DTO and agreed directory/lifecycle responses, scoped to each story. Review every behavior at phone390 and desktop1280 using viewport globals, all eight locale globals and both themes. No native or visual acceptance is claimed.',
      },
    },
  },
} satisfies Meta<typeof WorkspaceStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Directory: Story = {};
export const Empty: Story = { args: { scenario: 'empty' } };
export const SearchEmpty: Story = { args: { scenario: 'search-empty' } };
export const Loading: Story = { args: { scenario: 'loading' } };
export const Unavailable: Story = { args: { scenario: 'unavailable' } };
export const StaleCursor: Story = { args: { scenario: 'stale' } };
export const Create: Story = { args: { scenario: 'create' } };
export const CreateDenied: Story = { args: { scenario: 'create-denied' } };
export const Active: Story = { args: { scenario: 'active' } };
export const Global: Story = { args: { scenario: 'global' } };
export const ReadOnly: Story = { args: { scenario: 'read-only' } };
export const PermissionUnavailable: Story = { args: { scenario: 'permission-unavailable' } };
export const Deleted: Story = { args: { scenario: 'deleted' } };
export const Revoked: Story = { args: { scenario: 'revoked' } };
export const Expired: Story = {
  args: { scenario: 'expired' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement, true);
    expect(await within(canvasElement).findByText(m.ctxw_conflict())).toBeVisible();
  },
};
export const RetentionHold: Story = {
  args: { scenario: 'hold' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement, true);
    expect(await within(canvasElement).findByText(m.ctxw_conflict())).toBeVisible();
  },
};

async function confirmLifecycle(canvasElement: HTMLElement, restore = false) {
  const label = restore ? m.ctxw_restore() : m.ctxw_delete();
  await userEvent.click(await within(canvasElement).findByRole('button', { name: label }));
  const dialog = await within(document.body).findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('button', { name: label }));
}
export const Delete: Story = {
  args: { scenario: 'active' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement);
    expect(await within(canvasElement).findByText(m.ctxw_deleted_help())).toBeVisible();
  },
};
export const Restore: Story = {
  args: { scenario: 'deleted' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement, true);
    expect(await within(canvasElement).findByRole('heading', { name: m.ctxw_settings() })).toBeVisible();
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement);
    expect(await within(canvasElement).findByText(m.ctxw_conflict())).toBeVisible();
  },
};
export const UnknownOutcome: Story = {
  args: { scenario: 'unknown' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement);
    await userEvent.click(await within(canvasElement).findByRole('button', { name: m.ctxw_retry_same() }));
    expect(await within(canvasElement).findByText(m.ctxw_deleted_help())).toBeVisible();
  },
};
export const ConfirmedRereadUnavailable: Story = {
  args: { scenario: 'reread-unavailable' },
  play: async ({ canvasElement }) => {
    await confirmLifecycle(canvasElement);
    expect(await within(canvasElement).findByText(m.ctxw_confirmed())).toBeVisible();
    expect(within(canvasElement).queryByText('Readers’ selections')).toBeNull();
  },
};
