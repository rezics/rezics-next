import { createHash } from 'node:crypto';
import type { CargoRequest } from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { cargoFixture } from './cargo-snapshot.ts';

export type CargoLinksCase = 'conflict' | 'distinct-links' | 'single-owner'
  | 'single-owner-no-default' | 'single-owner-windows'
  | 'different-names' | 'inactive-target' | 'inactive-root-optional'
  | 'inactive-transitive-optional' | 'active-transitive-optional';
export const cargoLinksCases: CargoLinksCase[] = ['conflict', 'distinct-links',
  'single-owner', 'single-owner-no-default', 'single-owner-windows',
  'different-names', 'inactive-target', 'inactive-root-optional',
  'inactive-transitive-optional', 'active-transitive-optional'];

export interface CargoIndexEntry {
  name: string; vers: string; deps: Array<{ name: string; req: string;
    features: string[]; optional: boolean; default_features: boolean;
    target: string | null; kind: 'normal' | 'build'; registry: null; package: null }>;
  cksum: string; features: Record<string, string[]>; yanked: boolean; v: number;
  links?: string | null;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function cargoIndexFile(name: string, entries: CargoIndexEntry[]) {
  const bytes = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  return { name, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
}
export function cargoIndexEntries(input: CargoRequest): CargoIndexEntry[] {
  return input.indexFiles.flatMap(file => Buffer.from(file.bytesBase64, 'base64')
    .toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as CargoIndexEntry));
}
export function cargoLinksFixture(kind: CargoLinksCase = 'conflict'): CargoRequest {
  const base = cargoFixture();
  const entries = cargoIndexEntries(base);
  const shared = entries.find(entry => entry.name === 'shared')!;
  const bridge = entries.find(entry => entry.name === 'bridge')!;
  shared.links = 'native_shared';
  const second = { ...shared, vers: '2.0.0',
    links: kind === 'distinct-links' ? 'native_other' : 'native_shared' };
  const secondSelected = ['conflict', 'distinct-links', 'inactive-transitive-optional',
    'active-transitive-optional'].includes(kind);
  bridge.deps[0]!.req = secondSelected ? '=2.0.0' : '=1.0.0';
  if (kind === 'different-names') bridge.links = 'native_shared';
  if (kind === 'inactive-target') entries.find(entry => entry.name === 'windowsonly')!.links
    = 'native_shared';
  if (kind === 'inactive-root-optional') entries.find(entry => entry.name === 'optionaldep')!.links
    = 'native_shared';
  if (kind.endsWith('transitive-optional')) {
    bridge.deps[0]!.optional = true;
    bridge.features = { native: ['dep:shared'] };
  }
  let manifest = Buffer.from(base.manifestBase64, 'base64').toString('utf8');
  if (kind === 'active-transitive-optional') manifest = manifest.replace(
    'bridge = { version = "=1.0.0", registry = "snapshot" }',
    'bridge = { version = "=1.0.0", registry = "snapshot", features = ["native"] }');
  return { ...base, profile: 'cargo-index-exact-resolver2-v2',
    manifestBase64: Buffer.from(manifest).toString('base64'),
    manifestSha256: sha(manifest),
    defaultFeatures: !['inactive-root-optional', 'single-owner-no-default'].includes(kind),
    target: kind === 'single-owner-windows' ? 'x86_64-pc-windows-msvc' : base.target,
    indexFiles: base.indexFiles.map(file => cargoIndexFile(file.name,
      file.name === 'shared' ? [shared, second, { ...shared, vers: '3.0.0' }]
        : entries.filter(entry => entry.name === file.name))) };
}
