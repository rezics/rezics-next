import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-roster.json';
import { resourceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { messages } from './messages.ts';
import { RecordedClosureRoster, rosterSample } from './realm-closure-roster-recorded-page.tsx';
import type { RealmHeader, RealmRoster } from './types.ts';

const record = fixture as AnswerRecord;
const meta = { title: 'Realm/Closed roster recorded', component: RecordedClosureRoster,
  args: { record }, globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedClosureRoster>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { locale: 'en', viewport: { value: 'phone' } };

function concealed(persona: AnswerPersona): Story {
  return { args: { persona, retained: true }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: messages.notFoundTitle })).toBeVisible();
    await expect(canvas.getByRole('link', { name: messages.browse })).toBeVisible();
    const roster = rosterSample(record, persona, 'live-roster').answer as RealmRoster;
    for (const member of roster.items) {
      await expect(canvas.queryByText(member.displayName!)).toBeNull();
      await expect(canvasElement.querySelector(`a[href="${resourceHref('/a/', member.agent)}"]`)).toBeNull();
    }
    await expect(canvas.queryByText(messages.featured)).toBeNull();
    await expect(canvas.queryByText(messages.membersTitle)).toBeNull();
    await expect(canvas.queryByText(messages.showMore)).toBeNull();
    await expect(canvasElement.querySelector('[data-zone-frame]')).toBeNull();
  } };
}

function live(persona: AnswerPersona): Story {
  return { args: { persona, live: true }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const header = rosterSample(record, persona, 'live-page-header').answer as RealmHeader;
    const roster = rosterSample(record, persona, 'live-page-roster').answer as RealmRoster;
    await expect(await canvas.findByRole('heading', { level: 1, name: header.name.value })).toBeVisible();
    await expect(header.originalName?.value).toBe(header.name.value);
    for (const member of roster.items) {
      const identity = await canvas.findByRole('link', { name: new RegExp(member.displayName!) });
      await expect(identity).toBeVisible();
      await expect(identity).toHaveAttribute('href', localizedPath(resourceHref('/a/', member.agent), 'en'));
    }
    await expect(canvas.getByText(messages.featured)).toBeVisible();
    await expect(canvas.getAllByText(messages.featured)).toHaveLength(1);
    await expect(canvas.queryByText(messages.notFoundTitle)).toBeNull();
    await expect(canvas.queryByRole('link', { name: messages.showMore })).toBeNull();
  } };
}

export const ConcealedVisitor = concealed('visitor');
export const ConcealedVisitorPhone: Story = { ...ConcealedVisitor, globals: phone };
export const ConcealedStranger = concealed('stranger');
export const ConcealedStrangerPhone: Story = { ...ConcealedStranger, globals: phone };
export const ConcealedMember = concealed('member');
export const ConcealedMemberPhone: Story = { ...ConcealedMember, globals: phone };
export const ConcealedOwner = concealed('owner');
export const ConcealedOwnerPhone: Story = { ...ConcealedOwner, globals: phone };
export const ConcealedModerator = concealed('moderator');
export const ConcealedModeratorPhone: Story = { ...ConcealedModerator, globals: phone };
export const ConcealedOperator = concealed('operator');
export const ConcealedOperatorPhone: Story = { ...ConcealedOperator, globals: phone };
export const LiveVisitor = live('visitor');
export const LiveVisitorPhone: Story = { ...LiveVisitor, globals: phone };
export const LiveOwner = live('owner');
export const LiveOwnerPhone: Story = { ...LiveOwner, globals: phone };
export const Loading: Story = { args: { loading: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading')).toBeNull();
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };
