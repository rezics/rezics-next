import { createHash } from 'node:crypto';
import { validateGoModuleRequirement, type GoModuleRequirement }
  from './go-mvs.ts';
import { verifyGoSumdbTreeNote, type VerifiedGoSumdbTreeNote }
  from './go-sumdb-note.ts';
import { verifyGoSumdbRecordProof } from './go-sumdb-proof.ts';

export class GoSumdbLookupInvalid extends Error {}
export class GoSumdbLookupUnavailable extends Error {}

const ORIGIN = 'https://sum.golang.org';
const HEIGHT = 8;
const TILE_WIDTH = 1 << HEIGHT;
const MAX_TILES = 128;

async function boundedGet(url: string, maxBytes: number, signal: AbortSignal,
  fetcher: typeof fetch): Promise<Buffer> {
  let response: Response;
  try { response = await fetcher(url, { method: 'GET', redirect: 'manual', signal,
    headers: { accept: 'application/octet-stream',
      'user-agent': 'REZICS-go-sumdb-proof/1 (bounded lookup)' } }); }
  catch { throw new GoSumdbLookupUnavailable('Go checksum database request failed'); }
  if (response.status !== 200 || !response.body) {
    throw new GoSumdbLookupUnavailable('Go checksum database response unavailable');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared)
    || Number(declared) > maxBytes)) {
    throw new GoSumdbLookupUnavailable('Go checksum response exceeds byte limit');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new GoSumdbLookupUnavailable('Go checksum response exceeds byte limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoSumdbLookupUnavailable) throw error;
    throw new GoSumdbLookupUnavailable('Go checksum response was interrupted');
  } finally { reader.releaseLock(); }
  if (declared !== null && Number(declared) !== size) {
    throw new GoSumdbLookupUnavailable('Go checksum response length is incomplete');
  }
  return Buffer.concat(chunks, size);
}

function node(left: Buffer, right: Buffer): Buffer {
  return createHash('sha256').update(Buffer.from([1])).update(left).update(right).digest();
}

function largestPowerBelow(value: number): number {
  return 2 ** Math.floor(Math.log2(value - 1));
}

function tileNumberPath(value: number): string {
  const parts = [];
  do {
    parts.unshift(String(value % 1000).padStart(3, '0'));
    value = Math.floor(value / 1000);
  } while (value > 0);
  return parts.map((part, index) => index === parts.length - 1
    ? part : `x${part}`).join('/');
}

/** Derive a record audit path from Go's height-eight hash tiles. */
export async function readGoSumdbRecordProof(tree: VerifiedGoSumdbTreeNote,
  recordIndex: number, fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(15_000)):
  Promise<{ hashes: string[]; tilePaths: string[] }> {
  if (!Number.isSafeInteger(tree.size) || tree.size < 1
    || !Number.isSafeInteger(recordIndex) || recordIndex < 0
    || recordIndex >= tree.size) {
    throw new GoSumdbLookupInvalid('invalid Go checksum record index');
  }
  const tiles = new Map<string, Promise<Buffer>>();
  const tile = (level: number, number: number): Promise<Buffer> => {
    const count = Math.floor(tree.size / (2 ** (level * HEIGHT)));
    const width = Math.min(TILE_WIDTH, count - number * TILE_WIDTH);
    if (width < 1) throw new GoSumdbLookupInvalid('Go checksum tile is outside tree');
    const path = `tile/${HEIGHT}/${level}/${tileNumberPath(number)}`
      + (width === TILE_WIDTH ? '' : `.p/${width}`);
    let pending = tiles.get(path);
    if (!pending) {
      if (tiles.size >= MAX_TILES) {
        throw new GoSumdbLookupInvalid('Go checksum tile budget exhausted');
      }
      pending = boundedGet(`${ORIGIN}/${path}`, width * 32, signal, fetcher)
        .then(bytes => {
          if (bytes.length !== width * 32) {
            throw new GoSumdbLookupUnavailable('Go checksum tile width differs');
          }
          return bytes;
        });
      tiles.set(path, pending);
    }
    return pending;
  };
  const subtree = async (lo: number, hi: number): Promise<Buffer> => {
    const length = hi - lo;
    if (Number.isInteger(Math.log2(length)) && lo % length === 0) {
      const power = Math.log2(length);
      const tileLevel = Math.floor(power / HEIGHT);
      const basePower = tileLevel * HEIGHT;
      const start = lo / (2 ** basePower);
      const number = Math.floor(start / TILE_WIDTH);
      const offset = start % TILE_WIDTH;
      const span = 2 ** (power - basePower);
      const bytes = await tile(tileLevel, number);
      const hashes = Array.from({ length: span }, (_, index) =>
        bytes.subarray((offset + index) * 32, (offset + index + 1) * 32));
      if (hashes.some(value => value.length !== 32)) {
        throw new GoSumdbLookupUnavailable('Go checksum tile is incomplete');
      }
      const fold = (parts: Buffer[]): Buffer => parts.length === 1 ? parts[0]!
        : node(fold(parts.slice(0, parts.length / 2)),
          fold(parts.slice(parts.length / 2)));
      return fold(hashes);
    }
    const split = lo + largestPowerBelow(length);
    const [left, right] = await Promise.all([subtree(lo, split), subtree(split, hi)]);
    return node(left, right);
  };
  const proof = async (lo: number, hi: number): Promise<string[]> => {
    if (hi - lo === 1) return [];
    const split = lo + largestPowerBelow(hi - lo);
    if (recordIndex < split) {
      const [path, sibling] = await Promise.all([
        proof(lo, split), subtree(split, hi)]);
      return [...path, sibling.toString('base64')];
    }
    const [sibling, path] = await Promise.all([
      subtree(lo, split), proof(split, hi)]);
    return [...path, sibling.toString('base64')];
  };
  return { hashes: await proof(0, tree.size), tilePaths: [...tiles.keys()] };
}

