import { createHash } from 'node:crypto';
import type { CargoRequest } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoIndexFile, type CargoIndexEntry } from './cargo-links-snapshot.ts';

export type CargoLockRequest = Extract<CargoRequest, { profile: 'cargo-index-exact-resolver2-v3' }>;
export const cargoLockCases = ['fresh-yanked', 'locked-yanked', 'changed-root',
  'changed-requirement', 'changed-source', 'missing-source', 'changed-checksum',
  'missing-checksum', 'disconnected-lock', 'missing-lock-package', 'non-yanked',
  'unselected-yanked', 'changed-requirement-non-yanked', 'unselected-lock-checksum',
  'non-yanked-checksum-mismatch', 'links-conflict'] as const;
export type CargoLockCase = typeof cargoLockCases[number];
export const cargoBytes = (text: string) => ({ bytesBase64: Buffer.from(text).toString('base64'),
  sha256: createHash('sha256').update(text).digest('hex') });
export function withCargoLock(input: CargoLockRequest, text: string | null): CargoLockRequest {
  return { ...input, existingLock: text === null ? null : cargoBytes(text) };
}
export function withCargoManifest<T extends CargoRequest>(input: T, text: string): T {
  const bytes = cargoBytes(text);
  return { ...input, manifestBase64: bytes.bytesBase64, manifestSha256: bytes.sha256 };
}
export function cargoLockFixture(kind: CargoLockCase = 'locked-yanked'): CargoLockRequest {
  const source = 'https://snapshot.example.invalid/index/';
  const checksums = ['a'.repeat(64), 'b'.repeat(64)];
  const leaf = (version: string, checksum: string): CargoIndexEntry => ({ name: 'leaf',
    vers: version, cksum: checksum, deps: [], features: {}, links: 'native_shared', yanked: true, v: 1 });
  const entries = [leaf('1.0.0', checksums[0]!), leaf('2.0.0', checksums[1]!)];
  if (['non-yanked', 'unselected-yanked', 'non-yanked-checksum-mismatch'].includes(kind)) {
    entries[0]!.yanked = false;
  }
  if (kind === 'non-yanked' || kind === 'changed-requirement-non-yanked') entries[1]!.yanked = false;
  let manifest = `[package]\nname = "lock-root"\nversion = "0.1.0"\nedition = "2021"\nresolver = "2"\n`
    + `\n[dependencies]\nleaf = { version = "=1.0.0", registry = "snapshot" }\n`;
  if (kind === 'changed-root') manifest = manifest.replace('lock-root', 'renamed-root')
    .replace('version = "0.1.0"', 'version = "0.2.0"');
  if (kind.startsWith('changed-requirement')) manifest = manifest.replace('=1.0.0', '=2.0.0');
  const pkg = (version: string, checksum: string) => `[[package]]\nname = "leaf"\nversion = "${version}"\n`
    + `source = "sparse+${source}"\nchecksum = "${checksum}"\n\n`;
  let lock = `version = 4\n\n${pkg('1.0.0', checksums[0]!)}[[package]]\nname = "lock-root"\n`
    + `version = "0.1.0"\ndependencies = ["leaf"]\n`;
  if (kind === 'changed-source') lock = lock.replace(source, 'https://other.example.invalid/index/');
  if (kind === 'missing-source') lock = lock.replace(`source = "sparse+${source}"\n`, '');
  if (['changed-checksum', 'non-yanked-checksum-mismatch'].includes(kind)) {
    lock = lock.replace(checksums[0]!, '0'.repeat(64));
  }
  if (kind === 'missing-checksum') lock = lock.replace(`checksum = "${checksums[0]}"\n`, '');
  if (kind === 'disconnected-lock') lock = lock.replace('dependencies = ["leaf"]\n', '');
  if (kind === 'missing-lock-package') lock = lock.replace(pkg('1.0.0', checksums[0]!), '');
  if (kind === 'unselected-lock-checksum') lock += `\n${pkg('2.0.0', '0'.repeat(64))}`;
  const indexFiles = [cargoIndexFile('leaf', entries)];
  if (kind === 'links-conflict') {
    manifest += 'other = { version = "=1.0.0", registry = "snapshot" }\n';
    indexFiles.push(cargoIndexFile('other', [{ ...entries[0]!, name: 'other', yanked: false }]));
  }
  const bytes = cargoBytes(manifest);
  return { profile: 'cargo-index-exact-resolver2-v3', registryIndexUrl: source,
    manifestBase64: bytes.bytesBase64, manifestSha256: bytes.sha256, indexFiles,
    existingLock: ['fresh-yanked', 'non-yanked', 'unselected-yanked'].includes(kind) ? null : cargoBytes(lock),
    host: 'x86_64-unknown-linux-gnu', target: 'x86_64-unknown-linux-gnu',
    features: [], defaultFeatures: true };
}
