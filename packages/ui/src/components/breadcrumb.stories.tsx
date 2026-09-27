import type { Meta, StoryObj } from '@storybook/react-vite';
import { SlashIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './breadcrumb.tsx';

const meta = {
  title: 'Rezics UI/Breadcrumb',
  component: Breadcrumb,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      description: {
        component:
          'Shows where a page sits in the hierarchy and links back up it: Realms › Hard SF › Discussions › a thread, or Works › The Three-Body Problem › Editions. The last item is the current page (`aria-current="page"`) and is not a link. Collapse middle levels with an ellipsis on narrow screens rather than letting the trail wrap onto several lines.',
      },
    },
  },
} satisfies Meta<typeof Breadcrumb>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Breadcrumb {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#realms">Realms</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="#hard-sf">Hard SF</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="#discussions">Discussions</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Is the dark forest still convincing?</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Breadcrumb' });
    await expect(within(nav).getAllByRole('link')).toHaveLength(3);
    await expect(within(nav).getByText('Is the dark forest still convincing?')).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const FocusLink: Story = {
  render: Default.render,
  async play({ canvasElement }) {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('link', { name: 'Realms' })).toHaveFocus();
  },
};

export const Collapsed: Story = {
  render: (args) => (
    <Breadcrumb {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#works">Works</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbEllipsis />
          <span className="sr-only">Remembrance of Earth’s Past, The Three-Body Problem</span>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="#editions">Editions</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Tor, 2014 (translated by Ken Liu)</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
};

export const CustomSeparator: Story = {
  render: (args) => (
    <Breadcrumb {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#me">@ye_wenjie</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator>
          <SlashIcon />
        </BreadcrumbSeparator>
        <BreadcrumbItem>
          <BreadcrumbLink href="#shelves">Shelves</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator>
          <SlashIcon />
        </BreadcrumbSeparator>
        <BreadcrumbItem>
          <BreadcrumbPage>Want to read</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
};

export const LongTitle: Story = {
  render: (args) => (
    <div className="max-w-sm">
      <Breadcrumb {...args}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#realms">Realms</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink href="#circle">Chinese Science Fiction Readers’ Circle</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>
              Week 3 of the reading group: chapters 12 to 18, the Red Coast base and the first reply
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  ),
};

export const Chinese: Story = {
  render: (args) => (
    <Breadcrumb aria-label="面包屑导航" {...args}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="#works">作品</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="#santi">《三体》</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>版本（12）</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('navigation', { name: '面包屑导航' })).toBeVisible();
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
