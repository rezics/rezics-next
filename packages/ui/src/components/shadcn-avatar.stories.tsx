import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@rezics/ui/shadcn/avatar';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

const portrait = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#1f3a5f"/><circle cx="32" cy="26" r="12" fill="#cbd5e1"/></svg>',
)}`;

export const Default: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src={portrait} alt="Mira Okafor" />
      <AvatarFallback>MO</AvatarFallback>
    </Avatar>
  ),
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('img', { name: 'Mira Okafor' })).toBeVisible();
  },
};

export const FallbackAndSizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      {(['sm', 'default', 'lg'] as const).map((size) => (
        <Avatar key={size} size={size}>
          <AvatarImage src="/missing-portrait.png" alt="" />
          <AvatarFallback>{size === 'lg' ? '林小雨' : size === 'sm' ? 'A' : 'JK'}</AvatarFallback>
        </Avatar>
      ))}
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('林小雨')).toBeVisible();
    await expect(canvas.getByText('JK')).toBeVisible();
    await expect(canvas.queryByRole('img')).toBeNull();
  },
};

export const WithBadge: Story = {
  render: () => (
    <Avatar size="lg">
      <AvatarImage src={portrait} alt="Mira Okafor, online" />
      <AvatarFallback>MO</AvatarFallback>
      <AvatarBadge />
    </Avatar>
  ),
  async play({ canvasElement }) {
    const avatar = canvasElement.querySelector('[data-slot="avatar"]')!;
    await waitFor(() => expect(avatar.querySelector('[data-slot="avatar-badge"]')).not.toBeNull());
    await expect(await within(canvasElement).findByRole('img', { name: 'Mira Okafor, online' })).toBeVisible();
  },
};

export const Group: Story = {
  render: () => (
    <AvatarGroup>
      {['AB', 'CD', 'EF'].map((initials) => (
        <Avatar key={initials}>
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      ))}
      <AvatarGroupCount>+12</AvatarGroupCount>
    </AvatarGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const text of ['AB', 'CD', 'EF', '+12']) await expect(await canvas.findByText(text)).toBeVisible();
  },
};
