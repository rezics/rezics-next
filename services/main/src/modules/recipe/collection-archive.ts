import { inflateRawSync, crc32 } from 'node:zlib';
import { RecipeFileInvalid } from './file-intake.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
function invalid(): never { throw new RecipeFileInvalid('Recipe ZIP is malformed or uses an unsupported encoding'); }
interface ArchiveEntry { name: string; size: number; originalSize: number }

/** Same single-disk ZIP admission as package/lock-go-zip, with bounded native inflation.
 * The declared size is a ceiling, never an instruction to allocate unchecked output. */
export function readCollectionArchive(bytes: Uint8Array, admit: (entry: ArchiveEntry) => boolean): Record<string, Uint8Array> {
  const zip = Buffer.from(bytes);
  const bounds = (at: number, size: number) => {
    if (!Number.isSafeInteger(at) || at < 0 || size < 0 || at + size > zip.length) invalid();
  };
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) { end = at; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) invalid();
  const count = zip.readUInt16LE(end + 10), offset = zip.readUInt32LE(end + 16), size = zip.readUInt32LE(end + 12);
  if (count !== zip.readUInt16LE(end + 8) || offset + size !== end) invalid();
  let at = offset;
  const files: Record<string, Uint8Array> = Object.create(null);
  for (let index = 0; index < count; index++) {
    bounds(at, 46);
    if (zip.readUInt32LE(at) !== 0x02014b50) invalid();
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), checksum = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20), expanded = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    bounds(at, 46 + nameLength + extra + comment);
    if (flags & 1 || ![0, 8].includes(method) || [compressed, expanded, local].includes(0xffffffff)
      || zip.readUInt16LE(at + 34)) invalid();
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    bounds(local, 30);
    if (zip.readUInt32LE(local) !== 0x04034b50 || zip.readUInt16LE(local + 8) !== method
      || zip.readUInt16LE(local + 6) !== flags) invalid();
    const localName = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
    bounds(local + 30, localName + localExtra);
    if (!zip.subarray(local + 30, local + 30 + localName).equals(zip.subarray(at + 46, at + 46 + nameLength))) invalid();
    const start = local + 30 + localName + localExtra;
    bounds(start, compressed);
    if (start + compressed > offset) invalid();
    if (admit({ name, size: compressed, originalSize: expanded })) {
      const payload = zip.subarray(start, start + compressed);
      const content = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: expanded + 1 });
      if (content.length !== expanded || crc32(content) !== checksum) invalid();
      files[name] = content;
    }
    at += 46 + nameLength + extra + comment;
  }
  if (at !== offset + size) invalid();
  return files;
}
