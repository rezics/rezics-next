import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@rezics/ui/shadcn/navigation-menu';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/NavigationMenu',
  component: NavigationMenu,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 360 } } },
} satisfies Meta<typeof NavigationMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

const Menu = ({ disabled }: { disabled?: boolean }) => (
  <NavigationMenu aria-label="Browse">
    <NavigationMenuList>
      <NavigationMenuItem>
        <NavigationMenuTrigger disabled={disabled}>Works</NavigationMenuTrigger>
        <NavigationMenuContent>
          <ul className="grid w-64 gap-1 p-2">
            <li>
              <NavigationMenuLink href="#books">Books</NavigationMenuLink>
            </li>
            <li>
              <NavigationMenuLink href="#recipes">Recipes</NavigationMenuLink>
            </li>
            <li>
              <NavigationMenuLink href="#cjk">轻小说与漫画：长标题作品合集</NavigationMenuLink>
            </li>
          </ul>
        </NavigationMenuContent>
      </NavigationMenuItem>
      <NavigationMenuItem>
        <NavigationMenuLink href="#people">People</NavigationMenuLink>
      </NavigationMenuItem>
    </NavigationMenuList>
  </NavigationMenu>
);

export const Default: Story = {
  render: () => <Menu />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Works' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    const link = await screen.findByRole('link', { name: 'Recipes' });
    await settled(link);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(await screen.findByRole('link', { name: /轻小说与漫画/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Recipes' })).not.toBeInTheDocument());
  },
};

export const PlainLink: Story = {
  render: () => <Menu />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'People' })).toHaveAttribute('href', '#people');
  },
};

export const Disabled: Story = {
  render: () => <Menu disabled />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Works' })).toHaveAttribute('aria-disabled', 'true');
  },
};
