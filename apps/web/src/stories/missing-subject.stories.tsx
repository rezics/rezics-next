import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Subjects/Missing Subject', id: 'pages-subjects-missing-subject', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: pageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['missing-subject']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['missing-subject']} />,
};
