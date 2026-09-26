import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { solveCargoRegistry } from '../../services/main/src/modules/package/cargo-solver.ts';
import { CARGO_LIVE_HOST, CARGO_LIVE_REGISTRY, CARGO_LIVE_SCENARIOS, cargoIndexPath }
  from '../qa/fixtures/cargo-live-scenarios.ts';

// One live crates.io observation. The solver itself decides which sparse-index
// files to fetch, so the capture is exactly the lazily loaded universe. Every
// selected crate archive is fetched once, checked against the index checksum,
// and only its `[lib] proc-macro` fact is retained. Index bytes are stored
// gzip-compressed; `capture.json` keeps the raw SHA-256 of each file. `CARGO_LIVE_RECORD=1`
// replaces the QA fixture; otherwise the capture goes to `.artifacts/`.

const INDEX_ORIGIN = 'https://index.crates.io/';
const CRATE_ORIGIN = 'https://static.crates.io/crates/';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_CRATE_BYTES = 8 * 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function bounded(url: string, limit: number): Promise<Uint8Array | null> {
  const response = await fetch(url, { redirect: 'error',
    headers: { 'user-agent': 'rezics-package-capture' } });
  if (response.status === 404 || response.status === 410 || response.status === 451) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url}: ${bytes.length} bytes exceeds ${limit}`);
  return bytes;
}

function crateManifest(archive: Uint8Array, prefix: string): string {
  const tar = Bun.gunzipSync(archive);
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (from: number, to: number) => Buffer.from(header.subarray(from, to))
      .toString('utf8').replace(/\0.*$/s, '');
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(text(124, 136).trim() || '0', 8);
    if (name === `${prefix}/Cargo.toml`) {
      return Buffer.from(tar.subarray(at + 512, at + 512 + size)).toString('utf8');
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${prefix}: Cargo.toml missing from crate archive`);
}

test('PKG01/PKG02/PKG13/PKG19: live crates.io sparse index capture is lazily loaded and replayable', async () => {
  const files = new Map<string, Uint8Array | null>();
  const loadIndex = async (name: string) => {
    if (!files.has(name)) files.set(name, await bounded(`${INDEX_ORIGIN}${cargoIndexPath(name)}`,
      MAX_INDEX_BYTES));
    return files.get(name)!;
  };
  const selected = new Map<string, string>();
  const outcomes: Record<string, unknown> = {};
  for (const scenario of CARGO_LIVE_SCENARIOS) {
    for (const variant of scenario.variants) {
      const outcome = await solveCargoRegistry({ registryIndexUrl: CARGO_LIVE_REGISTRY,
        manifest: scenario.manifest, host: CARGO_LIVE_HOST, target: variant.target,
        features: variant.features, defaultFeatures: variant.defaultFeatures,
        includeDev: variant.includeDev, procMacros: [], loadIndex });
      expect(outcome.missing).toEqual([]);
      expect(outcome.unsupportedClauses).toEqual([]);
      expect(outcome.status).toBe(scenario.expected);
      for (const item of outcome.selected) selected.set(`${item.name}@${item.version}`, item.checksum);
      outcomes[`${scenario.id}/${variant.label}`] = { status: outcome.status,
        selected: outcome.selected.length, cost: outcome.cost };
    }
  }
  const procMacros: Array<{ name: string; version: string; crateSha256: string }> = [];
  for (const [identity, checksum] of [...selected].sort()) {
    const [name, version] = identity.split('@') as [string, string];
    const archive = await bounded(`${CRATE_ORIGIN}${name}/${name}-${version}.crate`, MAX_CRATE_BYTES);
    if (!archive) throw new Error(`${identity}: crate archive unavailable`);
    expect(sha(archive)).toBe(checksum);
    const manifest = Bun.TOML.parse(crateManifest(archive, `${name}-${version}`)) as {
      lib?: Record<string, unknown> };
    if (manifest.lib?.['proc-macro'] === true || manifest.lib?.proc_macro === true) {
      procMacros.push({ name, version, crateSha256: checksum });
    }
  }
  const record = Bun.env.CARGO_LIVE_RECORD === '1';
  const output = record ? resolve(import.meta.dir, '../qa/fixtures/cargo-live-index')
    : resolve(import.meta.dir, '../../.artifacts/cargo-live', new Date().toISOString()
      .replaceAll(':', '-'));
  if (record) rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'index'), { recursive: true });
  const inventory = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => {
    if (bytes) writeFileSync(join(output, 'index', `${name}.gz`), Bun.gzipSync(bytes, { level: 9 }));
    return { name, present: bytes !== null, bytes: bytes?.length ?? 0,
      sha256: bytes ? sha(bytes) : null };
  });
  writeFileSync(join(output, 'capture.json'), `${JSON.stringify({
    profile: 'cargo-sparse-index-capture-v1', registry: CARGO_LIVE_REGISTRY,
    indexOrigin: INDEX_ORIGIN, crateOrigin: CRATE_ORIGIN, capturedAt: new Date().toISOString(),
    files: inventory, procMacros, checkedCrates: selected.size }, null, 2)}\n`);
  console.info(`crates.io capture: ${inventory.length} index files, ${selected.size} crates checked, `
    + `${procMacros.length} proc-macros; ${output}\n${JSON.stringify(outcomes)}`);
}, 600_000);
