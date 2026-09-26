import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';

const DIGEST = /^[0-9a-f]{64}$/;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Structure pages and manifests in their own retention namespace under the
 * configured object directory (the filesystem baseline; the S3 namespace is
 * Work-only until `semantic/structure/` is provisioned). A file is named by the
 * SHA-256 of its exact bytes and is written once, fsynced, then verified.
 */
export class DirectoryStructureObjects implements ImmutableObjects {
  readonly directory: string;

  constructor(objectDirectory: string) { this.directory = join(objectDirectory, 'structure'); }

  async put(bytes: Uint8Array): Promise<string> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const digest = sha256(bytes);
    const target = join(this.directory, digest);
    if (existsSync(target)) {
      await this.get(digest);
      return digest;
    }
    const temporary = join(this.directory, `.stage-${Bun.randomUUIDv7()}`);
    const file = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, target);
    const directory = openSync(this.directory, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    await this.get(digest);
    return digest;
  }

  async get(digest: string): Promise<Uint8Array> {
    if (!DIGEST.test(digest)) throw new ObjectIntegrityError('invalid immutable object digest');
    let bytes: Uint8Array;
    try { bytes = readFileSync(join(this.directory, digest)); }
    catch { throw new ObjectUnavailable('committed Structure object is unavailable'); }
    if (sha256(bytes) !== digest) throw new ObjectIntegrityError('Structure object digest differs');
    return bytes;
  }
}
