import { createHash } from 'node:crypto';
import type { VerifiedGoSumdbTreeNote } from './go-sumdb-note.ts';

export class GoSumdbProofInvalid extends Error {}

function hash(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function parseHash(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new GoSumdbProofInvalid('invalid Go checksum proof hash');
  }
  return bytes;
}

function node(left: Buffer, right: Buffer): Buffer {
  return hash(Buffer.concat([Buffer.from([1]), left, right]));
}

function largestPowerBelow(value: number): number {
  return 2 ** Math.floor(Math.log2(value - 1));
}

/** RFC 6962 audit-path verification; proof order is leaf to root, as in Go tlog. */
export function verifyGoSumdbRecordProof(tree: VerifiedGoSumdbTreeNote,
  recordIndex: number, recordText: Uint8Array, proofHashes: string[]): void {
  if (!Number.isSafeInteger(tree.size) || tree.size < 1
    || !Number.isSafeInteger(recordIndex) || recordIndex < 0
    || recordIndex >= tree.size || !Array.isArray(proofHashes)
    || proofHashes.length > 53 || recordText.length > 4096) {
    throw new GoSumdbProofInvalid('Go checksum proof exceeds profile');
  }
  const root = parseHash(tree.rootHash);
  const proof = proofHashes.map(parseHash);
  const leaf = hash(Buffer.concat([Buffer.from([0]), recordText]));
  let consumed = proof.length;
  const walk = (lo: number, hi: number): Buffer => {
    if (hi - lo === 1) {
      if (consumed !== 0) throw new GoSumdbProofInvalid('extra Go checksum proof hashes');
      return leaf;
    }
    if (consumed === 0) throw new GoSumdbProofInvalid('missing Go checksum proof hash');
    const sibling = proof[--consumed]!;
    const split = lo + largestPowerBelow(hi - lo);
    return recordIndex < split
      ? node(walk(lo, split), sibling)
      : node(sibling, walk(split, hi));
  };
  const calculated = walk(0, tree.size);
  if (!calculated.equals(root)) {
    throw new GoSumdbProofInvalid('Go checksum record is not in signed tree');
  }
}
