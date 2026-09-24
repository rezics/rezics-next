import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { WorkDetail } from './work-detail.tsx';
import { work as english } from '../../i18n/en.ts';
import { work as chinese } from '../../i18n/zh-CN.ts';

const revision = '4b3ac708-b3c8-4f14-88cb-1c0ce8793337';
const meta = { title: 'Work/Exact revision', component: WorkDetail,
  args: { revision, messages: english, work: { title: 'Notes on a City of Rivers', language: 'en',
    work: 'https://rezics.com/id/920813ee-3855-42be-84bb-88da77a5b247',
    mainVersion: 'https://rezics.com/id/ca599d45-9553-48e6-9772-bdb20f561562',
    operation: 'create', sourcePosition: { sequence: '42' } } },
} satisfies Meta<typeof WorkDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Notes on a City of Rivers' })).toBeInTheDocument();
    await expect(canvas.getByText('42')).toBeInTheDocument();
  },
};

export const LongMultilingualTitle: Story = {
  args: { work: { ...meta.args.work,
    title: '都市と川の記録 — Research notes and reflections across languages and regions',
    language: 'ja' } },
};

export const Chinese: Story = {
  args: { messages: chinese },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '修订详情' })).toBeInTheDocument();
    await expect(canvas.getByText('全局视角')).toBeInTheDocument();
  },
};
