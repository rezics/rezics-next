import { crc32 } from 'node:zlib';

export function fabricModJar(id: string, version: string) {
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, id, version, name: 'Fixture Mod' }));
  const name = Buffer.from('fabric.mod.json');
  const crc = crc32(manifest);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(manifest.length, 18);
  local.writeUInt32LE(manifest.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(manifest.length, 20);
  central.writeUInt32LE(manifest.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + manifest.length, 16);
  return Buffer.concat([local, name, manifest, central, name, end]);
}
