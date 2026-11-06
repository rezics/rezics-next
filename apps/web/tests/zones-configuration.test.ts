import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_LOCALES } from '@rezics/composition';
import { zoneEditorFixture } from '../src/features/zones/editor/fixture';
import {
  configurationErrors,
  readerHref,
  ZoneEditorSession,
  type ZoneConfigureInput,
} from '../src/features/zones/editor/model';
import { EditorFailure, EditorLoading, ZoneConfigurationEditor } from '../src/features/zones/editor/view';
import { m } from '../src/paraglide/messages.js';

function draft(session: ZoneEditorSession): ZoneConfigureInput {
  const value = session.snapshot().draft;
  if (!value) throw new Error('Expected a loaded draft');
  return structuredClone(value);
}

test('A Zone owner configures saves previews publishes and resolves conflicts through the actual persisted resource', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, await fixture.transport.load());
  const changed = draft(session);
  changed.configuration.labels.en = 'My edited Zone';
  changed.configuration.scope = ['books/fiction'];
  changed.mounts = [
    fixture.initial.options.collections.kind === 'ready' ? fixture.initial.options.collections.value.items[0]!.id : '',
  ];
  changed.configuration.pages.push({
    route: 'guide',
    document: { root: { props: { appearance: { density: 'compact' } } }, content: [] },
  });
  session.edit(changed);
  await session.preview('');
  await session.publish('public');
  expect(fixture.calls.filter((call) => /:readPage|:publish/.test(call.url))).toHaveLength(0);
  const revision = fixture.current().zone.revision;
  await session.save();
  const put = fixture.calls.find((call) => call.method === 'PUT')!;
  expect(new URL(put.url).pathname).toBe(`/v1/zones/${fixture.id}/configuration`);
  expect(await put.json()).toEqual(changed);
  expect(put.headers.get('if-match')).toBe(`"${revision}"`);
  expect(put.headers.get('idempotency-key')).toMatch(/^"[0-9a-f-]{36}"$/);
  expect(fixture.current().configuration).toEqual(changed.configuration);
  expect(session.snapshot().saved?.zone.visibility).toBe('private');
  expect(session.dirty()).toBe(false);
  await session.preview('guide');
  const preview = fixture.calls.find((call) => call.url.endsWith(':readPage'))!;
  expect(await preview.json()).toEqual({ target: { route: 'guide' }, languages: ['en'] });
  expect(preview.headers.get('authorization')).toBe('Bearer current-zone-reader');
  expect(session.snapshot().preview).toMatchObject({
    kind: 'ready',
    value: { document: changed.configuration.pages[1]!.document },
  });
  await session.publish('unlisted');
  const publication = fixture.calls.find((call) => call.url.endsWith(':publish'))!;
  expect(await publication.json()).toEqual({ visibility: 'unlisted' });
  expect(publication.headers.get('if-match')).toBe('"900719925474099312346"');
  expect(publication.headers.get('idempotency-key')).not.toBe(put.headers.get('idempotency-key'));
  expect(fixture.current().configuration).toEqual(changed.configuration);
  expect(readerHref(fixture.id, 'guide', 'ja')).toBe(`/ja/zones/${fixture.id}/guide`);

  const local = draft(session);
  local.configuration.labels.en = 'Retain me';
  session.edit(local);
  fixture.externalChange();
  await session.save();
  expect(session.snapshot().failure?.status).toBe(412);
  expect(session.snapshot().draft).toEqual(local);
  expect(session.snapshot().conflict?.resource.kind).toBe('ready');
  const writes = fixture.calls.filter((call) => call.method === 'PUT').length;
  await session.save();
  await session.preview('');
  expect(fixture.calls.filter((call) => call.method === 'PUT')).toHaveLength(writes);
  session.resolve('reapply');
  expect(session.snapshot().draft?.configuration.scope).toEqual(['books/fiction']);
  expect(session.snapshot().draft?.mounts).toEqual(changed.mounts);
  expect(session.snapshot().draft?.configuration.labels.en).toBe('Retain me');
  await session.save();
  const reapplied = fixture.calls.filter((call) => call.method === 'PUT').at(-1)!;
  expect(reapplied.headers.get('if-match')).toBe('"900719925474099312348"');
  expect(fixture.current().configuration.labels.en).toBe('Retain me');
  expect(fixture.current().configuration.scope).toEqual(['books/fiction']);
  expect(fixture.current().mounts).toEqual(changed.mounts);
  fixture.externalChange();
  const localAgain = draft(session);
  localAgain.configuration.labels.en = 'Discard me';
  session.edit(localAgain);
  await session.save();
  session.resolve('reload');
  expect(session.snapshot().draft?.configuration.labels.en).toBe('Changed elsewhere');
  expect(session.dirty()).toBe(false);
});

