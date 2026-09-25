import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { GoSumdbProofInvalid, verifyGoSumdbRecordProof }
  from '../../../services/main/src/modules/package/go-sumdb-proof.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const leaf = (bytes: Uint8Array) => sha(Buffer.concat([Buffer.from([0]), bytes]));
const node = (left: Buffer, right: Buffer) =>
  sha(Buffer.concat([Buffer.from([1]), left, right]));

function fixture(count: number, index: number) {
  const records = Array.from({ length: count }, (_, item) =>
    Buffer.from(`example.com/m${item} v1.0.0/go.mod h1:test${item}\n`));
  const proof: string[] = [];
  const tree = (lo: number, hi: number, selected: boolean): Buffer => {
    if (hi - lo === 1) return leaf(records[lo]!);
    const k = 2 ** Math.floor(Math.log2(hi - lo - 1));
    const split = lo + k;
    const left = tree(lo, split, selected && index < split);
    const right = tree(split, hi, selected && index >= split);
    if (selected) proof.push((index < split ? right : left).toString('base64'));
    return node(left, right);
  };
  const rootHash = tree(0, count, true).toString('base64');
  return { record: records[index]!, proof,
    signed: { server: 'sum.golang.org' as const, size: count, rootHash,
      noteSha256: '0'.repeat(64) } };
}

test('PKG05/PKG14: Go record proof verifies balanced and uneven trees', () => {
  for (const count of [1, 2, 3, 4, 5, 7, 8, 9, 17]) {
    for (let index = 0; index < count; index++) {
      const item = fixture(count, index);
      expect(() => verifyGoSumdbRecordProof(item.signed, index,
        item.record, item.proof)).not.toThrow();
    }
  }
  const item = fixture(9, 5);
  for (const changed of [
    () => verifyGoSumdbRecordProof(item.signed, 5, Buffer.from('changed'), item.proof),
    () => verifyGoSumdbRecordProof(item.signed, 5, item.record, item.proof.slice(1)),
    () => verifyGoSumdbRecordProof(item.signed, 5, item.record,
      [Buffer.alloc(32).toString('base64'), ...item.proof.slice(1)]),
    () => verifyGoSumdbRecordProof(item.signed, 5, item.record,
      [...item.proof, item.proof[0]!]),
    () => verifyGoSumdbRecordProof(item.signed, 9, item.record, item.proof),
    () => verifyGoSumdbRecordProof({ ...item.signed,
      rootHash: Buffer.alloc(32).toString('base64') }, 5, item.record, item.proof),
  ]) expect(changed).toThrow(GoSumdbProofInvalid);
});
