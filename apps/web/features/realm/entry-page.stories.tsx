import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import admission from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import closure from '../../../../tests/qa/fixtures/outcomes/realm/closure-threads-and-replies.json';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { spaceAccessApi } from '../manage/settings-api.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { PageContainer } from '../shell/page.tsx';
import { RealmJoinPage } from './entry-page.tsx';
import { recordedRealmEntry } from './entry-recorded-read.ts';
import { RealmNotFound, RealmUnavailable } from './states.tsx';
import { realmMessagesFor } from './story-page.tsx';

type State = 'closed' | 'landing' | 'requested' | 'withdrawn' | 'loading';
function RecordedEntry({ persona, state, locale }: { persona: AnswerPersona; state: State; locale: UiLocale }) {
  const [shown, setShown] = useState<{ state: State; persona: AnswerPersona; locale: UiLocale; content: ReactNode } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const messages = realmMessagesFor(locale);
  useEffect(() => {
    let active = true;
    const closed = state === 'closed';
    const record = (closed ? closure : admission) as AnswerRecord;
    const labels = closed ? record.personas[persona].filter(sample => sample.label.startsWith('discussion-')).map(sample => sample.label)
      : persona === 'visitor' ? ['join-address', 'private-realm-hidden', 'request-landing']
        : ['join-address', 'join-public-realm', 'join-realm', 'join-landing', 'join-session-agent',
          state === 'requested' ? 'join-own-request-pending' : state === 'withdrawn' ? 'join-own-request-withdrawn' : 'join-own-requests-before-request'];
    const selections: RecordedSelection[] = labels.map(label => {
      const sample = record.personas[persona].find(item => item.label === label)!;
      return { label, state: state === 'loading' && label === 'join-address' ? 'loading' : sample.status >= 400 ? 'error' : 'populated' };
    });
    const replay = recordedRealmEntry(record, persona, selections, closed ? 'discussion-space-address' : 'join-address',
      persona === 'visitor' ? undefined : closed ? 'discussion-session-agent' : 'join-session-agent');
    void replay.read(locale).then(({ resolved, actingSubject }) => {
      if (!active) return;
      let content: ReactNode;
      if (resolved.kind === 'missing') content = <RealmNotFound messages={messages} />;
      else if (resolved.kind === 'unavailable') content = <RealmUnavailable messages={messages} failure={resolved.failure} reference={resolved.reference} />;
      else if (resolved.kind === 'join') content = <RealmJoinPage page={resolved.page} locale={locale}
        here={spaceHref(replay.key, 'community')} actingSubject={actingSubject ?? null} persist={false}
        api={spaceAccessApi(() => replay.personal, resolved.page.space, resolved.page.id, actingSubject ?? '')} />;
      else throw new Error('The recorded landing unexpectedly disclosed a private Realm');
      setShown({ state, persona, locale, content });
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason : new Error(String(reason))); });
    return () => { active = false; replay.dispose(); };
  }, [persona, state, locale]);
  if (error) throw error;
  if (shown?.state === state && shown.persona === persona && shown.locale === locale) return shown.content;
  return <PageContainer><p role="status" aria-busy="true">{messages.loading}</p></PageContainer>;
}

const meta = { title: 'Realm/Entry/Recorded admission and closure', component: RecordedEntry,
  args: { persona: 'visitor', state: 'landing', locale: 'en' }, globals: { viewport: { value: 'desktop' } },
  render: (args, { globals }) => <RecordedEntry {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
} satisfies Meta<typeof RecordedEntry>;
export default meta;
type Story = StoryObj<typeof meta>;
const phone = { viewport: { value: 'phone' } };
const closedPlay: Story['play'] = async ({ canvasElement, globals }) => {
  const messages = realmMessagesFor((globals.locale as UiLocale | undefined) ?? 'en');
  await expect(await within(canvasElement).findByRole('heading', { name: messages.notFoundTitle })).toBeVisible();
  await expect(within(canvasElement).queryByRole('textbox')).toBeNull();
};
export const VisitorLanding: Story = {};
export const VisitorLandingPhone: Story = { globals: phone };
export const StrangerLanding: Story = { args: { persona: 'stranger' } };
export const StrangerLandingPhone: Story = { ...StrangerLanding, globals: phone };
export const OperatorLanding: Story = { args: { persona: 'operator' } };
export const OperatorLandingPhone: Story = { ...OperatorLanding, globals: phone };
// "requested" is a completed HTTP 200 requester read; admission waiting is not HTTP 202 command pending.
export const StrangerAwaitingDecision: Story = { args: { persona: 'stranger', state: 'requested' } };
export const StrangerAwaitingDecisionPhone: Story = { ...StrangerAwaitingDecision, globals: phone };
export const StrangerWithdrawn: Story = { args: { persona: 'stranger', state: 'withdrawn' } };
export const StrangerWithdrawnPhone: Story = { ...StrangerWithdrawn, globals: phone };
export const Loading: Story = { args: { state: 'loading' } };
export const LoadingPhone: Story = { ...Loading, globals: phone };
export const ClosedVisitor: Story = { args: { state: 'closed' }, play: closedPlay };
export const ClosedVisitorPhone: Story = { ...ClosedVisitor, globals: phone };
export const ClosedStranger: Story = { args: { state: 'closed', persona: 'stranger' }, play: closedPlay };
export const ClosedStrangerPhone: Story = { ...ClosedStranger, globals: phone };
export const ClosedMember: Story = { args: { state: 'closed', persona: 'member' }, play: closedPlay };
export const ClosedMemberPhone: Story = { ...ClosedMember, globals: phone };
export const ClosedOwner: Story = { args: { state: 'closed', persona: 'owner' }, play: closedPlay };
export const ClosedOwnerPhone: Story = { ...ClosedOwner, globals: phone };
export const ClosedModerator: Story = { args: { state: 'closed', persona: 'moderator' }, play: closedPlay };
export const ClosedModeratorPhone: Story = { ...ClosedModerator, globals: phone };
export const ClosedOperator: Story = { args: { state: 'closed', persona: 'operator' }, play: closedPlay };
export const ClosedOperatorPhone: Story = { ...ClosedOperator, globals: phone };