test('errors retain drafts; identical retries retain a key while changed bodies get a new key and current grants control writes', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, fixture.initial);
  const local = draft(session);
  local.configuration.labels.en = 'Unsaved';
  session.edit(local);
  fixture.mode.mutationStatus = 503;
  await session.save();
  await session.save();
  expect(session.snapshot().draft).toEqual(local);
  let puts = fixture.calls.filter((call) => call.method === 'PUT');
  expect(puts[0]!.headers.get('idempotency-key')).toBe(puts[1]!.headers.get('idempotency-key'));
  const revised = draft(session);
  revised.configuration.labels.en = 'Different body';
  session.edit(revised);
  await session.save();
  puts = fixture.calls.filter((call) => call.method === 'PUT');
  expect(puts[2]!.headers.get('idempotency-key')).not.toBe(puts[0]!.headers.get('idempotency-key'));
  fixture.mode.configure = false;
  fixture.mode.publish = false;
  await session.refresh();
  session.resolve('reapply');
  const before = fixture.calls.length;
  await session.save();
  await session.publish('public');
  expect(fixture.calls).toHaveLength(before);
  expect(session.snapshot().draft).toEqual(revised);
});

test('the existing validator rejects unsafe pages, reserved routes, missing filters, duplicates and limits before a write', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, fixture.initial);
  const local = draft(session);
  local.configuration.pages.push({ route: 'subjects', document: { root: { props: {} }, content: [] } });
  local.configuration.labels.en = '<script>bad</script>';
  local.configuration.scope = ['invented/filter'];
  session.edit(local);
  await session.save();
  expect(session.snapshot().violations.map((error) => error.pointer)).toEqual(
    expect.arrayContaining(['/labels/en', '/pages/1/route', '/scope/0']),
  );
  expect(fixture.calls).toHaveLength(0);
  for (const route of ['Subjects', '/guide', 'guide/', 'a//b', '../guide', 'a%2fb', 'subjects/guide', 'a?b', 'a#b']) {
    const invalid = draft(session);
    invalid.configuration.pages[1]!.route = route;
    expect(configurationErrors(invalid, new Set()).some((error) => error.pointer === '/pages/1/route')).toBe(true);
  }
  const tooMany = draft(session);
  tooMany.configuration.pages = Array.from({ length: 17 }, (_, i) => ({
    route: i ? `page-${String(i).padStart(2, '0')}` : '',
    document: { root: { props: {} }, content: [] },
  }));
  expect(configurationErrors(tooMany, new Set())).toContainEqual({ pointer: '/pages', code: 'limit' });
});

test('accessible loading, denied, missing, validation, conflict and real preview failures remain honest in every locale', async () => {
  const fixture = zoneEditorFixture();
  const session = new ZoneEditorSession(fixture.transport, fixture.initial);
  const markup = () => renderToStaticMarkup(createElement(ZoneConfigurationEditor, { session, locale: 'en' }));
  expect(renderToStaticMarkup(createElement(EditorLoading))).toContain('aria-busy="true"');
  for (const locale of UI_LOCALES) {
    const html = renderToStaticMarkup(createElement(ZoneConfigurationEditor, { session, locale }));
    expect(html).toContain('zone-label-' + locale);
    expect(html).toContain('aria-labelledby="zone-preview-heading"');
    expect(html).toContain('target="_blank"');
  }
  const local = draft(session);
  local.configuration.labels.en = '';
  session.edit(local);
  await session.save();
  expect(markup()).toContain(m.zone_editor_validation());
  local.configuration.labels.en = 'Local';
  session.edit(local);
  fixture.externalChange();
  await session.save();
  expect(markup()).toContain(m.zone_editor_reapply());
  expect(markup()).toContain(m.zone_editor_reload());
  session.resolve('reload');
  for (const status of [403, 404, 503, 202]) {
    fixture.mode.previewStatus = status;
    await session.preview('');
    expect(session.snapshot().preview?.kind).toBe(status === 202 ? 'preparing' : 'failure');
    if (status === 503) expect(markup()).toContain('semantic_not_ready');
    expect(markup()).not.toContain('data-zone-shell');
  }
  for (const status of [401, 403, 404]) {
    const html = renderToStaticMarkup(
      createElement(EditorFailure, {
        failure: { kind: 'failure', status, code: status === 404 ? 'not_found' : 'forbidden' },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(String(status));
  }
});

test('an unsupported current-action resource shows the actual API failure and cannot authorize edits', async () => {
  const fixture = zoneEditorFixture();
  fixture.mode.actionsStatus = 400;
  const session = new ZoneEditorSession(fixture.transport, await fixture.transport.load());
  expect(session.snapshot().loaded.permissions).toEqual({
    configure: false,
    publish: false,
    available: false,
    failure: { kind: 'failure', status: 400, code: 'invalid_request', retryAfter: '1' },
  });
  const html = renderToStaticMarkup(createElement(ZoneConfigurationEditor, { session, locale: 'en' }));
  expect(html).toContain(m.zone_editor_actions_unavailable());
  expect(html).toContain('invalid_request');
  const writes = fixture.calls.filter((call) => call.method === 'PUT' || call.url.endsWith(':publish')).length;
  await session.save();
  await session.publish('public');
  expect(fixture.calls.filter((call) => call.method === 'PUT' || call.url.endsWith(':publish'))).toHaveLength(writes);
});
