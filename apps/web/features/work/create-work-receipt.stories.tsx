import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CreateWorkReceipt } from '../../app/studio/create-work-receipt.tsx';
import { studio as english } from '../../i18n/en.ts';
import { studio as chinese } from '../../i18n/zh-CN.ts';

const receipt = {
  work: 'https://rezics.com/id/57c86232-6db4-4b0d-aa56-e4ad584d07b4',
  mainVersion: 'https://rezics.com/id/e7137ee6-7208-44ac-99bd-31b4ad608709',
  workRevision: 'https://rezics.com/id/66bdf11c-5f26-402f-9614-4e5c5fc9f9ca',
  mainRevision: 'https://rezics.com/id/480c6271-112a-405a-8d8e-5ca4ad46ce45',
  sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '42' },
};
const meta = { title: 'Studio/Work created', component: CreateWorkReceipt,
  decorators: [Story => <main className="page-width"><div className="auth-layout"><Story /></div></main>],
  args: { title: 'Notes on a City of Rivers', receipt, messages: english },
} satisfies Meta<typeof CreateWorkReceipt>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Standard: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Work created' })).toBeInTheDocument();
    await expect(canvas.getByText('42')).toBeInTheDocument();
  },
};

export const LongMultilingualTitle: Story = {
  args: { title: '都市と川の記録 — Research notes and reflections across languages and regions' },
};

export const Chinese: Story = {
  args: { title: '城市与河流笔记', messages: chinese },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: '作品已创建' })).toBeInTheDocument();
    await expect(canvas.getByText('主版本')).toBeInTheDocument();
  },
};
