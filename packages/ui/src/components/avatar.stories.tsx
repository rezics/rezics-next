import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { UserIcon } from 'lucide-react';
import { expect, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from './avatar.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div className={cn(parameters.dark && 'dark', 'bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

// Inline portrait so stories never depend on the network.
const portrait = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2f63ad"/><circle cx="32" cy="25" r="12" fill="#e4ecf7"/><rect x="12" y="42" width="40" height="30" rx="15" fill="#e4ecf7"/></svg>',
)}`;

const meta = {
  title: 'Rezics UI/Display/Avatar',
  component: Avatar,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A member, Realm or acting-identity picture with a fallback of initials or an icon on the accent surface. Use it in post bylines, member lists, the top-bar identity switcher and moderation queues. The image needs `alt` text naming the person; a status dot (`AvatarBadge`) is hidden from assistive technology, so state its meaning in nearby text. Group overlapping avatars for participants in a read-along or reviewers of a Work.',
      },
    },
  },
} satisfies Meta<typeof Avatar>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithImage: Story = {
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage alt="Liu Yang" src={portrait} />
      <AvatarFallback>LY</AvatarFallback>
    </Avatar>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('img', { name: 'Liu Yang' })).toBeVisible());
  },
};

export const Fallback: Story = {
  name: 'Fallback (broken image)',
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar>
        <AvatarImage alt="Mara Okafor" src="/missing-avatar.png" />
        <AvatarFallback>MO</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback aria-label="Anonymous reader" role="img">
          <UserIcon aria-hidden />
        </AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback lang="zh-CN">刘</AvatarFallback>
      </Avatar>
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('MO')).toBeVisible());
  },
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Avatar key={size} size={size}>
          <AvatarImage alt={`Liu Yang, ${size}`} src={portrait} />
          <AvatarFallback>LY</AvatarFallback>
        </Avatar>
      ))}
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Avatar key={`fallback-${size}`} size={size}>
          <AvatarFallback>
            <UserIcon aria-hidden />
          </AvatarFallback>
        </Avatar>
      ))}
    </div>
  ),
};

export const WithStatus: Story = {
  render: () => (
    <ul className="flex flex-col gap-3 text-sm">
      {(
        [
          ['success', 'Liu Yang', 'Reading now'],
          ['warning', 'Mara Okafor', 'Away'],
          ['destructive', 'Kenji Arai', 'Suspended by moderators'],
          ['info', 'Sofia Reyes', 'Hosting a read-along'],
        ] as const
      ).map(([variant, name, status]) => (
        <li className="flex items-center gap-3" key={name}>
          <Avatar size="lg">
            <AvatarFallback>{name.split(' ').map((part) => part[0])}</AvatarFallback>
            <AvatarBadge variant={variant} />
          </Avatar>
          <span>
            <span className="block font-medium">{name}</span>
            <span className="text-muted-foreground">{status}</span>
          </span>
        </li>
      ))}
    </ul>
  ),
};

export const Group: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <AvatarGroup>
        <Avatar>
          <AvatarImage alt="Liu Yang" src={portrait} />
          <AvatarFallback>LY</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>MO</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>KA</AvatarFallback>
        </Avatar>
        <AvatarGroupCount aria-label="12 more readers">+12</AvatarGroupCount>
      </AvatarGroup>
      <span className="text-muted-foreground text-sm">15 readers in this read-along</span>
    </div>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: () => (
    <div className="flex items-center gap-4">
      <Avatar size="lg">
        <AvatarImage alt="Liu Yang" src={portrait} />
        <AvatarFallback>LY</AvatarFallback>
        <AvatarBadge variant="success" />
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>MO</AvatarFallback>
        <AvatarBadge variant="warning" />
      </Avatar>
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>KA</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>SR</AvatarFallback>
        </Avatar>
        <AvatarGroupCount aria-label="4 more readers">+4</AvatarGroupCount>
      </AvatarGroup>
    </div>
  ),
};
