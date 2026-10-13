import { outcomeTest } from '../../../support/outcome-test.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import notifications from '../../../../../scripts/qa/cases/outcomes/realm/closure-notifications.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';
import { closureCommand, closureCredit, closureOriginal, closureCell, closureReply, closureRole,
  closureSetup, effectClosure, publishClosureRule } from './closure-fixture.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
let live: PersonaSessions;
let setupFailure: string | null = null;
let original: Awaited<ReturnType<typeof closureOriginal>>;
let control: Awaited<ReturnType<typeof closureOriginal>>;
const recipients = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
type Recipient = Exclude<PersonaName, 'visitor'>;
type Item = { id: string; state: string; read: boolean; topic: string; subject: { ref: string } | null;
  display: { kind: string; realm: string | null; actor: { id: string } | null; target: unknown } | null;
  deliveries: { id: string; channel: string }[] };
type Inbox = { items: Item[]; next: string | null; generation: string; head: string };
const before = new Map<Recipient, { closed: Item[]; live: Item[] }>();
const closedReplies = new Set<string>();
let liveReply: string;
type ProviderRequest = { deliveryId: string; address: string; payload: unknown };
const sends: ProviderRequest[] = [];
const accepted = new Set<string>();
let accept = false;
let completedAtSend = 0;
const token = randomUUID();
let provider: ReturnType<typeof Bun.serve>;
// Only the external delivery service is simulated. Main's real provider,
// dispatcher, producers and recipient/disclosure owners run unchanged.
function startProvider() {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method === 'GET') {
      const id = new URL(request.url).pathname.split('/').at(-1)!;
      return accepted.has(id) ? Response.json({ profile: 'notification-provider-lookup-v1',
        status: 'accepted', messageId: id }) : new Response(null, { status: 404 });
    }
    const input = await request.json() as ProviderRequest;
    sends.push(input);
    if (!accept) {
      // These requests were not accepted. Two real adapter outcomes exercise
      // retry and uncertain lookup without injecting either owner state.
      return input.address.endsWith('/member') || input.address.endsWith('/operator')
        ? new Response(null, { status: 503 })
        : Response.json({ profile: 'notification-provider-result-v1', status: 'rejected',
          permanent: false, code: 'retry_later' });
    }
    accepted.add(input.deliveryId);
    return Response.json({ profile: 'notification-provider-result-v1', status: 'accepted', messageId: input.deliveryId });
  } });
}
async function inbox(person: PersonaSession) {
  const items: Item[] = [];
  let cursor: string | null = null;
  const cursors = new Set<string>();
  for (;;) {
    const page: Inbox = await closureCommand(person, 'GET', `/v1/me/notifications${cursor ? `?after=${cursor}` : ''}`);
    items.push(...page.items);
    if (!page.next) return items;
    expect(cursors.has(page.next), 'Notification cursor must advance').toBe(false);
    cursors.add(page.next);
    cursor = page.next;
  }
}
async function watch(person: PersonaSession, work: string) {
  await closureCommand(person, 'POST', '/v1/me/watches', {
    target: work, kind: 'thread', level: 'all', actingSubject: person.actingSubject, expectedRevision: null,
  });
}
beforeAll(async () => {
  provider = startProvider();
  sessions = await personaSessions('public', { notificationProvider: {
    url: provider.url.toString(), token, callbackSecret: randomUUID(),
  } });
  live = await personaSessions('public');
  setupFailure = await closureSetup(sessions, async () => {
    const rule = await publishClosureRule(sessions);
    original = await closureOriginal(sessions.member, 'Original closed-Realm reply source');
    control = await closureOriginal(live.member, 'Independent original live reply source');
    await closureRole(sessions, sessions.moderator, ['review.decide', 'publication.adopt']);
    await closureRole(sessions, sessions.owner, ['review.decide', 'publication.adopt']);
    await closureRole(live, live.moderator, ['review.decide', 'publication.adopt']);
    for (const name of recipients) {
      await closureCommand(sessions[name], 'PUT', '/v1/me/notification-endpoints/push', {
        profile: 'notification-endpoint-v1', deviceId: 'closure-fixture',
        address: `https://push.example.test/${name}`, lockScreenDisclosure: false,
      });
      await watch(sessions[name], original.work);
      await watch(sessions[name], control.work);
    }
    closedReplies.add((await closureReply(sessions, original, 'Original reply by the credited member Person.')).reply);
    // A different author supplies the member recipient's notice without making
    // the author their own recipient or changing any persona's membership.
    closedReplies.add((await closureReply(sessions, original, 'Original reply by the moderator Person.',
      sessions.moderator, sessions.owner)).reply);
    liveReply = (await closureReply(live, control, 'Independent original reply by the live member Person.')).reply;
    const deadline = performance.now() + 45_000;
    for (const name of recipients) {
      for (;;) {
        const items = await inbox(sessions[name]);
        const closed = items.filter(item => item.subject && closedReplies.has(item.subject.ref));
        const independent = items.filter(item => item.subject?.ref === liveReply);
        if (closed.length && independent.length) {
          expect(closed.every(item => item.state === 'active' && item.display?.realm === sessions.realm)).toBe(true);
          expect(independent.every(item => item.state === 'active' && item.display?.realm === live.realm)).toBe(true);
          expect([...closed, ...independent].every(item => item.deliveries.length > 0)).toBe(true);
          for (const item of [...closed, ...independent]) {
            for (const delivery of item.deliveries) {
              for (;;) {
                const current = await closureCommand<{ state: string; attempts: number }>(sessions[name],
                  'GET', `/v1/deliveries/${delivery.id}`);
                expect(current.state).not.toBe('delivered');
                if (current.attempts > 0 && ['pending', 'uncertain'].includes(current.state)) {
                  expect(current.state).toBe(name === 'member' || name === 'operator' ? 'uncertain' : 'pending');
                  break;
                }
                expect(performance.now(), 'Public delivery must enter retry or uncertain before closure').toBeLessThan(deadline);
                await Bun.sleep(100);
              }
            }
          }
          before.set(name, { closed, live: independent });
          break;
        }
        expect(performance.now(), `${name} must receive both public reply events before closure`).toBeLessThan(deadline);
        await Bun.sleep(100);
      }
    }
    await effectClosure(sessions, rule);
    completedAtSend = sends.length;
    accept = true;
  });
}, 180_000);
afterAll(async () => { try { await sessions?.close(); } finally { await provider?.stop(true); } });

