import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { BooksTwoDeviceRecorded } from './books-two-device-recorded-page.tsx';
import { deviceBook } from './books-two-device-recorded-page.ts';

const meta = {
  title: 'Library/Recorded books two devices', component: BooksTwoDeviceRecorded,
  args: { persona: 'owner', phase: 'winning' },
  parameters: { controls: { disable: true }, route: { pathname: '/en/library', query: { shelf: 'read', view: 'grid' } } },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof BooksTwoDeviceRecorded>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { globals: { viewport: { value: 'phone' as const } } };

async function ownerPosition(canvasElement: HTMLElement, recovered: boolean) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: 'Library' })).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 3, name: 'Original outcome volume' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Original outcome volume' })).toHaveAttribute('href', `/w/${deviceBook()}`);
  await expect(canvas.getByRole('link', { name: 'Currently reading 1' })).toBeVisible();
  await userEvent.click(canvas.getByText('Your progress', { exact: false }));
  const chapters = within(await canvas.findByRole('region', { name: 'Chapters' }));
  await userEvent.click(await chapters.findByRole('button', { name: 'Chapter 2' }));
  await expect(await chapters.findByLabelText('Position')).toHaveValue(recovered ? '' : 'device one paragraph');
  await expect(chapters.getByText(recovered ? 'Chapter 2 · Not read' : 'Chapter 2 · Read')).toBeVisible();
  await expect(chapters.getByRole('button', { name: recovered ? 'Mark read' : 'Mark not read' })).toBeVisible();
}

/** A second device reads the winning saved position through Library's production chapter control. */
export const OwnerWinning: Story = { play: async ({ canvasElement }) => { await ownerPosition(canvasElement, false); } };
export const OwnerWinningPhone: Story = { ...OwnerWinning, ...phone };

/** A return to Library after the recorded recovery reads version 3, with no retained position. */
export const OwnerRecovered: Story = { args: { phase: 'recovered' },
  play: async ({ canvasElement }) => { await ownerPosition(canvasElement, true); } };
export const OwnerRecoveredPhone: Story = { ...OwnerRecovered, ...phone };

export const OwnerLoading: Story = { args: { loading: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveTextContent('Loading…');
  await expect(canvas.queryByRole('heading', { name: 'Library' })).toBeNull();
} };
export const OwnerLoadingPhone: Story = { ...OwnerLoading, ...phone };

const refused: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: 'This identity has no library' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Choose identity' })).toBeVisible();
  await expect(canvas.queryByDisplayValue('device one paragraph')).toBeNull();
  await expect(canvas.queryByRole('button', { name: 'Chapter 2' })).toBeNull();
};
export const VisitorAuthentication: Story = { args: { persona: 'visitor' }, play: refused };
export const VisitorAuthenticationPhone: Story = { ...VisitorAuthentication, ...phone };
export const StrangerRefused: Story = { args: { persona: 'stranger' }, play: refused };
export const StrangerRefusedPhone: Story = { ...StrangerRefused, ...phone };
export const MemberRefused: Story = { args: { persona: 'member' }, play: refused };
export const MemberRefusedPhone: Story = { ...MemberRefused, ...phone };
export const ModeratorRefused: Story = { args: { persona: 'moderator' }, play: refused };
export const ModeratorRefusedPhone: Story = { ...ModeratorRefused, ...phone };
export const OperatorRefused: Story = { args: { persona: 'operator' }, play: refused };
export const OperatorRefusedPhone: Story = { ...OperatorRefused, ...phone };
