import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { GoSumdbLookupInvalid, GoSumdbLookupUnavailable,
  readGoSumdbRecordProof, verifyGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { verifyGoSumdbRecordProof }
  from '../../../services/main/src/modules/package/go-sumdb-proof.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const node = (left: Buffer, right: Buffer) =>
  sha(Buffer.concat([Buffer.from([1]), left, right]));

function fixture(count: number) {
  const records = Array.from({ length: count }, (_, index) =>
    Buffer.from(`example.com/m${index} v1.0.0/go.mod h1:test${index}\n`));
  const leaves = records.map(record => sha(Buffer.concat([Buffer.from([0]), record])));
  const root = (lo: number, hi: number): Buffer => {
    if (hi - lo === 1) return leaves[lo]!;
    const split = lo + 2 ** Math.floor(Math.log2(hi - lo - 1));
    return node(root(lo, split), root(split, hi));
  };
  const tile0 = Buffer.concat(leaves.slice(0, 256));
  const tile1 = Buffer.concat(leaves.slice(256));
  const level1 = count >= 256 ? root(0, 256) : null;
  const paths = new Map<string, Buffer>([
    [`tile/8/0/000${count >= 256 ? '' : `.p/${count}`}`, tile0],
    ...(count > 256 ? [[`tile/8/0/001.p/${count - 256}`, tile1],
      ['tile/8/1/000.p/1', level1!]] as Array<[string, Buffer]> : []),
  ]);
  const seen: string[] = [];
  const fetcher = (async (url: RequestInfo | URL) => {
    const value = String(url);
    seen.push(value);
    const bytes = paths.get(value.replace('https://sum.golang.org/', ''));
    return bytes ? new Response(bytes) : new Response('', { status: 404 });
  }) as typeof fetch;
  return { records, signed: { server: 'sum.golang.org' as const, size: count,
    rootHash: root(0, count).toString('base64'), noteSha256: '0'.repeat(64) },
  fetcher, seen };
}

test('PKG05/PKG14: bounded Go tiles yield exact record proof across tile boundary',
  async () => {
    const item = fixture(300);
    for (const index of [0, 1, 255, 256, 299]) {
      const proof = await readGoSumdbRecordProof(item.signed, index, item.fetcher);
      expect(() => verifyGoSumdbRecordProof(item.signed, index,
        item.records[index]!, proof.hashes)).not.toThrow();
      expect(proof.tilePaths.length).toBeLessThanOrEqual(3);
    }
    expect(item.seen.every(url => url.startsWith('https://sum.golang.org/tile/8/')))
      .toBe(true);
    const refused = (async () => new Response('', { status: 302 })) as typeof fetch;
    await expect(readGoSumdbRecordProof(item.signed, 299, refused))
      .rejects.toThrow(GoSumdbLookupUnavailable);
    const oversized = (async () => new Response(Buffer.alloc(9000))) as typeof fetch;
    await expect(readGoSumdbRecordProof(item.signed, 299, oversized))
      .rejects.toThrow(GoSumdbLookupUnavailable);
  });

test('PKG05/PKG14: signed Go lookup refuses a checksum that differs from capture',
  async () => {
    const lookup = '13544323\n'
      + 'golang.org/x/sync v0.1.0 h1:wsuoTGHzEhffawBOhz5CYhcrV4IdKZbEyZjBMuTp12o=\n'
      + 'golang.org/x/sync v0.1.0/go.mod h1:RxMgew5VJxzue5/jJTE5uejpjVlOe/izrB70Jof72aM=\n\n'
      + 'go.sum database tree\n65209736\n'
      + '5+uGFjx6xBZG8ip1+wi77v+grwbhhukIrxEUS8PXvRo=\n\n'
      + '— sum.golang.org Az3grnbssgK7ubgFX36gVETtNv0U23qxyAhAMai2QUfeGa3nB/akvkMdlUErfcZz7l/R3cVtYspg3dxXABkGZZKdsQ8=\n';
    const seen: string[] = [];
    const fetcher = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(lookup);
    }) as typeof fetch;
    await expect(verifyGoSumdbLookup({ path: 'golang.org/x/sync',
      version: 'v0.1.0' }, `h1:${Buffer.alloc(32).toString('base64')}`, fetcher))
      .rejects.toThrow(GoSumdbLookupInvalid);
    expect(seen).toEqual(['https://sum.golang.org/lookup/golang.org/x/sync@v0.1.0']);
  });
