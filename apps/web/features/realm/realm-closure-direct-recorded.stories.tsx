import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import fixture from '../../../../tests/qa/fixtures/outcomes/realm/closure-direct-routes.json';
import { messages } from './messages.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { profileHref } from '../profile/route.ts';
import { mapZoneSiteHome } from '../zones/zone-site-recorded-page.ts';
import type { ZonePresentationRead } from './types.ts';
import { directSample } from './realm-closure-direct-recorded-page.tsx';
import { RecordedClosureDirect, type DirectEntry } from './realm-closure-direct-recorded-page.tsx';

const meta = { title: 'Realm/Closed direct routes recorded', component: RecordedClosureDirect,
  args: { record: fixture as AnswerRecord }, globals: { locale: 'en', viewport: { value: 'desktop' } },
} satisfies Meta<typeof RecordedClosureDirect>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { locale: 'en', viewport: { value: 'phone' } };
function concealed(persona: AnswerPersona, entry: DirectEntry = 'home'): Story {
  return { args: { persona, entry }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: messages.notFoundTitle })).toBeVisible();
    await expect(canvas.getByRole('link', { name: messages.browse })).toBeVisible();
    await expect(canvas.queryByText('Outcome Realm')).toBeNull();
    await expect(canvas.queryByText('Independent original closure control')).toBeNull();
    await expect(canvasElement.querySelector('[data-zone-frame]')).toBeNull();
    await expect(canvas.queryByRole('button', { name: /join/i })).toBeNull();
  } };
}
export const Visitor = concealed('visitor');
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const Stranger = concealed('stranger');
export const Member = concealed('member');
export const Owner = concealed('owner');
export const OwnerPhone: Story = { ...Owner, globals: phone };
export const Moderator = concealed('moderator');
export const Operator = concealed('operator');
export const Adoptions = concealed('member', 'adoptions');
export const AdoptionsPhone: Story = { ...Adoptions, globals: phone };
export const Decisions = concealed('owner', 'decisions');
export const ExactDecision = concealed('operator', 'exact-decision');
export const PrivateTeaser = concealed('stranger', 'private-teaser');
export const PrivateTeaserPhone: Story = { ...PrivateTeaser, globals: phone };
export const IndependentZone: Story = { args: { entry: 'zone-entry' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText('An original published home for the Realm entry control.')).toBeVisible();
  await expect(canvas.getByRole('heading', { level: 1, name: 'Outcome Realm site' })).toBeVisible();
  await expect(canvas.getByText('Original contribution')).toBeVisible();
  const home = mapZoneSiteHome(directSample(fixture as AnswerRecord, 'visitor', 'zone-entry-presentation').answer as ZonePresentationRead);
  if (home.kind !== 'published' || !home.credit) throw new Error('Recorded original credit is missing');
  await expect(canvas.getByRole('link', { name: 'View contributor' })).toHaveAttribute('href',
    localizedPath(profileHref({ handle: null, id: home.credit.author }), 'en'));
  await expect(canvas.queryByText(messages.notFoundTitle)).toBeNull();
} };
export const IndependentZonePhone: Story = { ...IndependentZone, globals: phone };
export const IndependentOwner: Story = { ...IndependentZone, args: { entry: 'zone-entry', persona: 'owner' } };
export const Loading: Story = { args: { loading: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('status')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading')).toBeNull();
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };
