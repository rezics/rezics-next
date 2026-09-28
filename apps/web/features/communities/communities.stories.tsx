import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreateCommunityForm } from './create-form.tsx';

const meta = {
  title: 'Communities/Create community',
  component: CreateCommunityForm,
  parameters: { route: { pathname: '/en/r/new' } },
  args: { actingSubject: 'https://rezics.com/id/00000000-0000-8000-8000-000000000412', locale: 'en' },
} satisfies Meta<typeof CreateCommunityForm>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NewCommunity: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox', { name: 'Community name' }), 'Readers Circle');
    await userEvent.type(canvas.getByRole('textbox', { name: /Community handle/ }), 'readers-circle');
    await userEvent.type(canvas.getByRole('textbox', { name: 'Description' }), 'Discuss favorite books together.');
    await userEvent.click(canvas.getByRole('radio', { name: /Restricted/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Add a rule' }));
    await expect(canvas.getByRole('textbox', { name: 'Rule title' })).toBeVisible();
    await expect(canvas.getByText('You decide who can join and post.')).toBeVisible();
  },
};

export const Chinese: Story = { args: { locale: 'zh-Hans' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: '社区名称' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '创建社区' })).toBeVisible();
  } };
