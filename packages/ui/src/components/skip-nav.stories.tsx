import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import { SkipNavContent, SkipNavLink } from './skip-nav.tsx';

const meta = {
  title: 'Rezics UI/Skip Nav',
  component: SkipNavLink,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    padded: false,
    docs: {
      description: {
        component:
          'A “Skip to content” link that stays hidden until the first Tab press, so keyboard and screen-reader readers can jump past the header and navigation straight to the page’s main content. Put `SkipNavLink` first in the document and wrap the main region in `SkipNavContent`; every REZICS page shell needs exactly one pair.',
      },
    },
  },
} satisfies Meta<typeof SkipNavLink>;
export default meta;
type Story = StoryObj<typeof meta>;

const Page = (props: { label?: string; skip?: React.ReactNode }) => (
  <>
    <SkipNavLink>{props.skip}</SkipNavLink>
    <header className="flex items-center gap-6 border-b px-6 py-4">
      <span className="font-semibold tracking-[0.3em]">REZICS</span>
      <nav aria-label={props.label ?? 'Main'} className="flex gap-4 text-sm">
        <a href="#discover">Discover</a>
        <a href="#realms">Realms</a>
        <a href="#shelves">Shelves</a>
        <a href="#inbox">Inbox</a>
      </nav>
    </header>
    <SkipNavContent className="p-6">
      <main>
        <h1 className="font-heading font-semibold text-2xl">The Three-Body Problem</h1>
        <p className="text-muted-foreground text-sm">Liu Cixin · 2006 · Hard SF readers rate it 4.3</p>
      </main>
    </SkipNavContent>
  </>
);

export const Hidden: Story = {
  render: () => <Page />,
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Skip to content' });
    await expect(link).toHaveClass('sr-only');
  },
};

export const Focused: Story = {
  render: () => <Page />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  },
};

/** The link targets the focusable content wrapper; following it moves focus past the header. */
export const SkipTarget: Story = {
  render: () => <Page />,
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: 'Skip to content' });
    const target = canvasElement.querySelector(link.getAttribute('href') ?? '');
    await expect(target).toContainElement(
      within(canvasElement).getByRole('heading', { name: 'The Three-Body Problem' }),
    );
    await expect(target).toHaveAttribute('tabindex', '-1');
  },
};

export const Chinese: Story = {
  render: () => <Page label="主导航" skip="跳到正文" />,
  async play({ canvasElement }) {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('link', { name: '跳到正文' })).toHaveFocus();
  },
};

export const Dark: Story = {
  ...Focused,
  parameters: { theme: 'dark', padded: false },
};