async function recipient(name: Recipient) {
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = sessions[name];
  const prior = before.get(name)!;
  const items = await inbox(person);
  for (const closed of prior.closed) {
    const retained = items.find(item => item.id === closed.id);
    if (retained) {
      expect(retained.subject).toBeNull();
      expect(retained.display).toBeNull();
    }
    for (const delivery of closed.deliveries) {
      const deadline = performance.now() + 45_000;
      let current: { state: string; cancelReason: string | null };
      for (;;) {
        current = await closureCommand(person, 'GET', `/v1/deliveries/${delivery.id}`);
        if (['cancelled', 'suppressed'].includes(current.state)) break;
        expect(current.state, 'An unaccepted closed delivery must never be sent').not.toBe('delivered');
        expect(performance.now(), 'Closed delivery must terminate without a provider send').toBeLessThan(deadline);
        await Bun.sleep(100);
      }
      expect(current.cancelReason).not.toBeNull();
      expect(accepted.has(delivery.id)).toBe(false);
      expect(sends.slice(completedAtSend).some(send => send.deliveryId === delivery.id)).toBe(false);
      const stranger = sessions[recipients.find(candidate => candidate !== name)!];
      const other = await stranger.main('GET', `/v1/deliveries/${delivery.id}`);
      const absent = await stranger.main('GET', `/v1/deliveries/${randomUUID()}`);
      expect(other.status).toBe(absent.status);
      expect(await other.json()).toEqual(await absent.json());
    }
  }
  for (const eligible of prior.live) {
    const retained = items.find(item => item.id === eligible.id);
    expect(retained).toMatchObject({ state: 'active', subject: { ref: liveReply }, display: { realm: live.realm } });
    for (const delivery of eligible.deliveries) {
      const deadline = performance.now() + 45_000;
      for (;;) {
        const current = await closureCommand<{ state: string }>(person, 'GET', `/v1/deliveries/${delivery.id}`);
        expect(['cancelled', 'suppressed']).not.toContain(current.state);
        if (current.state === 'delivered') break;
        expect(performance.now(), 'Independent delivery must reach the provider').toBeLessThan(deadline);
        await Bun.sleep(100);
      }
      expect(accepted.has(delivery.id)).toBe(true);
    }
  }
  const count = await closureCommand<{ count: number }>(person, 'GET', '/v1/me/notifications/unread-count');
  expect(count.count).toBe(items.filter(item => item.state === 'active' && item.subject && !item.read).length);
  // Process notices use their own case authority; they may remain eligible,
  // but they cannot restore the closed reply's labels or excerpt.
  const active = JSON.stringify(items.filter(item => item.state === 'active' && item.subject));
  for (const reply of closedReplies) expect(active).not.toContain(reply);
  await closureCredit(person, original.work, sessions.member);
  await closureCredit(person, control.work, live.member);
}
outcomeTest(notifications, 'visitor', () => closureCell(notifications, 'visitor', () => sessions, async () => {
  for (const path of ['/v1/me/notifications', '/v1/me/notifications/unread-count', `/v1/deliveries/${randomUUID()}`]) {
    const problem = await closureCommand<{ code: string }>(sessions.visitor, 'GET', path, undefined, 401);
    expect(problem.code).toBe('account_assertion_denied');
  }
}));
outcomeTest(notifications, 'stranger', () => closureCell(notifications, 'stranger', () => sessions, () => recipient('stranger')));
outcomeTest(notifications, 'member', () => closureCell(notifications, 'member', () => sessions, () => recipient('member')));
outcomeTest(notifications, 'owner', () => closureCell(notifications, 'owner', () => sessions, () => recipient('owner')));
outcomeTest(notifications, 'moderator', () => closureCell(notifications, 'moderator', () => sessions, () => recipient('moderator')));
outcomeTest(notifications, 'operator', () => closureCell(notifications, 'operator', () => sessions, () => recipient('operator')));
