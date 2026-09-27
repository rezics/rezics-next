import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card, CardContent } from '@rezics/ui/card';
import { expect, within } from 'storybook/test';
import { AgentPicker } from './agent-picker.tsx';
import { PageContainer } from '../shell/page.tsx';
import { messages } from './messages.ts';

const ada = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
const pen = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
const gone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';

const meta = { title: 'Auth/Agent picker', component: AgentPicker,
  args: { options: [{ iri: pen, label: null, path: 'represented-agent' },
    { iri: ada, label: null, path: 'direct-principal' }], current: null, preferred: null,
  preferenceRevision: null, next: '/studio', notice: null, messages: messages.en },
  decorators: [Story => <PageContainer className="max-w-xl sm:py-12"><Card><CardContent><Story /></CardContent></Card></PageContainer>],
} satisfies Meta<typeof AgentPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ChooseAnAgent: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const radios = canvas.getAllByRole('radio');
    await expect(radios).toHaveLength(2);
    for (const radio of radios) await expect(radio).not.toBeChecked();
    await expect(canvas.getByRole('radio', { name: /Agent 1e1489d5/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Use this Agent' })).toBeInTheDocument();
  },
};

export const CurrentAndDefault: Story = {
  args: { current: pen, preferred: ada, preferenceRevision: 'b1e8a1d0-1c1e-4b8a-9f3e-2a1b3c4d5e6f' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: /Agent 1e1489d5/ })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: /Agent 1e1489d5/ })).toHaveAccessibleName(/Current/);
    await expect(canvas.getByRole('radio', { name: /Agent b8df6385/ })).toHaveAccessibleName(/Default/);
  },
};

export const AgentNoLongerAvailable: Story = {
  args: { notice: { kind: 'ineligible', previous: gone } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Agent 00000000');
    for (const radio of canvas.getAllByRole('radio')) await expect(radio).not.toBeChecked();
  },
};

export const StaleDefault: Story = {
  args: { current: ada, notice: { kind: 'stale-default' } },
};

export const NoAgents: Story = {
  args: { options: [] },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('cannot act as any Agent');
    await expect(canvas.queryByRole('button')).toBeNull();
  },
};

export const Unavailable: Story = {
  args: { options: null, notice: { kind: 'unavailable' } },
};

export const Chinese: Story = {
  args: { messages: messages['zh-CN'], current: ada },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '选择您的操作身份' })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: '使用此身份' })).toBeInTheDocument();
  },
};
