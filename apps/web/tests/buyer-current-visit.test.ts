import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { checkoutCurrentVisit, browserObservation } from '../src/session/index';
import { BuyerHistoryWindows } from '../src/checkout/buyer-history-windows';

// This is the production adapter and coordinate model, with no private reader or extra session fetch.
test('current visit retires both positions in-stack on exposure and equal/ABA session replacement', () => {
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'buyer-a', csrfToken: 'csrf-a' });
  const capability = checkoutCurrentVisit(client);
  let windows = new BuyerHistoryWindows();
  let retirements = 0;
  const release = capability.subscribeRetirement(() => {
    windows.retire();
    retirements++;
  });
  const positions = () => {
    windows = new BuyerHistoryWindows();
    windows.admitEntry('orders', 'orders+/=');
    windows.admitEntry('entitlements', 'benefits+/=');
    return windows;
  };
  const retired = (old: BuyerHistoryWindows, before: number) => {
    expect(retirements).toBeGreaterThan(before);
    expect(old.window('orders').current).toBeUndefined();
    expect(old.window('entitlements').current).toBeUndefined();
  };
  try {
    const snapshot = browserObservation(client).getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected the installed buyer observation');
    let old = positions();
    let before = retirements;
    const key = ['exposure', 'viewer', snapshot.observation.subject, snapshot.observation.id];
    client.setQueryData(key, { subject: 'buyer-a', admitted: ['purchases'] });
    retired(old, before);
    old = positions();
    before = retirements;
    client.setQueryData(['unrelated'], 'does not retire history');
    expect(retirements).toBe(before);
    client.setQueryData(['session'], { state: 'signed-in', subject: 'buyer-a', csrfToken: 'csrf-a' });
    retired(old, before);
    old = positions();
    before = retirements;
    client.setQueryData(['session'], { state: 'signed-in', subject: 'buyer-b', csrfToken: 'csrf-b' });
    client.setQueryData(['session'], { state: 'signed-in', subject: 'buyer-a', csrfToken: 'csrf-a' });
    retired(old, before);
  } finally {
    release();
    client.clear();
  }
});
