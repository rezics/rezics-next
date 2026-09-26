import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CargoSolveOutcome } from '../../../services/main/src/modules/package/cargo-solver.ts';

// Replays the retained live crates.io capture. Every file is checked against the
// raw SHA-256 recorded at capture time; a file recorded as absent stays absent.

export interface CargoLiveCapture { profile: 'cargo-sparse-index-capture-v1'; registry: string;
  capturedAt: string; files: Array<{ name: string; present: boolean; bytes: number;
    sha256: string | null }>;
  procMacros: Array<{ name: string; version: string; crateSha256: string }> }

const directory = resolve(import.meta.dir, 'cargo-live-index');

export function cargoLiveCapture(): CargoLiveCapture {
  return JSON.parse(readFileSync(resolve(directory, 'capture.json'), 'utf8')) as CargoLiveCapture;
}

export function cargoLiveIndex(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const file of cargoLiveCapture().files) {
    if (!file.present) continue;
    const path = resolve(directory, 'index', `${file.name}.gz`);
    if (!existsSync(path)) throw new Error(`captured index file ${file.name} is missing`);
    const bytes = Bun.gunzipSync(readFileSync(path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256 || bytes.length !== file.bytes) {
      throw new Error(`captured index file ${file.name} differs from its recorded digest`);
    }
    files.set(file.name, bytes);
  }
  return files;
}

export function cargoLiveProcMacros(): string[] {
  return cargoLiveCapture().procMacros.map(item => `${item.name}@${item.version}`);
}

export interface CargoNativeVariant { status: 'solved' | 'failed'; selected: string[];
  lockEdges: string[]; instances: string[]; error: string | null }

export function cargoNativeRecord(): Record<string, CargoNativeVariant> {
  return (JSON.parse(readFileSync(resolve(import.meta.dir, 'cargo-live-native.json'), 'utf8')) as {
    variants: Record<string, CargoNativeVariant> }).variants;
}

/** The native-comparable projection: lock identities, lock edges and feature instances. */
export function cargoNativeView(outcome: CargoSolveOutcome): Omit<CargoNativeVariant, 'error'> {
  const byId = new Map(outcome.selected.map(item => [item.id, `${item.name}@${item.version}`]));
  const rootName = outcome.root.replace(/^root#/, '').replace(/@[^@]*$/, '');
  const ident = (id: string) => byId.get(id) ?? rootName;
  return { status: outcome.status === 'solved' ? 'solved' : 'failed',
    selected: outcome.selected.map(item => `${item.name}@${item.version}`).sort(),
    lockEdges: [...new Set(outcome.lockEdges.map(edge => `${ident(edge.from)}->${ident(edge.to)}`))].sort(),
    instances: outcome.instances.filter(item => item.package !== outcome.root)
      .map(item => `${item.name}@${item.version}#${item.role}|${item.features.join(',')}`).sort() };
}
