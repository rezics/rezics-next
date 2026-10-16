import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-threads-and-replies.json';
import { messages } from './messages.ts';
import { RecordedClosureThreads, threadsSample, type ClosureEntry } from './realm-closure-threads-recorded-page.tsx';
import type { ThreadRead } from '../feed/thread.ts';

const record = fixture as AnswerRecord;
const meta = { title: 'Realm/Closed threads recorded', component: RecordedClosureThreads,
  args: { record }, globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedClosureThreads>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { locale: 'en', viewport: { value: 'phone' } };
function concealed(persona: AnswerPersona, entry: ClosureEntry = 'closed-list'): Story {
  return { args: { persona, entry }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: messages.notFoundTitle })).toBeVisible();
    await expect(canvas.getByRole('link', { name: messages.browse })).toBeVisible();
    await expect(canvas.queryByText(/Original member opener|original member descendant|Independent live member opener/)).toBeNull();
    await expect(canvas.queryByText(messages.createPost)).toBeNull();
    await expect(canvasElement.querySelector('[data-zone-frame]')).toBeNull();
  } };
}
export const Visitor = concealed('visitor');
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const Stranger = concealed('stranger', 'closed-thread');
export const Member = concealed('member', 'closed-descendant');
export const MemberPhone: Story = { ...Member, globals: phone };
export const Owner = concealed('owner', 'closed-thread');
export const OwnerPhone: Story = { ...Owner, globals: phone };
export const Moderator = concealed('moderator', 'closed-descendant');
export const Operator = concealed('operator');
export const Absent = concealed('owner', 'absent-list');
function live(entry: ClosureEntry): Story {
  return { args: { entry }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/Independent live member opener/)).toBeVisible();
    const thread = threadsSample(record, 'visitor', 'live-thread-identity').answer as ThreadRead;
    const author = thread.items[0]!.author!;
    await expect(canvas.getAllByRole('link', { name: author.name })[0]).toBeVisible();
    await expect(canvas.queryByText(messages.notFoundTitle)).toBeNull();
    await expect(canvas.queryByText('Couldn’t load relationships.')).toBeNull();
  } };
}
export const LiveList = live('live-list');
export const LiveListPhone: Story = { ...LiveList, globals: phone };
export const LiveThread = live('live-thread');
export const LiveThreadPhone: Story = { ...LiveThread, globals: phone };
export const LiveOwner: Story = { ...LiveThread, args: { entry: 'live-thread', persona: 'owner' } };
export const Loading: Story = { args: { loading: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading')).toBeNull();
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };
