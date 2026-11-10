import type { Meta, StoryObj } from '@storybook/react-vite';
import { LiteraryReader } from '../features/catalogue/literary-reader/view';
import { literaryWorkExample } from '../features/catalogue/literary-reader/examples';

const meta = {
  title: 'Subjects/Literary work',
  id: 'pages-subjects-literary-work',
  component: LiteraryReader,
  args: literaryWorkExample,
} satisfies Meta<typeof LiteraryReader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WorkWithTwoTitles: Story = {};
