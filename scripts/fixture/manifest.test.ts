import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './corpus.ts';
import {
  inventoryDirectory, retainedIntegrity, verifyRetainedIntegrity,
  type RetainedIntegrity,
} from './manifest.ts';

const directories: string[] = [];
function backup(): string {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(join('.temp', 'retained-manifest-'));
  directories.push(directory);
  mkdirSync(join(directory, 'graph'));
  mkdirSync(join(directory, 'objects'));
  mkdirSync(join(directory, 'postgres'));
  writeFileSync(join(directory, 'graph', 'data.trig'), '<s> <p> <o> .');
  writeFileSync(join(directory, 'objects', 'body.txt'), 'exact content beacon');
  writeFileSync(join(directory, 'postgres', 'owner.dump'), Buffer.from([0, 128, 255]));
  return directory;
}
function seal(directory: string): RetainedIntegrity {
  return retainedIntegrity(directory, sha256('<s> <p> <o> .'), {
    cut: '37', lineage: { dataEpoch: 'source-epoch', routingEpoch: 'routing-epoch' },
    relay: { consumer: 'content-projection', through: '42' },
    owners: ['content', 'access', 'main-relay'],
  });
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('retained backup integrity', () => {
  test('inventories every physical backup and binds RDF and owner metadata deterministically', () => {
    const directory = backup();
    const integrity = seal(directory);
    expect(integrity.files).toEqual({
      'graph/data.trig': { sha256: sha256('<s> <p> <o> .'), bytes: 13 },
      'objects/body.txt': { sha256: sha256('exact content beacon'), bytes: 20 },
      'postgres/owner.dump': { sha256: sha256(Buffer.from([0, 128, 255])), bytes: 3 },
    });
    expect(verifyRetainedIntegrity(directory, integrity)).toEqual([]);
    expect(seal(directory)).toEqual(integrity);
    expect(retainedIntegrity(directory, sha256('different RDF'), integrity.ownerState).digest)
      .not.toBe(integrity.digest);
    expect(retainedIntegrity(directory, integrity.rdfDigest, { ...integrity.ownerState, cut: '38' }).digest)
      .not.toBe(integrity.digest);
    expect(retainedIntegrity(directory, integrity.rdfDigest,
      Object.fromEntries(Object.entries(integrity.ownerState).reverse())).digest).toBe(integrity.digest);
  });

  test('refuses changed, missing and extra files without altering the backup or manifest', () => {
    const directory = backup();
    const integrity = seal(directory);
    const manifestBefore = JSON.stringify(integrity);
    writeFileSync(join(directory, 'objects', 'body.txt'), 'exact content tamper');
    rmSync(join(directory, 'postgres', 'owner.dump'));
    writeFileSync(join(directory, 'graph', 'unexpected'), 'new');
    expect(verifyRetainedIntegrity(directory, integrity)).toEqual([
      'retained backup file changed: objects/body.txt',
      'retained backup file missing: postgres/owner.dump',
      'retained backup file unexpected: graph/unexpected',
    ]);
    expect(JSON.stringify(integrity)).toBe(manifestBefore);
    expect(readFileSync(join(directory, 'objects', 'body.txt'), 'utf8')).toBe('exact content tamper');
  });

  test('refuses RDF, owner-state and file-inventory metadata tampering', () => {
    const directory = backup();
    const integrity = seal(directory);
    for (const changed of [
      { ...integrity, rdfDigest: sha256('tampered') },
      { ...integrity, ownerState: { ...integrity.ownerState, cut: '999' } },
      { ...integrity, files: { ...integrity.files,
        'graph/data.trig': { sha256: sha256('tampered'), bytes: 13 } } },
    ]) {
      expect(verifyRetainedIntegrity(directory, changed)).toContain('retained integrity metadata digest differs');
    }
  });

  test('refuses symlinks and unsafe manifest paths without reading outside custody', () => {
    const directory = backup();
    const integrity = seal(directory);
    symlinkSync('../objects/body.txt', join(directory, 'graph', 'alias'));
    expect(() => inventoryDirectory(directory)).toThrow('retained backup contains symlink: graph/alias');
    expect(verifyRetainedIntegrity(directory, integrity)).toContain(
      'retained backup inventory refused: retained backup contains symlink: graph/alias');
    rmSync(join(directory, 'graph', 'alias'));
    for (const path of ['../secret', '/absolute', 'graph/../secret', 'graph\\secret', 'graph//secret']) {
      expect(verifyRetainedIntegrity(directory, {
        ...integrity, files: { ...integrity.files, [path]: integrity.files['graph/data.trig']! },
      })).toContain(`unsafe retained manifest path: ${path}`);
    }
    const symlinkRoot = `${directory}-alias`;
    symlinkSync(directory.split('/').at(-1)!, symlinkRoot);
    directories.push(symlinkRoot);
    expect(() => inventoryDirectory(symlinkRoot)).toThrow('retained backup contains symlink: .');
  });

  test('refuses absent backups, invalid digest fields and non-JSON descriptors', () => {
    const directory = backup();
    const integrity = seal(directory);
    rmSync(directory, { recursive: true });
    expect(verifyRetainedIntegrity(directory, integrity).some((reason) => reason.includes('ENOENT'))).toBe(true);
    expect(verifyRetainedIntegrity(directory, { ...integrity, rdfDigest: 'unsealed' }))
      .toEqual(['retained integrity metadata is invalid']);
    expect(() => retainedIntegrity(directory, 'unsealed', {})).toThrow('retained RDF digest must be SHA-256');
    expect(() => retainedIntegrity(directory, integrity.rdfDigest, { cut: Number.NaN }))
      .toThrow('retained owner state must be a JSON object');
  });

  test('captures the descriptor independently of later producer mutation', () => {
    const directory = backup();
    const ownerState = { relay: { through: '42' } };
    const integrity = retainedIntegrity(directory, sha256('rdf'), ownerState);
    ownerState.relay.through = '99';
    expect(integrity.ownerState).toEqual({ relay: { through: '42' } });
    expect(verifyRetainedIntegrity(directory, integrity)).toEqual([]);
  });
});
