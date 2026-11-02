import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths } from './page';
import { AuthorErasurePreview } from './patterns/author-erasure/author-erasure-preview';
import * as Erasure from './patterns/author-erasure/author-erasure.stories';

const meta = {
  ...Erasure.default,
  title: 'Pages/Community/Author erasure',
  component: AuthorErasurePreview,
  args: { shell: true },
} satisfies Meta<typeof AuthorErasurePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentAdmissionUnavailable: Story = { ...Erasure.CurrentAdmissionUnavailable };
export const EnqueueLostResponse: Story = { ...Erasure.EnqueueLostResponse };
export const RunningCounters: Story = { ...Erasure.RunningCounters };
export const TerminalPermissionDenial: Story = { ...Erasure.TerminalPermissionDenial };
export const Completed: Story = { ...Erasure.Completed };

export const CurrentAdmissionAvailable: Story = { ...Erasure.CurrentAdmissionAvailable };
export const CurrentAdmissionDenied: Story = { ...Erasure.CurrentAdmissionDenied };
export const AcceptedProgress: Story = { ...EnqueueLostResponse, name: 'Accepted progress after exact retry' };
export const SignedOutReader: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths['thread-owned']} />,
  parameters: {
    docs: {
      description: {
        story:
          'The recorded owned-thread page shown to a signed-out reader. It provides no author-erasure control or native authorization proof.',
      },
    },
  },
};
export const TerminalPermissionPhone390: Story = {
  ...TerminalPermissionDenial,
  name: 'Permission stopped · phone 390',
  parameters: { viewport: { defaultViewport: 'phone390' } },
};
export const TerminalPermissionDesktop1280: Story = {
  ...TerminalPermissionDenial,
  name: 'Permission stopped · desktop 1280',
  parameters: { viewport: { defaultViewport: 'desktop1280' } },
};
