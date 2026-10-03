import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AuthorSection } from './author.tsx';
import { messages } from './messages.ts';
import { profileHref } from '../profile/route.ts';
import { storyId, noWorks } from '../profile/fixtures.ts';

const meta = {
  title: 'Work page/Author',
  component: AuthorSection,
  args: {
    author: {
      kind: 'agent',
      name: 'Lin Mei 林梅',
      handle: 'lin_mei',
      agent: storyId(1),
      works: { ok: true, data: noWorks },
    },
    work: storyId(101),
    locale: 'en',
    messages: messages.en,
  },
} satisfies Meta<typeof AuthorSection>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NamedPerson: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('@lin_mei')).toBeVisible();
    await expect(canvas.getByRole('link', { name: /Lin Mei 林梅/ })).toHaveAttribute(
      'href',
      `/en${profileHref('lin_mei')}`,
    );
  },
};

export const UnnamedPerson: Story = {
  args: {
    author: {
      kind: 'agent',
      name: 'Lin Mei 林梅',
      handle: null,
      agent: storyId(1),
      works: { ok: true, data: noWorks },
    },
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Lin Mei 林梅')).toBeVisible();
    await expect(canvas.queryByText(/^@/)).not.toBeInTheDocument();
    await expect(canvas.getByRole('link', { name: 'Lin Mei 林梅' })).toHaveAttribute(
      'href',
      `/en${profileHref({ id: storyId(1), handle: null })}`,
    );
    await expect(canvas.queryByRole('link', { name: 'Choose a handle' })).not.toBeInTheDocument();
  },
};
