import { expect, test } from 'bun:test';
import { GoSumdbNoteInvalid, verifyGoSumdbTreeNote }
  from '../../../services/main/src/modules/package/go-sumdb-note.ts';

// Fixed signed tree from a Go 1.27.1 lookup of golang.org/x/sync@v0.1.0.
const NOTE = 'go.sum database tree\n65209736\n'
  + '5+uGFjx6xBZG8ip1+wi77v+grwbhhukIrxEUS8PXvRo=\n\n'
  + '— sum.golang.org Az3grnbssgK7ubgFX36gVETtNv0U23qxyAhAMai2QUfeGa3nB/akvkMdlUErfcZz7l/R3cVtYspg3dxXABkGZZKdsQ8=\n';

test('PKG05/PKG14: pinned Go sumdb key verifies a signed tree head', () => {
  expect(verifyGoSumdbTreeNote(Buffer.from(NOTE))).toMatchObject({
    server: 'sum.golang.org', size: 65209736,
    rootHash: '5+uGFjx6xBZG8ip1+wi77v+grwbhhukIrxEUS8PXvRo=',
    noteSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  for (const changed of [NOTE.replace('65209736', '65209737'),
    NOTE.replace('5+uG', '6+uG'), NOTE.replace('Az3g', 'Bz3g'),
    NOTE.replace('sum.golang.org Az3g', 'other.invalid Az3g'),
    NOTE.replace('— sum.golang.org', '— sum.golang.org\t'),
    NOTE.slice(0, -1)]) {
    expect(() => verifyGoSumdbTreeNote(Buffer.from(changed)))
      .toThrow(GoSumdbNoteInvalid);
  }
  expect(() => verifyGoSumdbTreeNote(Buffer.from([0xff, 0xfe])))
    .toThrow(GoSumdbNoteInvalid);
  expect(() => verifyGoSumdbTreeNote(Buffer.alloc(4097)))
    .toThrow(GoSumdbNoteInvalid);
});