export interface IncludedGoSumdbLookup {
  profile: 'go-sumdb-included-unpinned-v1';
  recordIndex: number;
  recordSha256: string;
  tree: VerifiedGoSumdbTreeNote;
  tilePaths: string[];
  goModH1: string;
}

/** Includes a lookup in a signed tree; timeline consistency is still unpinned. */
export async function verifyGoSumdbLookup(input: GoModuleRequirement,
  expectedGoModH1: string, fetcher: typeof fetch = fetch):
  Promise<IncludedGoSumdbLookup> {
  validateGoModuleRequirement(input);
  if (!/^h1:[A-Za-z0-9+/]{43}=$/.test(expectedGoModH1)) {
    throw new GoSumdbLookupInvalid('invalid expected Go manifest checksum');
  }
  const signal = AbortSignal.timeout(15_000);
  const bytes = await boundedGet(`${ORIGIN}/lookup/${input.path}@${input.version}`,
    4096, signal, fetcher);
  const idEnd = bytes.indexOf(10);
  const recordEnd = bytes.indexOf(Buffer.from('\n\n'), idEnd + 1);
  if (idEnd < 1 || recordEnd < 0) {
    throw new GoSumdbLookupInvalid('invalid Go checksum lookup record');
  }
  const id = bytes.subarray(0, idEnd).toString('ascii');
  if (!/^(0|[1-9][0-9]*)$/.test(id)) {
    throw new GoSumdbLookupInvalid('invalid Go checksum record index');
  }
  const recordIndex = Number(id);
  const recordBytes = bytes.subarray(idEnd + 1, recordEnd + 1);
  let record: string;
  try { record = new TextDecoder('utf-8', { fatal: true }).decode(recordBytes); }
  catch { throw new GoSumdbLookupInvalid('Go checksum record is not UTF-8'); }
  if (!record || /[\x00-\x09\x0b-\x1f]/.test(record)
    || record.includes('\n\n') || !record.endsWith('\n')) {
    throw new GoSumdbLookupInvalid('invalid Go checksum record text');
  }
  const signedTree = verifyGoSumdbTreeNote(bytes.subarray(recordEnd + 2));
  const exactLine = `${input.path} ${input.version}/go.mod ${expectedGoModH1}`;
  const matchingLines = record.split('\n').filter(line =>
    line.startsWith(`${input.path} ${input.version}/go.mod `));
  if (matchingLines.length !== 1 || matchingLines[0] !== exactLine) {
    throw new GoSumdbLookupInvalid('Go checksum record differs from capture');
  }
  const proof = await readGoSumdbRecordProof(signedTree, recordIndex, fetcher, signal);
  verifyGoSumdbRecordProof(signedTree, recordIndex, recordBytes, proof.hashes);
  return { profile: 'go-sumdb-included-unpinned-v1', recordIndex,
    recordSha256: createHash('sha256').update(recordBytes).digest('hex'),
    tree: signedTree, tilePaths: proof.tilePaths, goModH1: expectedGoModH1 };
}
