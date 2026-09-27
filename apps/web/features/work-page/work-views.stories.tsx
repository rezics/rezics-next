import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { HistoryRegion } from './history.tsx';
import { messages } from './messages.ts';
import { PendingView } from './pending-view.tsx';
import type { WorkTab } from './route.ts';
import type { WorkHeader } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { WorkFrame } from './work-frame.tsx';
import { WorkNotFound, WorkSkeleton, WorkUnavailable, WorkViewSkeleton } from './work-states.tsx';

/** A Work view inside the header and tabs, as the `/w/[ref]` layout renders it. */
function Framed({ work = fixture.work, locale = 'en', children }: {
  work?: WorkHeader; locale?: UiLocale; children: ReactNode;
}) {
  return <WorkFrame workRef={fixture.workRef} work={work} locale={locale} messages={messages[locale]}
    credits={<WorkCredits credits={fixture.credits} locale={locale} messages={messages[locale]} />}>
    {children}</WorkFrame>;
}

const at = (tab: WorkTab, search = '') => ({ route: { pathname: `/w/${fixture.workRef}/${tab}`, search } });

const meta = {
  title: 'Work page/Views',
  component: Framed,
  args: { children: null },
} satisfies Meta<typeof Framed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Versions: Story = {
  parameters: at('versions'),
  render: () => <Framed><VersionsRegion versions={fixture.versions} workRef={fixture.workRef} query={{}}
    locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Versions' })).toHaveAttribute('aria-current', 'page');
    const region = canvas.getByRole('region', { name: 'Versions' });
    await expect(region).toHaveTextContent('4 on this page');
    const items = within(region).getAllByRole('listitem');
    await expect(items).toHaveLength(4);
    await expect(items[0]).toHaveTextContent('Main Version');
    await expect(items[3]).toHaveTextContent('Fixed release');
    await expect(within(region).getByRole('link', { name: 'Next page' }))
      .toHaveAttribute('href', `/w/${fixture.workRef}/versions?cursor=next-page-cursor`);
    const filters = within(region).getByRole('form', { name: 'Filter versions' });
    await expect(filters).toHaveAttribute('action', `/w/${fixture.workRef}/versions`);
    await expect(within(filters).getByRole('combobox', { name: 'Kind' })).toHaveValue('');
  },
};

export const VersionsFiltered: Story = {
  parameters: at('versions', 'kind=release&language=ja'),
  render: () => <Framed><VersionsRegion versions={fixture.noVersions} workRef={fixture.workRef}
    query={{ kind: 'release', language: 'ja' }} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No versions match these filters' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Kind' })).toHaveValue('release');
    await expect(canvas.getAllByRole('link', { name: 'Clear filters' })[0]).toHaveAttribute('href', `/w/${fixture.workRef}/versions`);
  },
};

export const VersionsMetadataOnly: Story = {
  parameters: at('versions'),
  render: () => <Framed work={fixture.metadataOnlyWork}><VersionsRegion versions={fixture.noVersions}
    workRef={fixture.workRef} query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'No published versions yet' })).toBeVisible();
  },
};

export const VersionsListChanged: Story = {
  parameters: at('versions', 'cursor=stale&language=en'),
  render: () => <Framed><VersionsRegion versions={{ ok: false, failure: 'moved' }} workRef={fixture.workRef}
    query={{ language: 'en', cursor: 'stale' }} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('This list changed while you were reading it.');
    await expect(within(alert).getByRole('link', { name: 'First page' }))
      .toHaveAttribute('href', `/w/${fixture.workRef}/versions?language=en`);
  },
};

export const VersionsUnavailable: Story = {
  parameters: at('versions'),
  render: () => <Framed><VersionsRegion versions={{ ok: false, failure: 'unavailable' }} workRef={fixture.workRef}
    query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Versions unavailable');
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  },
};

export const VersionsChinesePhone: Story = {
  parameters: at('versions'),
  globals: { locale: 'zh-CN', viewport: { value: 'phone' } },
  render: () => <Framed work={fixture.cjkWork} locale="zh-CN"><VersionsRegion versions={fixture.versions}
    workRef={fixture.workRef} query={{}} locale="zh-CN" messages={messages['zh-CN']} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: '版本' });
    await expect(within(region).getAllByRole('listitem')[1]).toHaveTextContent('日语');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const History: Story = {
  parameters: at('history'),
  render: () => <Framed><HistoryRegion history={fixture.history} workRef={fixture.workRef} cursor={undefined}
    locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'History' });
    await expect(region).toHaveTextContent('A chronological history is on its way.');
    await expect(within(region).getAllByRole('listitem')).toHaveLength(3);
    await expect(within(region).getByText('Current')).toBeVisible();
    await expect(within(region).getAllByRole('link', { name: 'View revision' })[0])
      .toHaveAttribute('href', `/works/${fixture.work.revision.slice(-36)}`);
  },
};

export const HistoryUnavailable: Story = {
  parameters: at('history'),
  render: () => <Framed><HistoryRegion history={{ ok: false, failure: 'unavailable' }} workRef={fixture.workRef}
    cursor={undefined} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('History unavailable');
  },
};

export const Contents: Story = {
  parameters: at('contents'),
  render: () => <Framed><PendingView view="contents" workRef={fixture.workRef} messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('heading', { name: 'Contents aren’t available yet' })).toBeVisible();
    await expect(canvas.getAllByRole('link', { name: 'Versions' })[1]).toHaveAttribute('href', `/w/${fixture.workRef}/versions`);
  },
};

export const Discussion: Story = {
  parameters: at('discussion'),
  globals: { theme: 'dark' },
  render: () => <Framed><PendingView view="discussion" workRef={fixture.workRef} messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Discussion isn’t available yet' })).toBeVisible();
  },
};

export const NotFound: Story = {
  render: () => <WorkNotFound messages={messages.en} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Work not found' })).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => <WorkUnavailable messages={messages.en} />,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('This Work can’t be shown right now');
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  },
};

export const Loading: Story = {
  render: () => <WorkSkeleton label={messages.en.loading} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading the Work…' })).toBeInTheDocument();
  },
};

export const LoadingView: Story = {
  parameters: at('versions'),
  render: () => <Framed><WorkViewSkeleton label={messages.en.loadingRegion} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  },
};
