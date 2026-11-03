import { expect, test } from 'bun:test';
import { deferred, follow, mountFollowing, page, realmId, spaceId } from './helpers/following-reading';
import type { SpaceRead } from '../src/library/following-reading/space-reader';

const ready = (address: string | null, admittedRealm: string | null = realmId): SpaceRead => ({ subject: 'owner', locale: 'en', spaceId,
  result: { state: 'ready', space: { spaceId, title: 'Current native title', summary: 'Native summary', address, realmId: admittedRealm } } });

test('at 1/10/20 follows initial reads stay zero and only the deliberately inspected community makes one point read', async () => {
  for (const n of [1, 10, 20]) {
    const pending = deferred<SpaceRead>();
    let reads = 0;
    const h = await mountFollowing(page(...Array.from({ length: n }, (_, i) => follow('space', i ? `space-${i}` : spaceId))), () => { reads++; return pending.promise; });
    try {
      expect(reads).toBe(0);
      await h.inspect(spaceId);
      expect(reads).toBe(1);
      expect(h.host.querySelector('[role="dialog"]')?.textContent).toContain('Reading this community');
      await h.settle(() => pending.resolve(ready('current-address')));
      expect(h.host.querySelector('[role="dialog"] a')?.getAttribute('href')).toBe('/en/spaces/current-address');
      expect(h.host.textContent).toContain('Native summary');
      expect(reads).toBe(1);
    } finally { await h.dispose(); }
  }
});

test('same-ID fresh observations discard old address/admission; replacement, exposure and account changes retire in-flight responses', async () => {
  const pending = deferred<SpaceRead>();
  let reads = 0;
  const h = await mountFollowing(page(follow('space')), async () => ++reads === 1 ? ready('old-address') : reads === 2 ? ready(null, null) : pending.promise);
  try {
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')?.getAttribute('href')).toContain('old-address');
    await h.replace(page(follow('space')));
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.inspect(spaceId);
    expect(h.host.querySelector('[role="dialog"] a')).toBeNull();
    expect(h.host.textContent).toContain('No currently readable destination');
    expect(h.host.textContent).not.toContain('old-address');
    await h.inspect(spaceId);
    await h.replace(page(follow('space')));
    await h.settle(() => pending.resolve(ready('late-address')));
    expect(h.host.textContent).not.toContain('late-address');
    await h.inspect(spaceId);
    await h.admit([]);
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.admit();
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    await h.inspect(spaceId);
    await h.account('other');
    expect(h.host.querySelector('[role="dialog"]')).toBeNull();
    expect(h.host.textContent).not.toContain('Current native title');
  } finally { await h.dispose(); }
});
