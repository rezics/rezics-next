import { expect, test } from 'bun:test';
import {
  parseImportedText,
  publicationHref,
  repairableDiagnostics,
  workspacePhase,
} from '../src/features/catalogue/definition-publication/model';
import { definitionPublicationFixture } from '../src/features/catalogue/definition-publication/fixtures';
import { grantedPublicationOperations } from '@rezics/definitions';

test('imported file diagnostics name the repairable field and grant-closed workspaces stay closed', () => {
  const broken = parseImportedText('broken.txt', 'not-json');
  expect('diagnostics' in broken && broken.diagnostics[0]?.pointer).toBe('/document');
  const empty = parseImportedText('empty.json', '   ');
  expect('diagnostics' in empty && empty.diagnostics[0]?.code).toBe('invalid_type');
  const yaml = parseImportedText('game.yaml', 'id: https://example.test/game\n');
  expect('document' in yaml && (yaml.document as { root: string }).root).toBe('game.yaml');
  const release = parseImportedText(
    'release.json',
    JSON.stringify({
      format: 'https://rezics.com/definitions/release/1',
      types: {},
      properties: {},
    }),
  );
  expect('document' in release).toBe(true);
  expect(repairableDiagnostics([{ pointer: '/release/types/ex:BoardGame/labels/en', code: 'required', file: null }])[0]?.pointer).toBe(
    '/release/types/ex:BoardGame/labels/en',
  );
  expect(publicationHref('en')).toBe('/en/catalogue/definitions/publish');
  expect(publicationHref('ja', 'context', '019a1b2c-3d4e-7f00-8a00-def000000001')).toContain('context=');
  expect(
    workspacePhase({
      operations: { grant: 'definition_publication', admitted: false, publish: false, activate: false, build: false },
    }),
  ).toBe('closed');
  expect(workspacePhase({ operations: grantedPublicationOperations(), preview: definitionPublicationFixture().preview })).toBe(
    'ready',
  );
});

test('workspace transport reviews, resumes uncertain delivery, reconciles a stale head and rereads the published digest', async () => {
  const uncertain = definitionPublicationFixture('uncertain');
  const preview = await uncertain.transport.preview({ format: 'https://rezics.com/definitions/release/1', types: {}, properties: {} });
  expect('kind' in preview && preview.identity?.digest.startsWith('sha256:')).toBe(true);
  const first = await uncertain.transport.submit({
    key: 'resume-1',
    operation: 'publish',
    path: '/v1/definitions/releases',
    body: { release: {} },
  });
  expect(first).toEqual({ ok: false, reason: 'uncertain' });
  const resumed = await uncertain.transport.submit({
    key: 'resume-1',
    operation: 'publish',
    path: '/v1/definitions/releases',
    body: { release: {} },
  });
  expect(resumed.ok).toBe(true);
  const stale = definitionPublicationFixture('reconciliation');
  const activation = await stale.transport.submit({
    key: 'activate-1',
    operation: 'activate',
    path: `/v1/definitions/releases/${stale.preview.identity!.digest}:activate`,
    body: { expected_head: 4 },
  });
  expect(activation).toEqual({ ok: false, reason: 'stale', expectedHead: 5 });
  const read = await stale.transport.readRelease(stale.preview.identity!.digest);
  expect(read).toEqual({ ok: true, digest: stale.preview.identity!.digest });
  const closed = await definitionPublicationFixture('closed').transport.open('platform');
  expect(closed.ok && closed.phase).toBe('closed');
});
