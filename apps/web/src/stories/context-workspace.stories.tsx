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

const longContextTitle = '旅の読者たちと物語を読み続けるための、とても長い多言語の編集コミュニティ';
type WorkspaceScenario = Scenario | 'loading' | 'search-empty' | 'directory-deleted' | 'directory-multilingual';

function WorkspaceStory({ scenario = 'directory' }: { scenario?: WorkspaceScenario }) {
  const fixture = useMemo(
    () =>
      contextFixture(
        scenario === 'directory-deleted'
          ? 'deleted'
          : scenario === 'loading' || scenario === 'search-empty' || scenario === 'directory-multilingual'
            ? 'directory'
            : scenario,
      ),
    [scenario],
  );
  const locale = getLocale();
  const input = directoryInput({
    deleted: scenario === 'deleted' || scenario === 'directory-deleted',
    query: scenario === 'search-empty' ? 'No matches' : '',
  });
  const [directory, setDirectory] = useState(() => {
    const supplied = fixture.initialDirectory(input);
    if (scenario === 'directory-multilingual' && supplied.page.kind === 'ready') {
      supplied.page.value.contexts = supplied.page.value.contexts.flatMap((entry) => [
        { ...entry, labels: { ja: longContextTitle } },
        { ...entry, id: '018f1234-5678-7000-8000-000000000023', labels: { 'zh-Hant': '一起閱讀的讀者' } },
      ]);
    }
    return supplied;
  });
  const [detail, setDetail] = useState<Result<Workspace>>(() => fixture.initialDetail());
  const [creation, setCreation] = useState(() => fixture.initialCreation());
  const create = scenario === 'create' || scenario === 'create-denied';
  const list = [
    'directory',
    'empty',
    'search-empty',
    'loading',
    'unavailable',
    'stale',
    'directory-deleted',
    'directory-multilingual',
  ].includes(scenario);
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
  title: 'Catalogue/Editorial workspace',
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
export const Directory: Story = {
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('list', { name: m.ctxw_title() });
    const heading = within(list).getByRole('heading', { level: 2 });
    const link = within(list).getByRole('link', { name: heading.textContent! });
    await expect(link).toHaveAttribute('aria-labelledby', heading.id);
    link.focus();
    await expect(link).toHaveFocus();
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('link', { name: m.ctxw_next() })).toHaveFocus();
  },
};
export const MultilingualDirectory: Story = {
  args: { scenario: 'directory-multilingual' },
  globals: {},
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('list', { name: m.ctxw_title() });
    const heading = within(list).getByRole('heading', { name: longContextTitle, level: 2 });
    await expect(heading).toHaveAttribute('lang', 'ja');
    const primary = within(list).getByRole('link', { name: longContextTitle });
    primary.focus();
    await expect(primary).toHaveFocus();
    await userEvent.tab();
    await expect(within(list).getByRole('link', { name: '一起閱讀的讀者' })).toHaveFocus();
    await expect(within(list).getByRole('heading', { name: '一起閱讀的讀者' })).toHaveAttribute('lang', 'zh-Hant');
  },
};
export const DeletedDirectory: Story = {
  args: { scenario: 'directory-deleted' },
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getByRole('list', { name: m.ctxw_title() });
    await expect(within(list).getByRole('heading', { level: 2 })).toBeVisible();
    await expect(within(list).getByText(m.ctxw_community() + ' · ' + m.ctxw_deleted())).toBeVisible();
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.ctxw_empty())).toBeVisible();
    await expect(canvas.queryByRole('list', { name: m.ctxw_title() })).toBeNull();
  },
};
export const SearchEmpty: Story = {
  args: { scenario: 'search-empty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.ctxw_no_matches())).toBeVisible();
    await expect(canvas.getByRole('searchbox', { name: m.ctxw_search() })).toHaveValue('No matches');
    await expect(canvas.queryByRole('list', { name: m.ctxw_title() })).toBeNull();
  },
};
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

