import type { Meta, StoryObj } from '@storybook/react-vite';
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
