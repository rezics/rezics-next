import { inflateSync } from 'node:zlib';
import { type MetadataReader, metadataByteLimit, withMetadataReader } from './visual-novel-metadata.ts';

const magic = Buffer.from('5850330d0a200a1a8b6701', 'hex');
const headerSize = magic.length + 8;
const embeddedSearchLimit = 256 * 1024;
const indexByteLimit = 4 * 1024 * 1024;
const storedScriptLimit = 2 * metadataByteLimit;
const encodingMask = 0x07;
const startupName = 'startup.tjs';
const initializeName = 'system/initialize.tjs';
const configName = 'system/config.tjs';
const scriptNames = new Set([startupName, initializeName, configName]);

class InvalidXp3 extends Error {}

type Archive = { file: MetadataReader; start: number; index: number };
type Entry = { info: Buffer; segments: Buffer };

function archiveAt(file: MetadataReader, bytes: Buffer, start: number): Archive | undefined {
  if (bytes.length < headerSize || !bytes.subarray(0, magic.length).equals(magic)) return;
  const index = bytes.readBigUInt64LE(magic.length);
  if (index >= BigInt(headerSize) && index < BigInt(file.size - start)) return { file, start, index: Number(index) };
}

async function locateArchive(file: MetadataReader, requireExecutable: boolean) {
  const header = await file.read(0, 64);
  const isExecutable = header.length === 64 && header.readUInt16LE(0) === 0x5a4d;
  if (!isExecutable) return requireExecutable ? undefined : archiveAt(file, header, 0);

  const peOffset = header.readUInt32LE(60);
  if (peOffset < header.length) return;
  const pe = await file.read(peOffset, 24);
  if (pe.length !== 24 || pe.readUInt32LE(0) !== 0x4550) return;
  const sections = pe.readUInt16LE(6);
  if (sections < 1 || sections > 96) return;
  const tableOffset = peOffset + pe.length + pe.readUInt16LE(20);
  const table = await file.read(tableOffset, sections * 40);
  if (table.length !== sections * 40) return;

  // KiriKiri aligns an executable's embedded XP3 header to a 16-byte file offset.
  let end = tableOffset + table.length;
  for (let offset = 0; offset < table.length; offset += 40) {
    const rawSize = table.readUInt32LE(offset + 16);
    const rawStart = table.readUInt32LE(offset + 20);
    if (rawSize) end = Math.max(end, rawStart + rawSize);
  }
  const alignedEnd = Math.ceil(end / 16) * 16;
  const tail = await file.read(alignedEnd, embeddedSearchLimit + headerSize - 1);
  for (let offset = 0; offset < embeddedSearchLimit && offset + headerSize <= tail.length; offset += 16) {
    if (tail[offset] !== magic[0]) continue;
    const archive = archiveAt(file, tail.subarray(offset, offset + headerSize), alignedEnd + offset);
    if (archive) return archive;
  }
}

function bounded(value: bigint, limit: number) {
  if (value > BigInt(limit)) throw new InvalidXp3();
  return Number(value);
}

async function readExact({ file, start }: Archive, offset: number, length: number) {
  if (offset < headerSize || offset > file.size - start - length) throw new InvalidXp3();
  const bytes = await file.read(start + offset, length);
  if (bytes.length !== length) throw new InvalidXp3();
  return bytes;
}

function unpack(bytes: Buffer, compressed: boolean, size: number) {
  let decoded: Buffer;
  try {
    decoded = compressed ? inflateSync(bytes, { maxOutputLength: Math.max(size, 1) }) : bytes;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      (error.code.startsWith('Z_') || error.code === 'ERR_BUFFER_TOO_LARGE')
    )
      throw new InvalidXp3();
    throw error;
  }
  if (decoded.length !== size) throw new InvalidXp3();
  return decoded;
}

function* chunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length;) {
    const start = offset + 12;
    if (start > bytes.length) throw new InvalidXp3();
    const length = bounded(bytes.readBigUInt64LE(offset + 4), bytes.length - start);
    yield { name: bytes.toString('latin1', offset, offset + 4), content: bytes.subarray(start, start + length) };
    offset = start + length;
  }
}