// Illustrative supplied references only; these examples do not claim native or visual acceptance.
const longSettingsId = `illustrative:settings/${'long-reference-'.repeat(24)}`;
const longRelease = `illustrative-release-${'abcdef0123456789'.repeat(24)}`;
function ReaderExample({
  empty,
  pair = false,
  rtl = false,
}: {
  empty?: 'settings' | 'defaults';
  pair?: boolean;
  rtl?: boolean;
}) {
  const fixture = useMemo(() => contextFixture('read-only'), []);
  const data = useMemo(() => {
    const supplied = fixture.initialDetail();
    if (supplied.kind === 'ready' && supplied.value.context) {
      supplied.value.context.settings = empty === 'settings' ? null : { id: longSettingsId, release: longRelease };
      supplied.value.context.defaults =
        empty === 'defaults'
          ? {}
          : Object.fromEntries(
              Array.from({ length: 64 }, (_, index) => [
                `illustrative:property/${64 - index}/${'long-key-'.repeat(24)}`,
                index % 2 === 0 ? 'inherit' : 'suppress',
              ]),
            );
    }
    return supplied;
  }, [fixture, empty]);
  const locale = getLocale();
  return (
    <PatternStory path={`/my/contexts/${fixture.id}`} visitor="Signed In">
      <AppShell navigation={contextsNavigation}>
        <div dir={rtl ? 'rtl' : 'ltr'} className="space-y-10">
          <ContextDetailView
            id={fixture.id}
            locale={locale}
            data={data}
            submit={fixture.api.submit}
            reload={async () => {}}
          />
          {pair ? (
            <ContextDetailView
              id={fixture.id}
              locale={locale}
              data={data}
              submit={fixture.api.submit}
              reload={async () => {}}
            />
          ) : null}
        </div>
      </AppShell>
    </PatternStory>
  );
}
async function readTechnicalDetails({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getAllByText(m.ctx_reader_settings_selected())[0]).toBeVisible();
  const summary = canvas.getAllByText(m.ctx_reader_settings_details())[0]!;
  const details = summary.closest('details')!;
  await expect(details).not.toHaveAttribute('open');
  await expect(within(details).getByText(longSettingsId)).not.toBeVisible();
  summary.focus();
  await expect(summary).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(within(details).getByText(longSettingsId)).toBeVisible();
  await expect(within(details).getByText(longRelease)).toBeVisible();
  await userEvent.keyboard(' ');
  await expect(details).not.toHaveAttribute('open');
  await userEvent.tab();
  const rule = canvas.getAllByText(m.ctx_reader_rule_reference({ number: 1 }))[0]!;
  await expect(rule).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(within(rule.closest('details')!).getByText(m.ctx_reader_property_key())).toBeVisible();
}
function readerStory(locale: string, viewport: 'phone390' | 'desktop1280', theme: 'light' | 'dark'): Story {
  return {
    render: () => <ReaderExample />,
    globals: { locale },
    play: readTechnicalDetails,
  };
}
export const ReaderEnglishPhone = readerStory('en', 'phone390', 'light');
export const ReaderEnglishDesktop = readerStory('en', 'desktop1280', 'dark');
export const ReaderTraditionalChinesePhone = readerStory('zh-Hant', 'phone390', 'dark');
export const ReaderTraditionalChineseDesktop = readerStory('zh-Hant', 'desktop1280', 'light');
export const ReaderSimplifiedChinesePhone = readerStory('zh-Hans', 'phone390', 'light');
export const ReaderSimplifiedChineseDesktop = readerStory('zh-Hans', 'desktop1280', 'dark');
export const ReaderJapanesePhone = readerStory('ja', 'phone390', 'dark');
export const ReaderJapaneseDesktop = readerStory('ja', 'desktop1280', 'light');
export const ReaderKoreanPhone = readerStory('ko', 'phone390', 'light');
export const ReaderKoreanDesktop = readerStory('ko', 'desktop1280', 'dark');
export const ReaderGermanPhone = readerStory('de', 'phone390', 'dark');
export const ReaderGermanDesktop = readerStory('de', 'desktop1280', 'light');
export const ReaderFrenchPhone = readerStory('fr', 'phone390', 'light');
export const ReaderFrenchDesktop = readerStory('fr', 'desktop1280', 'dark');
export const ReaderSpanishPhone = readerStory('es', 'phone390', 'dark');
export const ReaderSpanishDesktop = readerStory('es', 'desktop1280', 'light');
export const ReaderRtlPhone: Story = {
  ...readerStory('en', 'phone390', 'dark'),
  render: () => <ReaderExample rtl />,
};
export const ReaderRtlDesktop: Story = {
  ...readerStory('en', 'desktop1280', 'light'),
  render: () => <ReaderExample rtl />,
};
export const ReaderNoSettings: Story = { render: () => <ReaderExample empty="settings" /> };
export const ReaderNoDefaults: Story = { render: () => <ReaderExample empty="defaults" /> };
export const IndependentReaders: Story = {
  render: () => <ReaderExample pair />,
  globals: {},
  play: async (context) => {
    await readTechnicalDetails(context);
    const panels = context.canvasElement.querySelectorAll('article');
    await expect(panels).toHaveLength(2);
    await expect(panels[0]!.querySelectorAll('details[open]')).toHaveLength(1);
    await expect(panels[1]!.querySelectorAll('details[open]')).toHaveLength(0);
  },
};
