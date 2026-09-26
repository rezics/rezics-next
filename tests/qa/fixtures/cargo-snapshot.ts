import { createHash } from 'node:crypto';
import type { CargoRequest } from '../../../services/main/src/modules/package/cargo-resolution.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function cargoFixture(): CargoRequest {
  const manifest = `[package]
name = "cargo-root"
version = "0.1.0"
edition = "2021"
resolver = "2"

[dependencies]
shared = { version = "=1.0.0", registry = "snapshot", default-features = false, features = ["runtime"] }
bridge = { version = "=1.0.0", registry = "snapshot" }
optionaldep = { version = "=1.0.0", registry = "snapshot", optional = true }

[build-dependencies]
shared = { version = "=1.0.0", registry = "snapshot", default-features = false, features = ["build_extra"] }

[target.'cfg(target_os = "windows")'.dependencies]
windowsonly = { version = "=1.0.0", registry = "snapshot" }

[features]
default = ["dep:optionaldep"]
`;
  const items = [
    { name: 'shared', features: { runtime: [], build_extra: [], indirect: [] }, deps: [] },
    { name: 'bridge', features: {}, deps: [{ name: 'shared', req: '=1.0.0',
      features: ['indirect'], optional: false, default_features: false,
      target: null, kind: 'normal', registry: null, package: null }] },
    { name: 'optionaldep', features: {}, deps: [] },
    { name: 'windowsonly', features: {}, deps: [] },
  ];
  return { profile: 'cargo-index-exact-resolver2-v1',
    registryIndexUrl: 'https://snapshot.example.invalid/index/',
    manifestBase64: Buffer.from(manifest).toString('base64'),
    manifestSha256: sha(manifest),
    indexFiles: items.map(item => {
      const line = `${JSON.stringify({ name: item.name, vers: '1.0.0', deps: item.deps,
        cksum: 'a'.repeat(64), features: item.features, yanked: false, v: 1 })}\n`;
      return { name: item.name, bytesBase64: Buffer.from(line).toString('base64'),
        sha256: sha(line) };
    }),
    host: 'x86_64-unknown-linux-gnu', target: 'x86_64-unknown-linux-gnu',
    features: [], defaultFeatures: true };
}
export function withIndexLine(input: CargoRequest, name: string,
  change: (entry: Record<string, unknown>) => Record<string, unknown>): CargoRequest {
  return { ...input, indexFiles: input.indexFiles.map(file => {
    if (file.name !== name) return file;
    const entry = JSON.parse(Buffer.from(file.bytesBase64, 'base64').toString('utf8'));
    const line = `${JSON.stringify(change(entry))}\n`;
    return { ...file, bytesBase64: Buffer.from(line).toString('base64'), sha256: sha(line) };
  }) };
}
