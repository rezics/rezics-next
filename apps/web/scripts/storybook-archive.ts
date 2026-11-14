import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const magic = Buffer.from('REZICS-STORYBOOK/1\n');
const maxBytes = 240 * 1024 * 1024;
const maxManifestBytes = 4 * 1024 * 1024;
const maxMembers = 16_384;
type Member = { path: string; size: number; sha256: string };
type Manifest = { version: 1; commit: string; members: Member[] };

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function memberPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 1_024 ||
    value !== value.normalize('NFC') ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    value.split('/').length > 32
  )
    throw new Error('Invalid Storybook archive member path.');
  return value;
}

/** Publication returns one ordinary file; generic check-artifact limits remain unchanged. */
export function writeStorybookArchive(output: string, archive: string, commit: string): void {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Storybook archive requires a full revision.');
  const members: Member[] = [];
  const bodies: Buffer[] = [];
  let size = magic.length + 4;
  const visit = (directory: string, prefix = '') => {
    if (!lstatSync(directory).isDirectory()) throw new Error('Storybook archive requires ordinary directories.');
    for (const name of readdirSync(directory).sort()) {
      const path = memberPath(prefix ? `${prefix}/${name}` : name);
      const source = join(directory, name);
      const stat = lstatSync(source);
      if (stat.isDirectory()) visit(source, path);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || members.length >= maxMembers || size + stat.size > maxBytes)
          throw new Error('Storybook archive contains unsupported or oversized output.');
        const body = readOrdinaryFile(source, maxBytes - size);
        members.push({ path, size: body.length, sha256: digest(body) });
        bodies.push(body);
        size += body.length;
      }
    }
  };
  visit(output);
  verifyPublication(members, bodies, commit);
  const manifest = Buffer.from(JSON.stringify({ version: 1, commit, members } satisfies Manifest));
  if (manifest.length > maxManifestBytes || size + manifest.length > maxBytes)
    throw new Error('Storybook archive exceeds its publication bound.');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  mkdirSync(dirname(archive), { recursive: true });
  const temporary = `${archive}.partial`;
  try {
    writeFileSync(temporary, Buffer.concat([magic, length, manifest, ...bodies]), { mode: 0o644 });
    renameSync(temporary, archive);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOrdinaryFile(path: string, bound: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > bound)
      throw new Error('Storybook archive requires a bounded ordinary file.');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Storybook archive changed while reading.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function verifyPublication(members: Member[], bodies: Buffer[], commit: string): void {
  const build = members.findIndex((member) => member.path === 'build.json');
  if (
    build < 0 ||
    JSON.parse(bodies[build]!.toString('utf8')).commit !== commit ||
    !members.some((member) => member.path === 'index.json') ||
    !members.some((member) => member.path === 'index.html')
  )
    throw new Error('Storybook archive does not contain the expected publication revision and index.');
}

/** Validate every returned byte before replacing the local deployment directory. */
export function restoreStorybookArchive(archive: string, output: string, commit: string): void {
  const bytes = readOrdinaryFile(archive, maxBytes);
  if (
    !/^[0-9a-f]{40}$/.test(commit) ||
    bytes.length < magic.length + 4 ||
    !bytes.subarray(0, magic.length).equals(magic)
  )
    throw new Error('Invalid Storybook publication archive.');
  const length = bytes.readUInt32BE(magic.length);
  let offset = magic.length + 4 + length;
  if (length > maxManifestBytes || offset > bytes.length) throw new Error('Invalid Storybook archive manifest length.');
  const manifest: unknown = JSON.parse(bytes.subarray(magic.length + 4, offset).toString('utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    manifest.version !== 1 ||
    !('commit' in manifest) ||
    manifest.commit !== commit ||
    !('members' in manifest) ||
    !Array.isArray(manifest.members) ||
    manifest.members.length > maxMembers
  )
    throw new Error('Storybook archive manifest does not match this publication.');
  const members: Member[] = [];
  const bodies: Buffer[] = [];
  const paths = new Set<string>();
  for (const item of manifest.members) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    )
      throw new Error('Invalid Storybook archive member.');
    const path = memberPath(item.path);
    if (paths.has(path) || offset + item.size > bytes.length)
      throw new Error('Duplicate or truncated Storybook archive member.');
    paths.add(path);
    const body = bytes.subarray(offset, offset + item.size);
    if (digest(body) !== item.sha256) throw new Error('Storybook archive member digest mismatch.');
    members.push({ path, size: item.size, sha256: item.sha256 });
    bodies.push(body);
    offset += item.size;
  }
  if (offset !== bytes.length) throw new Error('Unexpected trailing Storybook archive bytes.');
  verifyPublication(members, bodies, commit);
  // Reject file/directory collisions before writing any output.
  for (const { path } of members) {
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++)
      if (paths.has(parts.slice(0, depth).join('/'))) throw new Error('Conflicting Storybook archive paths.');
  }
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), '.storybook-restore-'));
  const backup = `${staging}-previous`;
  let moved = false;
  try {
    for (const [index, member] of members.entries()) {
      const destination = join(staging, member.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bodies[index]!, { flag: 'wx', mode: 0o644 });
    }
    try {
      renameSync(output, backup);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      renameSync(staging, output);
    } catch (error) {
      if (moved) renameSync(backup, output);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
