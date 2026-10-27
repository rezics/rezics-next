import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, libraryEntriesReady, pagePaths } from './page';

const meta = { title: 'Pages/Library/Personal Library', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['library-entries']} />,
};
export const StatusTab: Story = {
  name: 'Status Tab',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?state=in_progress`} />,
};
export const ListLayout: Story = {
  name: 'List Layout',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=list`} />,
};
export const TableLayout: Story = {
  name: 'Table Layout',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?layout=table`} />,
};
export const SmallGrid: Story = {
  name: 'Small Grid',
  play: libraryEntriesReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['library-entries']}?size=s`} />,
};
