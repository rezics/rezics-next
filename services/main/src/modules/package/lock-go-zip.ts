import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { PackageLockInvalid } from './lock.ts';

const MAX_FILES = 2048;
const MAX_UNCOMPRESSED = 32 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function bounds(bytes: Uint8Array, at: number, size: number): void {
  if (!Number.isSafeInteger(at) || at < 0 || at + size > bytes.byteLength) {
    throw new PackageLockInvalid('Go archive has an invalid ZIP offset');
  }
}

/** Go's dirhash.HashZip/Hash1 over a bounded, single-disk module ZIP. */
export function goModuleZipH1(bytes: Uint8Array, path: string, version: string): string {
  const zip = Buffer.from(bytes);
  const start = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let at = zip.length - 22; at >= start; at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) {
      end = at;
      break;
    }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0) {
    throw new PackageLockInvalid('Go archive lacks a single-disk ZIP directory');
  }
  const count = zip.readUInt16LE(end + 10);
  const directorySize = zip.readUInt32LE(end + 12);
  const directoryOffset = zip.readUInt32LE(end + 16);
  if (count < 1 || count > MAX_FILES || directoryOffset + directorySize > end) {
    throw new PackageLockInvalid('Go archive exceeds its file budget');
  }
  const prefix = `${path}@${version}/`;
  const files: Array<{ name: string; digest: string }> = [];
  const seen = new Set<string>();
  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    bounds(zip, at, 46);
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new PackageLockInvalid('Go ZIP directory is malformed');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const uncompressed = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    bounds(zip, at, 46 + nameLength + extraLength + commentLength);
    if (flags & 1 || ![0, 8].includes(method) || compressed === 0xffffffff
      || uncompressed === 0xffffffff || localOffset === 0xffffffff) {
      throw new PackageLockInvalid('Go ZIP uses an unsupported encoding');
    }
    let name: string;
    try { name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)); }
    catch { throw new PackageLockInvalid('Go ZIP name is not UTF-8'); }
    if (!name.startsWith(prefix) || name === prefix || name.includes('\n') || name.includes('\\')
      || name.split('/').some(part => part === '..' || part === '.') || seen.has(name)) {
      throw new PackageLockInvalid('Go ZIP name is outside its module');
    }
    seen.add(name);
    total += uncompressed;
    if (total > MAX_UNCOMPRESSED) throw new PackageLockInvalid('Go ZIP expands beyond its byte budget');
    bounds(zip, localOffset, 30);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50
      || zip.readUInt16LE(localOffset + 8) !== method) {
      throw new PackageLockInvalid('Go ZIP local header differs');
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;
    bounds(zip, dataAt, compressed);
    if (!zip.subarray(localOffset + 30, localOffset + 30 + localNameLength)
      .equals(zip.subarray(at + 46, at + 46 + nameLength))) {
      throw new PackageLockInvalid('Go ZIP local name differs');
    }
    let content: Uint8Array;
    try { content = method === 0 ? zip.subarray(dataAt, dataAt + compressed)
      : inflateRawSync(zip.subarray(dataAt, dataAt + compressed),
        { maxOutputLength: uncompressed + 1 }); }
    catch { throw new PackageLockInvalid('Go ZIP compression is invalid'); }
    if (content.byteLength !== uncompressed) throw new PackageLockInvalid('Go ZIP size differs');
    files.push({ name, digest: createHash('sha256').update(content).digest('hex') });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== directoryOffset + directorySize) throw new PackageLockInvalid('Go ZIP directory size differs');
  const summary = files.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .map(file => `${file.digest}  ${file.name}\n`).join('');
  return `h1:${createHash('sha256').update(summary).digest('base64')}`;
}
