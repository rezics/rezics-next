import { expect, test } from 'bun:test';
import { readingFixture } from '../src/kernel/fake/settings-preferences-reading';
import { createProfileStoryIO, profileStoryValues } from '../src/kernel/fake/settings-profile';
import { SettingsNavigationDrafts, readingNeedsNavigationDecision } from '../src/settings/reading-navigation';
import { readingMutation, sendReading } from '../src/settings/reading-preferences';
import { ProfileEditor } from '../src/settings/profile-write';
import { profileNeedsNavigationDecision } from '../src/settings/profile-navigation';
import { NotificationEditor, notificationsNeedNavigationDecision } from '../src/settings/notification-recovery';
import { CollectionPrivacyEditor, CollectionPrivacyPager } from '../src/settings/collection-privacy-recovery';
import { VerificationRecovery } from '../src/settings/verification-recovery';
import type { AgentVerificationRequest, VerificationInput } from '../src/settings/verification-core';
import {
  collectionPrivacyNeedsNavigationDecision,
  settingsDraftViewerIsCurrent,
  verificationNeedsNavigationDecision,
} from '../src/settings/settings-draft-state';
import { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../src/session/query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import { NotificationsCard } from '../src/settings/notifications';

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

test('notice originals and later drafts require a decision until exact recovery or Use current', async () => {
  const calls: unknown[] = [];
  const editor = new NotificationEditor(settingsPreferencePage({ reply: true, mention: true }, 0), {
    save: async (input) => {
      calls.push(input);
      if (calls.length === 1) throw new Error('Lost response');
      return {
        ok: true,
        notifications: { reply: false, mention: true },
        version: 1,
        page: settingsPreferencePage({ reply: false, mention: true }, 1),
      };
    },
    read: async () => ({
      signedIn: true,
      preferences: { spoilerLevel: 0, suitability: 'blur', version: 1 },
      notifications: { reply: false, mention: true },
      page: settingsPreferencePage({ reply: false, mention: true }, 1),
      securityHref: null,
    }),
  });
  const navigation = new SettingsNavigationDrafts();
  navigation.register({
    kind: 'notifications',
    needsDecision: () => notificationsNeedNavigationDecision(editor.snapshot()),
  });
  expect(navigation.block('/settings', '/')).toBe(false);
  await editor.edit('reply', false, 0);
  const original = editor.snapshot().pending;
  await editor.edit('reply', true, 0);
  // Even restoring the known value cannot resolve a lost original.
  expect(editor.snapshot().draft).toEqual(editor.snapshot().known.notifications);
  expect(navigation.needsDecision()).toBe(true);
  const leaving = navigation.block('/settings', '/inbox');
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(editor.snapshot().pending).toBe(original);
  await editor.retry();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(calls[0]);
  expect(editor.snapshot().pending).toBeNull();
  expect(navigation.needsDecision()).toBe(true);
  editor.useCurrent();
  expect(navigation.block('/settings', '/inbox')).toBe(false);
});

test('Collection row decisions retain unknown originals through denied reads and release on row teardown', async () => {
  const collection = { id: 'collection', title: 'Reading', visibility: 'private' as const, revision: 1 };
  const editor = new CollectionPrivacyEditor(collection, {
    save: async () => ({ ok: false, reason: 'unavailable' }),
    read: async () => ({ ok: false, reason: 'forbidden' }),
  });
  const navigation = new SettingsNavigationDrafts();
  const remove = navigation.register({
    kind: 'collection-privacy',
    needsDecision: () => collectionPrivacyNeedsNavigationDecision(editor.snapshot()),
  });
  expect(navigation.needsDecision()).toBe(false);
  await editor.edit('public');
  const original = editor.snapshot().attempt;
  await editor.edit('private');
  expect(editor.snapshot().desired).toBe(editor.snapshot().current.visibility);
  const leaving = navigation.block('/settings', '/collections/collection');
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(editor.snapshot().attempt).toBe(original);
  await editor.reload();
  expect(editor.snapshot().readRefusal).toBe('forbidden');
  expect(navigation.needsDecision()).toBe(true);
  const teardown = navigation.block('/settings', '/');
  remove();
  editor.dispose();
  expect(await teardown).toBe(false);

  const saved = new CollectionPrivacyEditor(collection, {
    save: async (input) => ({ ok: true, collection: { ...collection, visibility: input.visibility, revision: 2 } }),
    read: async () => ({ ok: true, value: collection }),
  });
  await saved.edit('public');
  expect(collectionPrivacyNeedsNavigationDecision(saved.snapshot())).toBe(false);

  const pager = new CollectionPrivacyPager(async (cursor) =>
    cursor === null
      ? { ok: true, value: { collections: [collection], next: 'next' } }
      : { ok: false, reason: 'forbidden' },
  );
  await pager.load();
  await pager.load();
  expect(pager.snapshot().collections).toEqual([]);
});

test('verification latest matching status cannot resolve UNKNOWN; acknowledged exact fields are clean and later edits are protected', async () => {
  const draft = {
    subject: 'subject',
    statement: 'My identity',
    links: [{ label: 'Site', url: 'https://example.test' }],
  };
  const receipt: AgentVerificationRequest = {
    id: 'request',
    accountId: 'alice',
    accountKind: 'actor',
    requestedBy: 'alice',
    catalogueSubjectId: draft.subject,
    statement: draft.statement,
    links: draft.links,
    state: 'pending',
    reason: null,
    problem: null,
    decisionReceiptId: null,
    decidedBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const calls: VerificationInput[] = [];
  let current: AgentVerificationRequest | null = null;
  const controller = new VerificationRecovery('alice', {
    read: async () => ({
      accountId: 'alice',
      verificationRequest: current,
      viewerActions: current
        ? current.state === 'pending'
          ? [{ action: 'account:update', operations: ['account.withdraw_verification'] }]
          : [{ action: 'account:update', operations: ['account.request_verification'] }]
        : [{ action: 'account:update', operations: ['account.request_verification'] }],
      subjectTitle: null,
    }),
    request: async (_, input) => {
      calls.push(input);
      current = receipt;
      if (calls.length === 1) throw new Error('Lost response');
      return { ok: true, verificationRequest: receipt };
    },
    withdraw: async () => {
      throw new Error('No withdrawal requested');
    },
  });
  const empty = { subject: null, statement: '', links: [{ label: '', url: '' }] };
  expect(verificationNeedsNavigationDecision(controller.snapshot(), empty)).toBe(false);
  await controller.reload();
  expect(verificationNeedsNavigationDecision(controller.snapshot(), empty)).toBe(false);
  const sending = controller.submit(draft);
  expect(verificationNeedsNavigationDecision(controller.snapshot(), empty)).toBe(true);
  await sending;
  const original = controller.snapshot().attempt;
  await controller.reload();
  expect(controller.snapshot().current?.verificationRequest).toBe(receipt);
  expect(controller.snapshot().attempt).toBe(original);
  const navigation = new SettingsNavigationDrafts();
  navigation.register({
    kind: 'verification',
    needsDecision: () => verificationNeedsNavigationDecision(controller.snapshot(), draft),
  });
  const leaving = navigation.block('/settings', '/');
  navigation.stay();
  expect(await leaving).toBe(true);
  expect(controller.snapshot().attempt).toBe(original);
  await controller.retry();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(calls[0]);
  expect(controller.snapshot().attempt).toBeNull();
  expect(
    verificationNeedsNavigationDecision(
      controller.snapshot(),
      { ...draft, links: [...draft.links, { label: '', url: '' }] },
      draft,
    ),
  ).toBe(false);
  expect(
    verificationNeedsNavigationDecision(controller.snapshot(), { ...draft, statement: 'Later draft' }, draft),
  ).toBe(true);
  expect(verificationNeedsNavigationDecision(controller.snapshot(), empty, draft)).toBe(true);
  expect(navigation.block('/settings', '/')).toBe(false);
});

test('all Settings kinds share one destination decision; Leave settles once and native signout bypasses every kind', async () => {
  const navigation = new SettingsNavigationDrafts();
  const kinds = ['reading', 'profile', 'notifications', 'collection-privacy', 'verification'] as const;
  const removes = kinds.map((kind) => navigation.register({ kind, needsDecision: () => true }));
  expect([...navigation.kinds()]).toEqual([...kinds]);
  expect(navigation.block('/settings', '/settings')).toBe(false);
  let completions = 0;
  const destination = navigation.block('/settings', '/inbox') as Promise<boolean>;
  void destination.then(() => completions++);
  expect(navigation.block('/settings', '/')).toBe(true);
  navigation.leave();
  navigation.leave();
  expect(await destination).toBe(false);
  expect(completions).toBe(1);
  const signout = navigation.block('/settings', '/');
  // The existing native POST submit listener calls this same immediate bypass.
  navigation.deactivate();
  expect(await signout).toBe(false);
  navigation.refresh();
  expect(navigation.needsDecision()).toBe(false);
  for (const remove of removes) remove();
  navigation.activate();
  expect(navigation.needsDecision()).toBe(false);
  const nextViewer = navigation.register({ kind: 'verification', needsDecision: () => false });
  for (const remove of removes) remove();
  expect(navigation.block('/settings', '/')).toBe(false);
  nextViewer();
});

test('live actor and CSRF transitions retire old registrations before late controller updates can warn the next viewer', async () => {
  const client = new QueryClient();
  const owner = { subject: 'alice', csrfToken: 'alice-token' };
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', ...owner });
  const navigation = new SettingsNavigationDrafts();
  const removes = (['notifications', 'collection-privacy', 'verification'] as const).map((kind) =>
    navigation.register({
      kind,
      needsDecision: () =>
        settingsDraftViewerIsCurrent(owner, client.getQueryData(sessionQuery.queryKey), owner.csrfToken),
    }),
  );
  const leaving = navigation.block('/settings', '/inbox');
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', ...owner, csrfToken: 'rotated-token' });
  navigation.refresh();
  expect(await leaving).toBe(false);
  expect(navigation.needsDecision()).toBe(false);
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'alice-token' });
  navigation.refresh();
  expect(navigation.block('/settings', '/')).toBe(false);
  for (const remove of removes) remove();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  expect(navigation.needsDecision()).toBe(false);
  client.clear();
});

test('standalone notice cards keep their native form without requiring a navigation or query provider', () => {
  const html = renderToStaticMarkup(
    createElement(NotificationsCard, {
      initial: settingsPreferencePage({ reply: true }, 0),
      version: 0,
      csrfToken: null,
      action: '/en/settings',
      onVersionChange: () => {},
    }),
  );
  expect(html).toContain('action="/en/settings"');
  expect(html).toContain('name="notificationKind" value="reply"');
});

test('the validated verification payload treats an empty chooser as no selection without hiding later text', () => {
  const state = {
    current: {
      accountId: 'alice',
      verificationRequest: null,
      viewerActions: [{ action: 'account:update', operations: ['account.request_verification'] }],
      subjectTitle: null,
    },
    attempt: null,
    phase: 'idle' as const,
  };
  const acknowledged = { subject: 'subject', statement: 'Submitted evidence', links: [] };
  const empty = { subject: '', statement: '', links: [] };
  expect(verificationNeedsNavigationDecision(state, empty, acknowledged)).toBe(false);
  expect(verificationNeedsNavigationDecision(state, { ...empty, statement: 'Later evidence' }, acknowledged)).toBe(
    true,
  );
});
