import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreatorEditionsExample } from './patterns/creator-editions/creator-editions-fixtures';
import * as pattern from './patterns/creator-editions/creator-editions.stories';

const meta = {
  title: 'Content/CreatorEditions Page',
  id: 'pages-content-creatoreditions',
  component: CreatorEditionsExample,
  parameters: { layout: 'fullscreen' },
  args: { state: 'editions', shell: true },
} satisfies Meta<typeof CreatorEditionsExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editions: Story = { ...pattern.Editions };
export const Sparse: Story = { ...pattern.Sparse };
export const Denied: Story = { ...pattern.Denied };
export const Unavailable: Story = { ...pattern.Unavailable };
export const Empty: Story = { ...pattern.Empty };
export const Loading: Story = { ...pattern.Loading };
export const SignIn: Story = { ...pattern.SignIn };
