import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_LOCALES, pickZoneName } from '@rezics/composition';
import { ZoneNameFields } from '../src/features/zones/editor/name-fields';
import { zoneEditorFixture } from '../src/features/zones/editor/fixture';
import { ZoneEditorSession } from '../src/features/zones/editor/model';
import { createOwnedZone } from '../src/features/zones/manage/request';
import { copyStarter } from '../src/features/zones/manage/starters';
import { m } from '../src/paraglide/messages.js';

// The real client, create adapter and editor session, with an isolated synthetic API.
// Native authorization/storage is covered by the separate, deferred Kernel naming journey.
test('A Zone can be created and renamed with one primary name and optional translations with deterministic localized fallback', async () => {
  const fixture = zoneEditorFixture();
  const request = new Request('https://site.fixture.test/create', {
    method: 'POST',
    headers: { authorization: fixture.authorization },
  });
  const labels = { ja: '私の本棚' };
  const created = await createOwnedZone(
    fixture.client,
    request,
    {},
    {
      starter: 'book',
      labels,
      primaryLanguage: 'ja',
      key: crypto.randomUUID(),
    },
  );
  expect(created.kind).toBe('saved');
  const posted = await fixture.calls[0]!.json();
  expect(posted.configuration).toEqual({ ...copyStarter('book'), labels, primaryLanguage: 'ja' });
  expect(posted).toMatchObject({ mounts: [], visibility: 'private' });
  expect(labels).toEqual({ ja: '私の本棚' });
  expect(fixture.current().configuration.labels).toEqual(labels);
  expect(pickZoneName(fixture.current().zone, 'fr')).toEqual({ text: '私の本棚', lang: 'ja' });

  const session = new ZoneEditorSession(fixture.transport, await fixture.transport.load());
  const renamed = structuredClone(session.snapshot().draft!);
  renamed.configuration.labels = { ja: '新しい本棚', de: 'Mein Regal' };
  session.edit(renamed);
  await session.save();
  expect(session.snapshot().notice).toBe('saved');
  const reloaded = await fixture.transport.load();
  expect(reloaded.resource.kind).toBe('ready');
  if (reloaded.resource.kind !== 'ready') throw new Error('Expected saved configuration');
  expect(reloaded.resource.value.configuration).toEqual(renamed.configuration);
  expect(pickZoneName(reloaded.resource.value.zone, 'de')).toEqual({ text: 'Mein Regal', lang: 'de' });
  expect(pickZoneName(reloaded.resource.value.zone, 'fr')).toEqual({ text: '新しい本棚', lang: 'ja' });

  delete renamed.configuration.labels.de;
  session.edit(renamed);
  await session.save();
  await session.preview('');
  expect(fixture.current().configuration.labels).toEqual({ ja: '新しい本棚' });
  const preview = session.snapshot().preview;
  expect(preview?.kind).toBe('ready');
  if (preview?.kind === 'ready')
    expect(pickZoneName(preview.value.zone, 'de')).toEqual({ text: '新しい本棚', lang: 'ja' });

  const calls = fixture.calls.length;
  const invalid = await createOwnedZone(
    fixture.client,
    request,
    {},
    {
      starter: 'book',
      labels: { ja: ' ' },
      primaryLanguage: 'ja',
      key: crypto.randomUUID(),
    },
  );
  expect(invalid).toEqual({ kind: 'invalid', fields: ['/configuration/labels/ja'] });
  expect(fixture.calls).toHaveLength(calls);
});

test('Zone name controls localize labels and associate corrections without adding absent languages', () => {
  for (const locale of UI_LOCALES) {
    const options = { locale };
    const html = renderToStaticMarkup(
      createElement(ZoneNameFields, {
        locale,
        primaryLanguage: 'ja',
        labels: { ja: '本棚', de: '' },
        disabled: false,
        errors: ['/configuration/labels/de'],
        onChange: () => {},
      }),
    );
    expect(html).toContain(m.zone_name_primary({}, options));
    expect(html).toContain(m.zone_name_fallback({}, options));
    expect(html).toContain(m.zone_name_translations({}, options));
    expect(html).toContain('aria-describedby="zone-name-help zone-label-de-error"');
    expect(html).toContain('id="zone-label-de-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      m.zone_name_invalid({ language: new Intl.DisplayNames([locale], { type: 'language' }).of('de')! }, options),
    );
    expect(html).not.toContain('id="zone-label-en"');
    expect(html).not.toContain(
      m.zone_name_remove({ language: new Intl.DisplayNames([locale], { type: 'language' }).of('ja')! }, options),
    );
  }
});
