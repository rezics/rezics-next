import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledSources } from '@rezics/definitions/bundled';
import { compileCatalogue } from '@rezics/definitions/compile';
import { EXTENSION_FORMAT, extensionDigest, termPrefix, type Extension } from '@rezics/definitions/extension';
import { releaseDigest } from '@rezics/definitions';
import { VERTICAL_LOCALES, verticalManifests } from '../support/manifests.ts';
import { createSemanticDriver } from './outcome-binding.ts';
import type { SemanticOutcomeDriver } from './outcome-driver.ts';

let driver: SemanticOutcomeDriver;
const key = () => ({ 'Idempotency-Key': JSON.stringify(randomUUID()) });

beforeAll(async () => {
  driver = await createSemanticDriver();
  await driver.projection('paused');
}, 180_000);
afterAll(async () => {
  await driver?.close();
});

function sourcesFor(count: number) {
  const bundled = bundledSources();
  const extra = verticalManifests(count);
  const imports = Array.from({ length: count }, (_, index) => `  - v${index}`).join('\n');
  return {
    root: bundled.root,
    schemas: {
      ...bundled.schemas,
      ...extra.schemas,
      'rezics.yaml': `${bundled.schemas['rezics.yaml']!.trimEnd()}\n${imports}\n`,
    },
    presentation: { ...bundled.presentation, ...extra.presentation },
    contexts: bundled.contexts,
  };
}

