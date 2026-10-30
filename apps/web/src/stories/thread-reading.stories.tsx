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
export const Populated: Story = Reading.Populated;
export const SignedOut: Story = Reading.SignedOut;
export const Community: Story = Reading.Community;
export const ExistingReplyRelationship: Story = Reading.ExistingReplyRelationship;
export const SelectedParent: Story = Reading.SelectedParent;
export const CancelledParent: Story = Reading.CancelledParent;
export const DeletedPost: Story = Reading.DeletedPost;
export const DeletedOrganization: Story = Reading.DeletedOrganization;
export const WithheldPost: Story = Reading.WithheldPost;
export const OwnEdit: Story = Reading.OwnEdit;
export const History: Story = Reading.History;
export const Report: Story = Reading.Report;
export const Loading: Story = Reading.Loading;
export const Unavailable: Story = Reading.Unavailable;
export const CurrentDenial: Story = Reading.CurrentDenial;
