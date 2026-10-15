import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recordFile from '../../../../tests/qa/fixtures/outcomes/realm/closure-roster.json';
import { browserMainApi } from '../api/browser.ts';
import { bffAdminApi } from './admin-api.ts';
import { acting, agents, members, now, outgoingInvitations, realm as liveRealm, roles } from './fixtures.ts';
import { messages } from './messages.ts';
import japanese from './messages/ja.ts';
import { MembersView } from './members-view.tsx';
import { ManageFailure } from './parts.tsx';
import { mapRealmMembers, readRealmMembersPage } from './realm-team-recorded-page.ts';

const record = recordFile as AnswerRecord;
type Mapping = ReturnType<typeof mapRealmMembers>;
function ClosedRoster({ persona, closesAfterFirstPage = false, locale = 'en' }: { persona: AnswerPersona; closesAfterFirstPage?: boolean; locale?: 'en' | 'ja' }) {
  const copy = locale === 'ja' ? { ...messages, ...japanese } : messages;
  const fixture = useMemo(() => {
    const sample = record.personas[persona].find(item => item.label === 'members-private-header')!;
    const url = new URL(sample.path, 'https://contract.invalid');
    const realm = url.pathname.split('/')[3]!;
    const actor = url.searchParams.get('actingSubject') ?? acting.iri;
    const main = browserMainApi('https://contract.invalid', { fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const requested = new URL(request.url);
      if (closesAfterFirstPage && !requested.searchParams.has('after')) {
        if (requested.pathname.endsWith('/members')) return Response.json({ generation: '12', items: [members[0]], nextCursor: members[0]!.member });
        if (requested.pathname.endsWith('/roles')) return Response.json({ generation: '12', roles, cap: 32 });
        if (requested.pathname.endsWith('/invitations')) return Response.json({ ...outgoingInvitations, items: [], nextCursor: null });
        return Response.json({ displayName: agents[members[0]!.member]?.label, handle: null, id: members[0]!.member });
      }
      return Response.json(sample.answer, { status: sample.status });
    }) as typeof fetch });
    return { realm, actor, main };
  }, [persona, closesAfterFirstPage]);
  const [mapped, setMapped] = useState<Mapping | null>(null);
  useEffect(() => {
    let active = true;
    void readRealmMembersPage({ main: fixture.main, anonymous: fixture.main }, { realm: fixture.realm, actingSubject: fixture.actor })
      .then(read => { if (active) setMapped(mapRealmMembers(read.page, read.roles, read.invitations, null)); });
    return () => { active = false; };
  }, [fixture]);
  if (!mapped) return <p role="status" aria-busy="true">{copy.loadingMore}</p>;
  if (mapped.kind === 'refusal') return <ManageFailure failure={mapped.failure} locale={locale} messages={copy} />;
  return <MembersView principal="storybook:closed-roster" realm={fixture.realm} actingSubject={fixture.actor} first={mapped.page}
    agents={agents} invitations={mapped.invitations} roles={mapped.roles} now={now} locale={locale} messages={copy}
    api={bffAdminApi(fixture.realm, fixture.actor, () => fixture.main)} />;
}
const meta = {
  render: (args, { globals }) => <ClosedRoster {...args} locale={globals.locale === 'ja' ? 'ja' : 'en'} />,
  title: 'Manage/Closed roster (contract states)', component: ClosedRoster, args: { persona: 'owner' as AnswerPersona, closesAfterFirstPage: false },
  parameters: { route: { pathname: `/en/manage/r/${liveRealm}/members` }, contractState: {
    source: 'Management roster requests are unrecorded. Concealed problems use the unchanged closure-roster answers.',
    requests: ['GET /v1/realms/{closedRealm}/members?actingSubject={personaActor}',
      'GET /v1/realms/{closedRealm}/roles?actingSubject={personaActor}', 'GET /v1/realms/{closedRealm}/invitations?actingSubject={personaActor}',
      'GET /v1/realms/{closedRealm}/members?actingSubject={personaActor}&after={retainedMember}'],
    status: 404, code: 'realm_unavailable' } },
} satisfies Meta<typeof ClosedRoster>;
export default meta;
type Story = StoryObj<typeof meta>;
async function assertConcealed(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { name: messages.missingTitle })).resolves.toBeVisible();
  await expect(canvas.queryByRole('list', { name: messages.membersTitle })).toBeNull();
  await expect(canvas.queryByRole('button', { name: messages.loadMore })).toBeNull();
  await expect(canvas.queryByText('Daniel Chen 陈丹尼')).toBeNull();
}
const concealed: Story = { play: ({ canvasElement }) => assertConcealed(canvasElement) };
const closes: Story = { args: { closesAfterFirstPage: true }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByText('Daniel Chen 陈丹尼')).resolves.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: messages.loadMore }));
  await assertConcealed(canvasElement);
} };
const at = (persona: AnswerPersona, viewport: 'phone' | 'desktop'): Story => ({ ...concealed, args: { persona }, globals: { viewport: { value: viewport } } });
export const VisitorPhone = at('visitor', 'phone');
export const VisitorDesktop = at('visitor', 'desktop');
export const StrangerPhone = at('stranger', 'phone');
export const StrangerDesktop = at('stranger', 'desktop');
export const MemberPhone = at('member', 'phone');
export const MemberDesktop = at('member', 'desktop');
export const OwnerPhone = at('owner', 'phone');
export const OwnerDesktop = at('owner', 'desktop');
export const ModeratorPhone = at('moderator', 'phone');
export const ModeratorDesktop = at('moderator', 'desktop');
export const OperatorPhone = at('operator', 'phone');
export const OperatorDesktop = at('operator', 'desktop');
export const ClosureDuringPaginationPhone = { ...closes, globals: { viewport: { value: 'phone' } } };
export const ClosureDuringPaginationDesktop = { ...closes, globals: { viewport: { value: 'desktop' } } };