test('platform and Context editors publish, resume, activate and use a compiled fixture vertical with independent pinned reads', async () => {
  const send = driver.fixtures.send;
  const editor = await driver.fixtures.person('publication-workspace-editor');
  const rival = await driver.fixtures.person('publication-workspace-rival');
  const ungranted = await driver.fixtures.person('publication-workspace-ungranted');
  await driver.fixtures.grantAccount(editor, [
    'definitions:publish',
    'definitions:activate',
    'gate:definition_publication',
    'subject:create',
    'context:create',
  ]);
  await driver.fixtures.grantAccount(rival, [
    'definitions:publish',
    'definitions:activate',
    'gate:definition_publication',
  ]);

  const anonymous = await send(null, 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(anonymous.status, JSON.stringify(anonymous.body)).toBe(401);
  const closed = await send(ungranted, 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(closed.status, JSON.stringify(closed.body)).toBe(403);
  expect((closed.body as { code?: string }).code).toBe('platform_closed');
  const suspended = await driver.request('suspended', 'POST', '/v1/definitions/imports', { document: { types: {} } });
  expect(suspended.status).toBe(401);

  const invalid = await send(editor, 'POST', '/v1/definitions/imports', { document: { format: 'nope' } });
  expect(invalid.status, JSON.stringify(invalid.body)).toBe(200);
  const invalidBody = invalid.body as { kind: string; diagnostics: { pointer: string; code: string }[] };
  expect(invalidBody.kind).toBe('invalid');
  expect(invalidBody.diagnostics[0]?.pointer).toBe('/document');

  const classes: Record<string, object> = {};
  const labels: Record<string, string> = {};
  for (let index = 0; index < 10; index++) {
    const name = `T${index}`;
    classes[name] = { class_uri: `scale:${name}`, annotations: { library: { id: 'fixture.catalogue' } } };
    labels[`scale:${name}`] = `Type ${name}`;
  }
  const ten = {
    root: 'main.yaml',
    schemas: {
      'main.yaml': JSON.stringify({
        id: 'https://catalogue.example/ten',
        name: 'ten',
        version: '1',
        prefixes: { scale: 'https://catalogue.example/types/', linkml: 'https://w3id.org/linkml/' },
        imports: ['linkml:types'],
        classes,
        slots: {},
      }),
    },
    presentation: { en: JSON.stringify({ types: labels, properties: {} }) },
  };
  const compiledTen = await compileCatalogue(ten);
  expect(Object.keys(compiledTen.types)).toHaveLength(10);
  const measured = await send(editor, 'POST', '/v1/definitions/imports', { document: ten });
  expect(measured.status, JSON.stringify(measured.body)).toBe(200);
  expect((measured.body as { identity: { digest: string } }).identity.digest).toBe(releaseDigest(compiledTen));

  const vertical = sourcesFor(1);
  const compiled = await compileCatalogue(vertical);
  const preview = await send(editor, 'POST', '/v1/definitions/imports', { document: vertical });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const previewBody = preview.body as {
    kind: string;
    identity: { digest: string; version: string };
    diagnostics: unknown[];
    comparison: { addedTypes: string[] };
    operations: { grant: string; admitted: boolean; publish: boolean };
    current: { digest: string; head: number };
    document: { types?: Record<string, unknown> } | null;
  };
  expect(previewBody.kind).toBe('sources');
  expect(previewBody.diagnostics).toEqual([]);
  expect(previewBody.identity.digest).toBe(releaseDigest(compiled));
  expect(previewBody.document?.types && Object.keys(previewBody.document.types).length).toBeGreaterThan(0);
  expect(previewBody.operations).toMatchObject({ grant: 'definition_publication', admitted: true, publish: true });
  expect(previewBody.comparison.addedTypes.some((id) => id.startsWith('ex:V0'))).toBe(true);
  const previousHead = previewBody.current.head;
  const previousDigest = previewBody.current.digest;

  const publishHeaders = key();
  const first = await send(editor, 'POST', '/v1/definitions/releases', { release: compiled }, publishHeaders);
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(first.body).toEqual({ digest: previewBody.identity.digest });
  const replay = await send(editor, 'POST', '/v1/definitions/releases', { release: compiled }, publishHeaders);
  expect(replay.status).toBe(201);
  expect(replay.body).toEqual(first.body);

  const independent = await send(null, 'GET', `/v1/definitions/releases/${previewBody.identity.digest}`);
  expect(independent.status).toBe(200);
  expect((independent.body as { digest: string }).digest).toBe(previewBody.identity.digest);

  const stale = await send(
    editor,
    'POST',
    `/v1/definitions/releases/${previewBody.identity.digest}:activate`,
    { expected_head: previousHead === 0 ? 1 : previousHead - 1 },
    key(),
  );
  expect(stale.status, JSON.stringify(stale.body)).toBe(409);
  const refreshed = await send(editor, 'GET', '/v1/definitions/active');
  expect((refreshed.body as { head: number }).head).toBe(previousHead);
  const activated = await send(
    editor,
    'POST',
    `/v1/definitions/releases/${previewBody.identity.digest}:activate`,
    { expected_head: previousHead },
    key(),
  );
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  const competing = await send(
    rival,
    'POST',
    `/v1/definitions/releases/${previousDigest}:activate`,
    { expected_head: previousHead },
    key(),
  );
  expect(competing.status, JSON.stringify(competing.body)).toBe(409);

  const pinnedOld = await send(null, 'GET', `/v1/definitions/releases/${previousDigest}`);
  const pinnedNew = await send(null, 'GET', `/v1/definitions/releases/${previewBody.identity.digest}`);
  const active = await send(null, 'GET', '/v1/definitions/active');
  expect(pinnedOld.status).toBe(200);
  expect((pinnedOld.body as { digest: string }).digest).toBe(previousDigest);
  expect((pinnedNew.body as { digest: string }).digest).toBe(previewBody.identity.digest);
  expect((active.body as { digest: string }).digest).toBe(previewBody.identity.digest);

  const typeId =
    previewBody.comparison.addedTypes.find((id) => id.endsWith('Work')) ?? previewBody.comparison.addedTypes[0]!;
  const created = await send(
    editor,
    'POST',
    '/v1/subjects',
    { type: typeId, labels: { en: 'Fixture vertical work' } },
    key(),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subjectId = (created.body as { subject: { id: string } }).subject.id;
  const read = await send(null, 'GET', `/v1/subjects/${subjectId}`);
  expect(read.status).toBe(200);
  expect((read.body as { subject: { type: string } }).subject.type).toBe(typeId);
  for (const locale of VERTICAL_LOCALES) {
    const descriptor = await send(null, 'GET', `/v1/definitionTypes/${encodeURIComponent(typeId)}?locale=${locale}`);
    expect(descriptor.status, `${locale} ${JSON.stringify(descriptor.body)}`).toBe(200);
    expect((descriptor.body as { label: string }).label.length).toBeGreaterThan(0);
  }

  const contextResult = await send(editor, 'POST', '/v1/contexts', { labels: { en: 'Publication extension' } }, key());
  expect(contextResult.status, JSON.stringify(contextResult.body)).toBe(201);
  const context = (contextResult.body as { context: { id: string } }).context.id;
  await driver.fixtures.grantAccount(editor, ['definitions:publish', 'definitions:activate'], context);
  const extension: Extension = {
    format: EXTENSION_FORMAT,
    context,
    terms: {
      [`${termPrefix(context)}:boardLink`]: {
        description: { en: 'Board relation' },
        labels: Object.fromEntries(
          VERTICAL_LOCALES.map((locale) => [locale, locale === 'en' ? 'board link' : `board ${locale}`]),
        ),
        domain: [typeId],
        targets: [typeId],
        multivalued: true,
        relation: { group: 'association', inverse: 'none' },
      },
    },
  };
  const extensionPreview = await send(editor, 'POST', '/v1/definitions/imports', { document: extension, context });
  expect(extensionPreview.status, JSON.stringify(extensionPreview.body)).toBe(200);
  expect((extensionPreview.body as { identity: { digest: string } }).identity.digest).toBe(extensionDigest(extension));
  const publishedExtension = await send(
    editor,
    'POST',
    `/v1/contexts/${context}/definitions/extensions`,
    { extension },
    key(),
  );
  expect(publishedExtension.status, JSON.stringify(publishedExtension.body)).toBe(201);
  const extensionDigestValue = (publishedExtension.body as { digest: string }).digest;
  const extensionRead = await send(
    null,
    'GET',
    `/v1/contexts/${context}/definitions/extensions/${extensionDigestValue}`,
  );
  expect(extensionRead.status, JSON.stringify(extensionRead.body)).toBe(200);
  expect((extensionRead.body as { digest: string }).digest).toBe(extensionDigestValue);
  const currentExtension = await send(editor, 'GET', `/v1/contexts/${context}/definitions`);
  const extensionHead = (currentExtension.body as { head: number }).head;
  const activatedExtension = await send(
    editor,
    'POST',
    `/v1/contexts/${context}/definitions/extensions/${extensionDigestValue}:activate`,
    { expected_head: extensionHead === 0 ? null : extensionHead },
    key(),
  );
  expect(activatedExtension.status, JSON.stringify(activatedExtension.body)).toBe(200);

  await driver.fixtures.grantAccount(ungranted, ['definitions:publish']);
  const revokedGate = await send(ungranted, 'POST', '/v1/definitions/imports', { document: vertical });
  expect(revokedGate.status).toBe(403);
}, 180_000);