function collectEntries(index: Buffer, entries: Map<string, Entry>) {
  for (const chunk of chunks(index)) {
    if (chunk.name !== 'File') continue;
    const fields = new Map<string, Buffer>();
    for (const field of chunks(chunk.content)) {
      if (field.name !== 'info' && field.name !== 'segm' && field.name !== 'adlr') continue;
      if (fields.has(field.name)) throw new InvalidXp3();
      fields.set(field.name, field.content);
    }
    const info = fields.get('info');
    if (!info || info.length < 22) throw new InvalidXp3();
    const nameEnd = 22 + 2 * info.readUInt16LE(20);
    if (nameEnd > info.length) throw new InvalidXp3();
    const name = info
      .toString('utf16le', 22, nameEnd)
      .toLowerCase()
      .replace(/[/\\]+/gu, '/')
      .replace(/^\//u, '');
    if (!scriptNames.has(name)) continue;
    const segments = fields.get('segm');
    if (!segments || fields.get('adlr')?.length !== 4 || entries.has(name)) throw new InvalidXp3();
    entries.set(name, { info, segments });
  }
}

async function readIndex(archive: Archive) {
  const entries = new Map<string, Entry>();
  const seen = new Set<number>();
  let offset = archive.index;
  let storedBudget = indexByteLimit;
  let decodedBudget = indexByteLimit;
  for (let blocks = 0; blocks < 8; blocks += 1) {
    if (seen.has(offset)) throw new InvalidXp3();
    seen.add(offset);
    const header = await readExact(archive, offset, 9);
    const flag = header[0]!;
    const method = flag & encodingMask;
    if (method > 1) throw new InvalidXp3();
    const stored = bounded(header.readBigUInt64LE(1), storedBudget);
    offset += header.length;
    const size =
      method === 1 ? bounded((await readExact(archive, offset, 8)).readBigUInt64LE(), decodedBudget) : stored;
    if (size > decodedBudget) throw new InvalidXp3();
    if (method === 1) offset += 8;
    collectEntries(unpack(await readExact(archive, offset, stored), method === 1, size), entries);
    storedBudget -= stored;
    decodedBudget -= size;
    if (!(flag & 0x80)) return entries;
    offset = bounded(
      (await readExact(archive, offset + stored, 8)).readBigUInt64LE(),
      archive.file.size - archive.start,
    );
  }
  throw new InvalidXp3();
}

async function readScript(archive: Archive, { info, segments }: Entry) {
  if (info.readUInt32LE(0) & 0x80000000) throw new InvalidXp3();
  const size = bounded(info.readBigUInt64LE(4), metadataByteLimit);
  const storedSize = bounded(info.readBigUInt64LE(12), storedScriptLimit);
  if (!segments.length || segments.length % 28 || segments.length > 64 * 28) throw new InvalidXp3();
  const parts: Buffer[] = [];
  let decoded = 0;
  let stored = 0;
  for (let offset = 0; offset < segments.length; offset += 28) {
    const method = segments.readUInt32LE(offset) & encodingMask;
    if (method > 1) throw new InvalidXp3();
    const position = bounded(segments.readBigUInt64LE(offset + 4), archive.file.size - archive.start);
    const length = bounded(segments.readBigUInt64LE(offset + 12), size - decoded);
    const packed = bounded(segments.readBigUInt64LE(offset + 20), storedSize - stored);
    parts.push(unpack(await readExact(archive, position, packed), method === 1, length));
    decoded += length;
    stored += packed;
  }
  if (decoded !== size || stored !== storedSize) throw new InvalidXp3();
  return Buffer.concat(parts, size);
}

export function inspectXp3(path: string, requireExecutable = false) {
  return withMetadataReader(path, async (file) => {
    const archive = await locateArchive(file, requireExecutable);
    if (!archive) return;
    try {
      const entries = await readIndex(archive);
      const startup = entries.get(startupName);
      const config = entries.get(configName);
      if (startup && config && entries.has(initializeName)) {
        return { scripts: { startup: await readScript(archive, startup), config: await readScript(archive, config) } };
      }
    } catch (error) {
      if (!(error instanceof InvalidXp3)) throw error;
    }
    return {};
  });
}
