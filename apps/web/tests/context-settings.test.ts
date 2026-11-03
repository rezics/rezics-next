import { describe, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { contextFixture } from '../src/features/contexts/fixtures';
import { parseCommand } from '../src/features/contexts/model';
import { readSettingsInventory } from '../src/features/contexts/settings-api';
import {
  capturedMatches,
  emptyLabelRow,
  filterSettings,
  labelsFromDraft,
  pageSettings,
  parseSettingsSnapshot,
  policyFingerprint,
  policyPreview,
  SETTINGS_CAP,
  SETTINGS_PAGE,
} from '../src/features/contexts/settings';
import { editorialCommand } from '../src/features/catalogue/editorial-context';
import { editorialContextFixture } from '../src/kernel/fake/editorial-context';
import {
  asEditorialSettingsFailure,
  previewChanged,
  reviewedCreateBody,
} from '../src/features/catalogue/context-settings';

const key = () => crypto.randomUUID();
const digest = 'sha256:configured-context-release';

function release(count = 2, extra: Record<string, unknown> = {}) {
  const contexts: Record<string, { labels: Record<string, string>; defaults: Record<string, 'inherit' | 'suppress'> }> =
    {
      'inherit-readers': {
        labels: { en: 'Inherit readers', ja: '継承する読者' },
        defaults: { 'schema:url': 'inherit' },
      },
      'suppress-readers': {
        labels: { en: 'Suppress readers', ja: '抑制する読者' },
        defaults: { 'schema:url': 'suppress' },
      },
    };
  for (let index = 0; index < Math.max(0, count - 2); index++)
    contexts[`policy-${String(index).padStart(3, '0')}`] = {
      labels: { en: `Policy ${index}` },
      defaults: { 'schema:name': index % 2 ? 'suppress' : 'inherit' },
    };
  return {
    contexts,
    properties: {
      'schema:url': { labels: { en: 'URL', ja: 'URL' } },
      'schema:name': { labels: { en: 'Name' } },
    },
    ...extra,
  };
}

function definitionsClient(status: { active?: number; release?: number; digest?: string } = {}) {
  const calls: { method: string; path: string; authorization: string | null; session: string | null }[] = [];
  const client = createKernelClient('https://definitions.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      calls.push({
        method: request.method,
        path,
        authorization: request.headers.get('authorization'),
        session: request.headers.get('rezics-session-token'),
      });
      const json = (body: unknown, code = 200) =>
        new Response(JSON.stringify(body), {
          status: code,
          headers: { 'content-type': 'application/json', 'rezics-session-token': 'definition-session' },
        });
      if (path === '/v1/definitions/active') {
        if (status.active) return json({ code: 'overloaded' }, status.active);
        return json({ digest: status.digest ?? digest, head: 3 });
      }
      if (path.startsWith('/v1/definitions/releases/')) {
        if (status.release) return json({ code: 'overloaded' }, status.release);
        const selected = decodeURIComponent(path.slice('/v1/definitions/releases/'.length));
        return json({ digest: selected, release: release() });
      }
      return json({ code: 'not_found' }, 404);
    }) as typeof fetch,
  });
  return { client, calls };
}

