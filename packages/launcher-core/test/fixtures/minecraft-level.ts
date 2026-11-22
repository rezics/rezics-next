import { gzipSync } from 'node:zlib';

export function levelSavedIn(version: string) {
  return gzipSync(
    Buffer.concat([
      Buffer.from('\x0a\x00\x00\x0a\x00\x04Data\x0a\x00\x07Version\x01\x00\x08Snapshot\x00\x08\x00\x04Name\x00'),
      Buffer.from([Buffer.byteLength(version)]),
      Buffer.from(version),
      Buffer.from([0, 0, 0]),
    ]),
  );
}
