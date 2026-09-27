import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { messages } from './messages.ts';
import { WorkDetail, type WorkRevisionDetail, WorkUnavailable } from './work-detail.tsx';
import { WorkDetailSkeleton, WorkNotFound } from './work-states.tsx';

const revision = '4b3ac708-b3c8-4f14-88cb-1c0ce8793337';
const work: WorkRevisionDetail = { title: 'Notes on a City of Rivers', language: 'en',
  work: 'https://rezics.com/id/920813ee-3855-42be-84bb-88da77a5b247',
  mainVersion: 'https://rezics.com/id/ca599d45-9553-48e6-9772-bdb20f561562',
  operation: 'create', sourcePosition: { sequence: '42' } };

const meta = { title: 'Work/Exact revision', component: WorkDetail,
  args: { revision, work, locale: 'en', messages: messages.en },
} satisfies Meta<typeof WorkDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Notes on a City of Rivers' })).toBeVisible();
    await expect(canvas.getByRole('tab', { name: 'Main Version' })).toHaveAttribute('aria-selected', 'true');
    await expect(canvas.getByText('42')).toBeInTheDocument();
  },
};

export const LongMultilingualTitle: Story = {
  args: { work: { ...work, language: 'ja',
    title: '都市と川の記録 — Research notes and reflections across languages, regions and several centuries' } },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '修订详情' })).toBeInTheDocument();
    await expect(canvas.getByText('全局视角')).toBeInTheDocument();
    await expect(canvas.getByText(/此元数据修订的标识为/)).toBeInTheDocument();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const Unavailable: Story = {
  render: () => <WorkUnavailable messages={messages.en} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('This revision is unavailable');
  },
};

export const NotFound: Story = {
  render: () => <WorkNotFound messages={messages.en} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Revision not found' })).toBeVisible();
  },
};

export const Loading: Story = {
  render: () => <WorkDetailSkeleton label={messages.en.loading} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading the revision…' })).toBeInTheDocument();
  },
};
