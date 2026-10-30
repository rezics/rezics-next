import type { Meta, StoryObj } from '@storybook/react-vite';
import { ErasureProgressView } from '../../accounts/erasure-progress/view';
import type { ErasureStatus, Page } from '../../accounts/erasure-progress/data';

const meta = {
  title: 'Pages/Account/Erasure progress',
  component: ErasureProgressView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Illustrative consumer states only. These stories provide no native erasure or participant proof.',
      },
    },
  },
} satisfies Meta<typeof ErasureProgressView>;
export default meta;
type Story = StoryObj<typeof meta>;
const value: ErasureStatus = {
  accountId: '019a0000-0000-7000-8000-000000000001',
  state: 'pending',
  at: '2026-10-01T10:00:00.000Z',
  completedAt: null,
  pendingParticipants: ['auth', 'shared-history'],
  retentionOutstanding: false,
  lateItems: true,
  effectsFrontier: true,
};
const ready = (value: ErasureStatus): Page => ({
  status: 'ready',
  viewerId: '019a0000-0000-7000-8000-000000000002',
  value,
});
export const Pending: Story = { args: { page: ready(value) } };
export const MissingParticipantProof: Story = {
  args: { page: ready({ ...value, pendingParticipants: [], lateItems: false, effectsFrontier: false }) },
};
export const RetentionOutstanding: Story = {
  args: {
    page: ready({
      ...value,
      state: 'retention-outstanding',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      retentionOutstanding: true,
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Complete: Story = {
  args: {
    page: ready({
      ...value,
      state: 'complete',
      completedAt: '2026-10-02T10:00:00.000Z',
      pendingParticipants: [],
      lateItems: false,
      effectsFrontier: false,
    }),
  },
};
export const Missing: Story = { args: { page: { status: 'missing' } } };
export const Denied: Story = { args: { page: { status: 'denied' } } };
export const SignedOut: Story = { args: { page: { status: 'signed-out' } } };
export const Unavailable: Story = { args: { page: { status: 'unavailable' } } };
export const Loading: Story = { args: { page: { status: 'loading' } } };
