import { gzipSync } from 'node:zlib';

const encoder = new TextEncoder();

function tarFile(path: string, bytes: Uint8Array): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
  return Buffer.concat([header, bytes, padding]);
}
export function crate(name: string, version: string, manifest: string, links = false): Uint8Array {
  const prefix = `${name}-${version}`;
  const archive = Buffer.concat([tarFile(`${prefix}/Cargo.toml`, encoder.encode(manifest)),
    tarFile(`${prefix}/src/lib.rs`, encoder.encode('pub fn fixture() {}\n')),
    ...(links ? [tarFile(`${prefix}/build.rs`, encoder.encode(
      'fn main() { panic!("oracle must not run build scripts"); }\n'))] : []),
    Buffer.alloc(1024)]);
  return gzipSync(archive, { mtime: 0 } as never);
}
