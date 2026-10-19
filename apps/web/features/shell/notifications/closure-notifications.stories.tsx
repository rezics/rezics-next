import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import type { Loaded } from '../../feed/types.ts';
import { signInPath } from '../../auth/paths.ts';
import { localizedPath } from '../../../i18n/locale.ts';
import { useShell } from '../shell-provider.tsx';
import { setUnread, setUnreadGeneration, unreadBadge, useUnread } from '../unread.ts';
import { closureAnswers, closurePersonas, closureRecordPlan, closureTransport,
  type ClosurePersona, type ClosureState } from './closure-fixtures.ts';
import { NOW } from './fixtures.ts';
import { messages } from './messages.ts';
import { NotificationsLoading, NotificationsUnavailable, NotificationsView } from './notifications-view.tsx';
import { readLatest, type NotificationWindow } from './window.ts';

type Args = { persona: ClosurePersona; state: ClosureState };

function Badge({ signedIn }: { signedIn: boolean }) {
  const count = useUnread(signedIn);
  return <output aria-label="Unread badge">{count ? unreadBadge(count) : ''}</output>;
}

/** Same reader/window boundary as /notifications; only the transport supplies contract-built answers.
 * Missing record states and exact GET requests are declared in closure-fixtures.ts. No answer is a capture.
 */
function ClosureNotifications({ persona, state }: Args) {
  const { locale } = useShell();
  const [loaded, setLoaded] = useState<{
    read: Loaded<NotificationWindow>; fixture: ReturnType<typeof closureTransport>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const fixture = closureTransport(persona, state);
    setLoaded(null);
    void readLatest(fixture.main).then(read => { if (active) setLoaded({ read, fixture }); });
    return () => { active = false; fixture.dispose(); };
  }, [persona, state]);
  const signInHref = signInPath(localizedPath('/notifications', locale));
  return <>
    {!loaded ? <NotificationsLoading /> : !loaded.read.ok
      ? <NotificationsUnavailable reason="failed" failure={loaded.read.failure}
        reference={loaded.read.reference} signInHref={signInHref} />
      : <NotificationsView key={`${persona}:${state}`} initial={loaded.read.data} now={NOW} avatarQuery=""
        main={loaded.fixture.main} />}
    <Badge signedIn={persona !== 'visitor'} />
  </>;
}

const meta = {
  title: 'Shell/Closed Realm notifications', component: ClosureNotifications,
  parameters: { route: { pathname: '/en/notifications' },
    missingRecordedAnswers: [
      ...closurePersonas.map(persona => closureRecordPlan(persona)),
      ...(['owner', 'moderator', 'operator'] as const).map(persona => closureRecordPlan(persona, 'process-authorized')),
      ...(['empty', 'loading', 'error', 'count-error', 'delivery-error', 'delivery-missing',
        'delivery-uncertain', 'continuation-denied'] as const).map(state => closureRecordPlan('member', state)),
      ...(['owner', 'moderator', 'operator'] as const).map(persona => closureRecordPlan(persona, 'role-only')),
    ],
    docs: { description: { component:
    'Contract-built states awaiting prove-phase capture for realm/closure-notifications. Process authority is an explicit API answer; roles alone do not grant it. No endpoint declares HTTP 202.' } } },
  globals: { viewport: { value: 'desktop' } },
  args: { persona: 'member', state: 'populated' },
  beforeEach({ args }) {
    setUnreadGeneration(null); setUnread(null);
    const fixture = closureTransport(args.persona, args.state);
    const original = window.fetch;
    const fetch = spyOn(window, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      return url.pathname === '/api/main/v1/me/notifications/unread-count'
        ? fixture.fetcher(new Request(url, init)) : original(input, init);
    });
    return () => { fetch.mockRestore(); fixture.dispose(); setUnreadGeneration(null); setUnread(null); };
  },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

const populated: Story['play'] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  const answers = closureAnswers(args.persona, args.state);
  await expect(await canvas.findByRole('link', { name: 'Live member replied on “Independent original source”' })).toBeVisible();
  await expect(canvas.getByText('Original reply by the credited live member Person.')).toHaveAttribute('lang', 'en');
  await expect(canvasElement).not.toHaveTextContent('Original closed-Realm reply source');
  await expect(canvasElement).not.toHaveTextContent('Original reply by the credited closed member Person.');
  await expect(canvasElement).not.toHaveTextContent('Closed Realm');
  await waitFor(() => expect(canvas.getByRole('status', { name: 'Unread badge' })).toHaveTextContent(String(answers.count.count)));
  const process = canvas.queryByRole('link', { name: 'A correction needs your review' });
  if (answers.processAuthorized) await expect(process).toHaveAttribute('href', `/en/proposals/${answers.process.proposal!.id}?revision=2`);
  else await expect(process).toBeNull();
  await userEvent.click(canvas.getAllByRole('button', { name: 'Delivery details' })[0]!);
  await expect(await canvas.findByText('Delivery cancelled')).toBeVisible();
  await userEvent.click(canvas.getAllByRole('button', { name: 'Delivery details' })[1]!);
  await expect(await canvas.findByText('Delivered')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Show more' }));
  await waitFor(() => expect(canvas.getAllByRole('link', { name: 'Live member replied on “Independent original source”' })).toHaveLength(2));
  await expect(canvas.queryByRole('button', { name: 'Show more' })).toBeNull();
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

export const Visitor: Story = { args: { persona: 'visitor' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: 'Sign in to see your notifications' })).toBeVisible();
  await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/start?next=%2Fen%2Fnotifications');
  await expect(canvas.queryByRole('button', { name: 'Delivery details' })).toBeNull();
  await expect(canvas.getByRole('status', { name: 'Unread badge' })).toBeEmptyDOMElement();
} };
export const Stranger: Story = { args: { persona: 'stranger' }, play: populated };
export const Member: Story = { args: { persona: 'member' }, play: populated };
export const Owner: Story = { args: { persona: 'owner', state: 'process-authorized' }, play: populated };
export const Moderator: Story = { args: { persona: 'moderator', state: 'process-authorized' }, play: populated };
export const Operator: Story = { args: { persona: 'operator', state: 'process-authorized' }, play: populated };
export const OwnerWithoutProcessAuthority: Story = { args: { persona: 'owner', state: 'role-only' }, play: populated };
export const ModeratorWithoutProcessAuthority: Story = { args: { persona: 'moderator', state: 'role-only' }, play: populated };
export const OperatorWithoutProcessAuthority: Story = { args: { persona: 'operator', state: 'role-only' }, play: populated };
const phone = { viewport: { value: 'phone' } };
export const VisitorPhone: Story = { ...Visitor, globals: phone };
export const StrangerPhone: Story = { ...Stranger, globals: phone };
export const MemberPhone: Story = { ...Member, globals: phone };
export const OwnerPhone: Story = { ...Owner, globals: phone };
export const ModeratorPhone: Story = { ...Moderator, globals: phone };
export const OperatorPhone: Story = { ...Operator, globals: phone };

