import { expect, test } from 'bun:test';
import { readingFixture } from '../src/kernel/fake/settings-preferences-reading';
import { createProfileStoryIO, profileStoryValues } from '../src/kernel/fake/settings-profile';
import { SettingsNavigationDrafts, readingNeedsNavigationDecision } from '../src/settings/reading-navigation';
import { readingMutation, sendReading } from '../src/settings/reading-preferences';
import { ProfileEditor } from '../src/settings/profile-write';
import { profileNeedsNavigationDecision } from '../src/settings/profile-navigation';

test('clean reading and same settings pathname query/hash changes navigate without a decision', () => {
  const fixture = readingFixture();
  const state = { known: fixture.initial, draft: fixture.initial, pending: null };
  const navigation = new SettingsNavigationDrafts();
  const remove = navigation.register({ kind: 'reading', needsDecision: () => readingNeedsNavigationDecision(state) });
  expect(navigation.block('/settings', '/')).toBe(false);
  state.draft = { ...state.draft, spoilerLevel: 1 };
  // useBlocker supplies pathnames without search/hash; those changes keep the same mounted card.
  expect(navigation.block('/settings', '/settings')).toBe(false);
  expect(navigation.blocked).toBe(false);
  remove();
  expect(navigation.block('/settings', '/')).toBe(false);
});

test('Leaving with a changed or unresolved reading draft offers one stay-or-leave decision, keeps the exact original attempt on stay, and never traps session/privacy teardown', async () => {
  const fixture = readingFixture('lost');
  const draft = { ...fixture.initial, spoilerLevel: 1 as const };
  const original = readingMutation(fixture.initial, draft)!;
  const state = { known: fixture.initial, draft, pending: original as typeof original | null };
  const navigation = new SettingsNavigationDrafts();
  navigation.register({ kind: 'reading', needsDecision: () => readingNeedsNavigationDecision(state) });
  expect((await sendReading(fixture.io, original, false, () => 0)).kind).toBe('uncertain');
  const later = { ...draft, suitability: 'show' as const };
  state.draft = later;
  const leaving = navigation.block('/settings', '/');
  expect(leaving).toBeInstanceOf(Promise);
  expect(navigation.block('/settings', '/inbox')).toBe(true);
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(state.draft).toBe(later);
  expect(state.pending).toBe(original);
  expect(Object.isFrozen(original)).toBe(true);
  const recovered = await sendReading(fixture.io, state.pending!, true, () => 0);
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[1]).toBe(original);
  expect(fixture.calls[1]!.expectedVersion).toBe(0);
  expect(fixture.calls[1]!.idempotencyKey).toBe(fixture.calls[0]!.idempotencyKey);
  expect(recovered.kind).toBe('confirmed');
  if (recovered.kind !== 'confirmed') throw new Error('Original save was not confirmed');
  state.known = recovered.preferences;
  state.pending = null;
  expect(readingNeedsNavigationDecision(state)).toBe(true);
  const teardown = navigation.block('/settings', '/inbox');
  navigation.deactivate();
  expect(await teardown).toBe(false);
  // Late work can refresh an old owner, but cannot resurrect its dialog or beforeunload warning.
  navigation.refresh();
  expect(navigation.blocked).toBe(false);
  expect(navigation.needsDecision()).toBe(false);
  expect(navigation.block('/settings', '/')).toBe(false);
});

test('an unresolved original command warns even with a matching draft; confirmed current settings release navigation', async () => {
  const fixture = readingFixture('lost');
  const original = readingMutation(fixture.initial, { ...fixture.initial, spoilerLevel: 1 })!;
  const state = { known: fixture.initial, draft: fixture.initial, pending: original as typeof original | null };
  const navigation = new SettingsNavigationDrafts();
  navigation.register({ kind: 'reading', needsDecision: () => readingNeedsNavigationDecision(state) });
  expect(readingNeedsNavigationDecision(state)).toBe(true);
  const leaving = navigation.block('/settings', '/');
  state.pending = null;
  navigation.refresh();
  expect(await leaving).toBe(false);
  expect(navigation.block('/settings', '/')).toBe(false);
});

test('reading and actual profile/public-activity state share one decision and owned cleanup releases it', async () => {
  const fixture = readingFixture();
  const state = { known: fixture.initial, draft: { ...fixture.initial, spoilerLevel: 1 as const }, pending: null };
  const editor = new ProfileEditor(createProfileStoryIO('lost'), profileStoryValues());
  editor.edit({ displayName: 'Sent profile' });
  await editor.submit('profile');
  editor.edit({
    biography: 'Later profile draft',
    publicViews: { ...editor.snapshot().draft!.publicViews, posts: false },
  });
  const before = editor.snapshot();
  const navigation = new SettingsNavigationDrafts();
  const removeReading = navigation.register({
    kind: 'reading',
    needsDecision: () => readingNeedsNavigationDecision(state),
  });
  let current = true;
  const removeProfile = navigation.register({
    kind: 'profile',
    needsDecision: () => current && profileNeedsNavigationDecision(editor.snapshot()),
  });
  const leaving = navigation.block('/settings', '/');
  expect([...navigation.kinds()]).toEqual(['reading', 'profile']);
  expect(navigation.block('/settings', '/inbox')).toBe(true);
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(editor.snapshot()).toBe(before);
  expect(editor.snapshot().attempt).toBe(before.attempt);
  const next = navigation.block('/settings', '/inbox');
  current = false;
  removeReading();
  navigation.refresh();
  expect(await next).toBe(false);
  removeProfile();
  // StrictMode can reconnect with a fresh owned registration; an old cleanup cannot remove it.
  const removeAgain = navigation.register({
    kind: 'reading',
    needsDecision: () => readingNeedsNavigationDecision(state),
  });
  removeReading();
  const reconnected = navigation.block('/settings', '/');
  expect(reconnected).toBeInstanceOf(Promise);
  removeAgain();
  expect(await reconnected).toBe(false);
});
