import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hash, PROFILE } from './activate.ts';
import type { StagedWorkObjectCandidates } from './object-gc.ts';

/** Same file-before-directory durability as ordinary immutable staging, with
 * asynchronous file syncs and one final directory sync for the bounded group.
 * The caller must flush before dispatching any graph reference. */
export class WorkFileStaging {
  constructor(private readonly directory: string) {}
  private async put(bytes: Uint8Array, digest: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = join(this.directory, digest);
    try {
      if (hash(await readFile(target)) !== digest) throw new Error('Immutable Work object is corrupt');
      return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const temporary = join(this.directory, `.stage-${Bun.randomUUIDv7()}`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, target);
    if (hash(await readFile(target)) !== digest) throw new Error('Immutable Work object verification failed');
  }
  async component(component: string, state: object, candidates: StagedWorkObjectCandidates, profile = PROFILE): Promise<string> {
    const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
    const payloadDigest = hash(payload);
    const manifest = Buffer.from(JSON.stringify({ format: 'rezics-manifest-v1', component,
      payload: `sha256:${payloadDigest}`, payloadBytes: payload.length,
      mediaType: 'application/json', model: profile, shape: profile }));
    const manifestDigest = hash(manifest);
    // Record the complete reference candidate before I/O: another same-key
    // attempt may already have committed these deterministic objects.
    candidates.objectDigests.add(payloadDigest); candidates.objectDigests.add(manifestDigest);
    candidates.manifestDigests.add(manifestDigest);
    const results = await Promise.allSettled([this.put(payload, payloadDigest), this.put(manifest, manifestDigest)]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Immutable Work staging failed');
    return manifestDigest;
  }
  async flush(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
