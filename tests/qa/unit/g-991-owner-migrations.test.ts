import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { assertOwnerMigrationsComplete, type OwnerMigrationEvidence } from '../../../scripts/fixture/migrate.ts';
import { readFormatMarker, saveFormatMarker, type FormatMarker } from '../../../scripts/dev/install.ts';
import { stackDirectory, type StackOptions } from '../../../scripts/dev/config.ts';

test('G991: a deferred owner migration fails development and survives release restart until a successful retry', () => {
  const deferred: OwnerMigrationEvidence[] = [{ owner: 'graph-names', status: 'deferred',
    reason: 'Graph-name import is incomplete; resolve the reported import error and rerun owner migrations' }];
  expect(() => assertOwnerMigrationsComplete(deferred)).toThrow('Owner migrations deferred: graph-names');
  const options: StackOptions = { profile: 'qa', runId: `g991-${randomUUID().slice(0, 8)}` };
  const directory = stackDirectory(process.cwd(), options);
  mkdirSync(directory, { recursive: true });
  const marker: FormatMarker = { schema: 'rezics-format-marker-v1', formatVersion: 1,
    releaseDigest: 'release', fusekiImageId: 'image', dataEpoch: 'epoch', routingEpoch: 'routing',
    state: 'ready', ownerMigrations: deferred };
  try {
    saveFormatMarker(options, marker);
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(deferred);
    const complete: OwnerMigrationEvidence[] = [{ owner: 'graph-names', status: 'complete' }];
    assertOwnerMigrationsComplete(complete);
    saveFormatMarker(options, { ...marker, ownerMigrations: complete });
    expect(readFormatMarker(options)?.ownerMigrations).toEqual(complete);
    expect(readFormatMarker(options)?.state).toBe('ready');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
