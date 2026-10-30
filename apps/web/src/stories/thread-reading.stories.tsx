import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThreadReadingPreview } from './patterns/thread-reading/thread-reading-preview';
import * as Reading from './patterns/thread-reading/thread-reading.stories';

const meta = {
  ...Reading.default,
  title: 'Pages/Community/Thread reading',
  component: ThreadReadingPreview,
  args: { shell: true },
} satisfies Meta<typeof ThreadReadingPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {
  ...Reading.Populated,
  play: async (context) => Reading.Populated.play!(context),
};
export const SignedOut: Story = {
  ...Reading.SignedOut,
  play: async (context) => Reading.SignedOut.play!(context),
};
export const Community: Story = { ...Reading.Community };
export const ExistingReplyRelationship: Story = {
  ...Reading.ExistingReplyRelationship,
  play: async (context) => Reading.ExistingReplyRelationship.play!(context),
};
export const SelectedParent: Story = {
  ...Reading.SelectedParent,
  play: async (context) => Reading.SelectedParent.play!(context),
};
export const CancelledParent: Story = {
  ...Reading.CancelledParent,
  play: async (context) => Reading.CancelledParent.play!(context),
};
export const DeletedPost: Story = { ...Reading.DeletedPost };
export const DeletedOrganization: Story = {
  ...Reading.DeletedOrganization,
  play: async (context) => Reading.DeletedOrganization.play!(context),
};
export const WithheldPost: Story = { ...Reading.WithheldPost };
export const OwnEdit: Story = {
  ...Reading.OwnEdit,
  play: async (context) => Reading.OwnEdit.play!(context),
};
export const History: Story = {
  ...Reading.History,
  play: async (context) => Reading.History.play!(context),
};
export const Report: Story = {
  ...Reading.Report,
  play: async (context) => Reading.Report.play!(context),
};
export const Loading: Story = { ...Reading.Loading };
export const Unavailable: Story = { ...Reading.Unavailable };
export const CurrentDenial: Story = { ...Reading.CurrentDenial };

export const RestorablePost: Story = {
  ...Reading.RestorablePost,
  play: async (context) => Reading.RestorablePost.play!(context),
};
