import type { Meta, StoryObj } from '@storybook/react-vite';
import { MineFollowingPageView } from '../library/mine-following-page';

const meta = { title: 'Pages/Library/Following kind navigation', component: MineFollowingPageView,
  parameters: { layout: 'fullscreen' },
  args: { page: { signedIn: true, follows: [], next: null, kindUnavailable: true }, kind: 'space' },
} satisfies Meta<typeof MineFollowingPageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {};
export const PhoneUnavailable: Story = { globals: { viewport: { value: 'phone390', isRotated: false } } };
