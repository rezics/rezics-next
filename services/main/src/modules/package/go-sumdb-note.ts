import { createHash, createPublicKey, verify } from 'node:crypto';

/** Pinned Go 1.27.1 cmd/go/internal/modfetch/key.go verifier for sum.golang.org. */
const VERIFIER = 'sum.golang.org+033de0ae+Ac4zctda0e5eza+HJyk9SxEdh+s3Ux18htTTAD8OuAn8';
const SIGNATURE = /^— sum\.golang\.org ([A-Za-z0-9+/]+={0,2})$/;
const TREE = /^go\.sum database tree\n([1-9][0-9]*)\n([A-Za-z0-9+/]{43}=)\n$/;

export class GoSumdbNoteInvalid extends Error {}

function base64(value: string, expectedBytes: number): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) {
    throw new GoSumdbNoteInvalid('invalid Go checksum note encoding');
  }
  return bytes;
}

export interface VerifiedGoSumdbTreeNote {
  server: 'sum.golang.org';
  size: number;
  rootHash: string;
  noteSha256: string;
}

/** Verify only the signed tree head. Inclusion and consistency need tile proofs. */
export function verifyGoSumdbTreeNote(input: Uint8Array): VerifiedGoSumdbTreeNote {
  if (!input.length || input.length > 4096) {
    throw new GoSumdbNoteInvalid('Go checksum tree note exceeds profile');
  }
  let note: string;
  try { note = new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { throw new GoSumdbNoteInvalid('Go checksum tree note is not UTF-8'); }
  const separator = note.indexOf('\n\n');
  if (separator < 0 || note.indexOf('\n\n', separator + 2) >= 0) {
    throw new GoSumdbNoteInvalid('invalid Go checksum tree note format');
  }
  const text = note.slice(0, separator + 1);
  const signatures = note.slice(separator + 2).split('\n');
  if (signatures.at(-1) !== '' || signatures.length < 2 || signatures.length > 9) {
    throw new GoSumdbNoteInvalid('invalid Go checksum note signatures');
  }
  if (signatures.slice(0, -1).some(line => !/^— [^\s+]+ [A-Za-z0-9+/]+={0,2}$/.test(line!))) {
    throw new GoSumdbNoteInvalid('invalid Go checksum note signature line');
  }
  const tree = TREE.exec(text);
  if (!tree) throw new GoSumdbNoteInvalid('invalid Go checksum tree head');
  const size = Number(tree[1]);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new GoSumdbNoteInvalid('invalid Go checksum tree size');
  }
  base64(tree[2]!, 32);

  const verifier = /^([^+]+)\+([0-9a-f]{8})\+(.+)$/.exec(VERIFIER);
  if (!verifier) throw new GoSumdbNoteInvalid('invalid Go checksum verifier');
  const [, name, hashHex, encodedKey] = verifier;
  const keyData = base64(encodedKey!, 33);
  if (keyData[0] !== 1) throw new GoSumdbNoteInvalid('unsupported Go checksum key');
  const keyHash = createHash('sha256').update(`${name}\n`).update(keyData)
    .digest().subarray(0, 4);
  if (keyHash.toString('hex') !== hashHex) {
    throw new GoSumdbNoteInvalid('Go checksum verifier key differs');
  }
  const publicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), keyData.subarray(1),
  ]), format: 'der', type: 'spki' });
  const trusted = signatures.slice(0, -1).some(line => {
    const match = SIGNATURE.exec(line!);
    if (!match) return false;
    let signature: Buffer;
    try { signature = base64(match[1]!, 68); }
    catch { return false; }
    return signature.subarray(0, 4).equals(keyHash)
      && verify(null, Buffer.from(text), publicKey, signature.subarray(4));
  });
  if (!trusted) throw new GoSumdbNoteInvalid('Go checksum tree signature differs');
  return { server: 'sum.golang.org', size, rootHash: tree[2]!,
    noteSha256: createHash('sha256').update(input).digest('hex') };
}
