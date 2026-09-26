import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GoLiveOutcome, GoProxyLoader }
  from '../../../services/main/src/modules/package/go-live-mvs.ts';

// Replays the retained live proxy.golang.org capture. Each present body is checked
// against its recorded raw SHA-256; a path recorded as absent stays absent (404).

export interface GoLiveCaptureEntry { path: string; present: boolean; bytes: number;
  sha256: string | null }
export interface GoLiveCapture { profile: 'go-proxy-capture-set-v1'; origin: string;
  capturedAt: string; entries: GoLiveCaptureEntry[] }

const root = resolve(import.meta.dir, '../../..');
const directory = resolve(root, 'tests/qa/fixtures/go-live-proxy/');

export function goLiveCapture(): GoLiveCapture {
  return JSON.parse(readFileSync(resolve(directory, 'capture.json'), 'utf8')) as GoLiveCapture;
}

export function goLiveFiles(): Map<string, Uint8Array | null> {
  const bodies = JSON.parse(Buffer.from(Bun.gunzipSync(readFileSync(resolve(directory,
    'bodies.json.gz')))).toString('utf8')) as Record<string, string>;
  const files = new Map<string, Uint8Array | null>();
  for (const entry of goLiveCapture().entries) {
    if (!entry.present) { files.set(entry.path, null); continue; }
    const bytes = Buffer.from(bodies[entry.path] ?? '', 'base64');
    if (bytes.length !== entry.bytes
      || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw new Error(`captured Go proxy path ${entry.path} differs from its recorded digest`);
    }
    files.set(entry.path, new Uint8Array(bytes));
  }
  return files;
}

/** A loader over the capture; a path never observed is a test error, not a 404. */
export function goLiveLoader(files = goLiveFiles(), requested?: string[]): GoProxyLoader {
  return async path => {
    requested?.push(path);
    if (!files.has(path)) throw new Error(`Go proxy path ${path} was not captured`);
    return files.get(path) ?? null;
  };
}

export interface GoNativeScenario { list: string[]; modules: Array<{ path: string; version: string;
  retracted: string[] | null; update: string | null }>; goModChanged: boolean }

export function goNativeRecord(): Record<string, GoNativeScenario> {
  return (JSON.parse(readFileSync(resolve(import.meta.dir, 'go-live-native.json'), 'utf8')) as {
    scenarios: Record<string, GoNativeScenario> }).scenarios;
}

/** The native-comparable projection of a REZICS outcome. */
export function goNativeView(outcome: GoLiveOutcome): Omit<GoNativeScenario, 'goModChanged'> {
  return { list: outcome.buildList.map(item => `${item.path} ${item.version}`),
    modules: outcome.buildList.map(item => ({ path: item.path, version: item.version,
      retracted: item.retracted, update: item.update })) };
}