describe('Released editorial settings inventory and sealed Context creation', () => {
  test('one owned snapshot pages finite released policies and keeps missing labels on the rule', () => {
    const snapshot = parseSettingsSnapshot(digest, release(128, { properties: {} }))!;
    expect(snapshot.digest).toBe(digest);
    expect(snapshot.ids).toHaveLength(128);
    expect(snapshot.ids.length).toBeLessThanOrEqual(SETTINGS_CAP);
    const filtered = filterSettings(snapshot, 'suppress', 'en');
    expect(filtered.some((choice) => choice.id === 'suppress-readers')).toBe(true);
    const page = pageSettings(filtered, 0);
    expect(page.items.length).toBeLessThanOrEqual(SETTINGS_PAGE);
    expect(page.previous).toBeNull();
    const later = pageSettings(snapshot.ids.map((id) => snapshot.contexts[id]!), SETTINGS_PAGE);
    expect(later.previous).toBe(0);
    const inherit = policyPreview(snapshot, 'inherit-readers');
    const suppress = policyPreview(snapshot, 'suppress-readers');
    expect(inherit.defaults).toEqual({ 'schema:url': 'inherit' });
    expect(suppress.defaults).toEqual({ 'schema:url': 'suppress' });
    expect(policyFingerprint(inherit)).not.toBe(policyFingerprint(suppress));
    expect(capturedMatches(inherit, { settings: { id: 'inherit-readers', release: digest }, defaults: inherit.defaults })).toBe(
      true,
    );
    expect(capturedMatches({ settings: null, release: digest, defaults: {} }, { settings: null, defaults: {} })).toBe(true);
    expect(parseSettingsSnapshot(digest, { contexts: { 'Bad': { labels: { en: 'x' }, defaults: {} } } })!.ids).toEqual([]);
    const unlabelled = parseSettingsSnapshot(digest, {
      contexts: { quiet: { labels: { en: 'Quiet' }, defaults: { 'schema:url': 'suppress' } } },
      properties: {},
    })!;
    expect(unlabelled.properties['schema:url']).toEqual({});
  });

  test('active, denied, unavailable and empty inventories stay distinct', async () => {
    const ready = definitionsClient();
    const loaded = await readSettingsInventory(ready.client, 'Bearer reader', undefined, 'prior-session');
    expect(loaded).toMatchObject({ kind: 'ready', snapshot: { digest }, session: 'definition-session' });
    expect(ready.calls.map((call) => call.path)).toEqual([
      '/v1/definitions/active',
      `/v1/definitions/releases/${digest}`,
    ]);
    expect(ready.calls.every((call) => call.authorization === 'Bearer reader')).toBe(true);
    expect(asEditorialSettingsFailure(loaded)).toBeNull();
    const denied = await readSettingsInventory(definitionsClient({ active: 403 }).client, 'Bearer reader');
    expect(denied.kind).toBe('denied');
    expect(asEditorialSettingsFailure(denied)).toMatchObject({ ok: false, reason: 'denied' });
    const unavailable = await readSettingsInventory(definitionsClient({ release: 503 }).client, 'Bearer reader');
    expect(unavailable.kind).toBe('unavailable');
    const empty = parseSettingsSnapshot(digest, { contexts: {} })!;
    expect(empty.ids).toEqual([]);
    const pinned = await readSettingsInventory(ready.client, 'Bearer reader', digest);
    expect(pinned.kind === 'ready' && pinned.snapshot.digest).toBe(digest);
  });

  test('both creation callers post a reviewed settings ID, freeze multilingual labels and retry the same body', async () => {
    const labels = { en: 'Readers’ desk', ja: '読者席' };
    const workspace = parseCommand({ operation: 'create', key: key(), labels, settings: 'suppress-readers' });
    expect(Object.isFrozen(workspace)).toBe(true);
    expect(workspace.operation === 'create' && Object.isFrozen(workspace.labels)).toBe(true);
    const fixture = contextFixture('create');
    const created = await fixture.api.submit(workspace);
    expect(created).toMatchObject({
      kind: 'confirmed',
      created: {
        settings: { id: 'suppress-readers', release: 'released-settings-digest' },
        defaults: { 'core:description': 'inherit', 'core:rating': 'suppress' },
      },
    });
    const posted = fixture.calls.find((call) => call.method === 'POST' && call.path === '/v1/contexts')!;
    expect(posted.body).toEqual({ labels, settings: 'suppress-readers' });
    const unknown = contextFixture('unknown');
    const sealed = parseCommand({ operation: 'create', key: key(), labels, settings: 'inherit-readers' });
    expect(await unknown.api.submit(sealed)).toMatchObject({ kind: 'unknown' });
    expect(await unknown.api.submit(sealed)).toMatchObject({ kind: 'confirmed' });
    const writes = unknown.calls.filter((call) => call.method === 'POST' && call.path === '/v1/contexts');
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(writes[0]!.body).toEqual({ labels, settings: 'inherit-readers' });
    expect(writes[0]!.headers.get('idempotency-key')).toBe(writes[1]!.headers.get('idempotency-key'));

    const editorial = editorialCommand({ operation: 'create', key: key(), labels, settings: 'inherit-readers' });
    const catalogue = editorialContextFixture('create');
    expect(await catalogue.transport.submit(editorial)).toMatchObject({
      ok: true,
      context: { settings: { id: 'inherit-readers' }, defaults: { 'schema:url': 'suppress' } },
    });
    expect(catalogue.calls[0]!.body).toEqual({ labels, settings: 'inherit-readers' });
    const preview = policyPreview(parseSettingsSnapshot(digest, release())!, 'inherit-readers');
    expect(reviewedCreateBody(labels, preview)).toEqual({ labels, settings: 'inherit-readers' });
    expect(reviewedCreateBody(labels, { settings: null, release: digest, defaults: {} })).toEqual({ labels });
    expect(previewChanged(preview, policyPreview(parseSettingsSnapshot(digest, release())!, 'suppress-readers'))).toBe(
      true,
    );
    expect(() => editorialCommand({ ...editorial, owner: 'creator' })).toThrow();
    expect(() => editorialCommand({ operation: 'create', key: key(), labels, settings: 'Not-valid' })).toThrow();
    const none = contextFixture('create');
    expect(
      await none.api.submit(parseCommand({ operation: 'create', key: key(), labels: { en: 'Plain' } })),
    ).toMatchObject({ kind: 'confirmed', created: { settings: null, defaults: {} } });
    expect(none.calls.find((call) => call.method === 'POST' && call.path === '/v1/contexts')!.body).toEqual({
      labels: { en: 'Plain' },
    });
    const rows = [emptyLabelRow('en'), { ...emptyLabelRow('ja'), text: '読者' }];
    rows[0] = { ...rows[0]!, language: 'en', text: 'Desk' };
    expect(labelsFromDraft(rows)).toEqual({ en: 'Desk', ja: '読者' });
  });
});