export const Loading: Story = { args: { state: 'loading' }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByText('Loading…')).toHaveAttribute('aria-busy', 'true');
} };
export const Empty: Story = { args: { state: 'empty' }, async play({ canvasElement }) {
  await expect(await within(canvasElement).findByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
} };
export const Error: Story = { args: { state: 'error' }, async play({ canvasElement }) {
  await expect(await within(canvasElement).findByRole('alert')).toHaveTextContent('Reference: closure-inbox-503');
} };
export const CountError: Story = { args: { state: 'count-error' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('alert')).toHaveTextContent('Reference: closure-count-503');
  await expect(canvas.getByRole('link', { name: 'Live member replied on “Independent original source”' })).toBeVisible();
  await expect(canvas.getByRole('status', { name: 'Unread badge' })).toBeEmptyDOMElement();
} };
export const DeliveryError: Story = { args: { state: 'delivery-error' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findAllByRole('button', { name: 'Delivery details' }).then(items => items[0]!));
  await expect(await canvas.findByRole('alert')).toHaveTextContent('Reference: closure-delivery-503');
} };
export const DeliveryMissing: Story = { args: { state: 'delivery-missing' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findAllByRole('button', { name: 'Delivery details' }).then(items => items[0]!));
  await expect(await canvas.findByText('Delivery details are unavailable.')).toBeVisible();
  await expect(canvas.queryByRole('alert')).toBeNull();
} };
export const UncertainDelivery: Story = { args: { state: 'delivery-uncertain' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  const buttons = await canvas.findAllByRole('button', { name: 'Delivery details' });
  await userEvent.click(buttons[1]!);
  await expect(await canvas.findByText('Delivery not confirmed')).toBeVisible();
  await expect(canvas.queryByText('Delivered')).toBeNull();
} };
export const ContinuationDenied: Story = { args: { state: 'continuation-denied' }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: 'Show more' }));
  await expect(await canvas.findByRole('alert')).toHaveTextContent('Sign in to see your notifications');
  await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/start?next=%2Fen%2Fnotifications');
} };
export const LoadingPhone: Story = { ...Loading, globals: phone };
export const EmptyPhone: Story = { ...Empty, globals: phone };
export const ErrorPhone: Story = { ...Error, globals: phone };
export const CountErrorPhone: Story = { ...CountError, globals: phone };
export const DeliveryErrorPhone: Story = { ...DeliveryError, globals: phone };
export const DeliveryMissingPhone: Story = { ...DeliveryMissing, globals: phone };
export const ContinuationDeniedPhone: Story = { ...ContinuationDenied, globals: phone };

const localePlay: Story['play'] = async ({ canvasElement, globals }) => {
  const canvas = within(canvasElement);
  const locale = globals.locale as keyof typeof messages;
  await expect(await canvas.findAllByRole('button', { name: messages[locale].deliveryDetails }).then(buttons => buttons[0]!)).toBeVisible();
  await expect(canvas.getByText('Original reply by the credited live member Person.')).toHaveAttribute('lang', 'en');
};
export const English: Story = { globals: { locale: 'en' }, play: async ({ canvasElement }) => {
  await expect(await within(canvasElement).findAllByRole('button', { name: 'Delivery details' }).then(items => items[0]!)).toBeVisible();
} };
export const SimplifiedChinese: Story = { globals: { locale: 'zh-Hans' }, play: localePlay };
export const TraditionalChinese: Story = { globals: { locale: 'zh-Hant' }, play: localePlay };
export const Japanese: Story = { globals: { locale: 'ja' }, play: localePlay };
export const Korean: Story = { globals: { locale: 'ko' }, play: localePlay };
export const German: Story = { globals: { locale: 'de' }, play: localePlay };
export const French: Story = { globals: { locale: 'fr' }, play: localePlay };
export const Spanish: Story = { globals: { locale: 'es' }, play: localePlay };
