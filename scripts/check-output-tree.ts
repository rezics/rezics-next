/** Closed, uncompressed transport for the official Kernel client output. Ordinary returns still have 64 leaves. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  rmdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CHECK_HOST_NAME_PATTERN } from './check-placement.ts';
import { processIdentity, sameProcess, validateRunnerIdentity, type RunnerIdentity } from './check-custody.ts';
import { parseArtifactManifest } from './check-artifacts.ts';
import { recognizeCheckHostRun } from './check-placement.ts';

export const KERNEL_CLIENT_OUTPUT = Object.freeze({
  profile: 'kernel-client-v1',
  root: 'packages/client/src/kernel',
  transport: '.temp/check-output-tree/kernel-client-v1.bin',
  maxMembers: 512,
  maxBytes: 32 * 1024 * 1024,
  maxMemberBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxPathBytes: 1024,
} as const);
const MAGIC = Buffer.from('REZICS-OUTPUT-TREE/1\n');
export const OUTPUT_TREE_HEADER_BYTES = 1024;
// JSON escaping uses at most six bytes per UTF-8 path byte. Metadata and newline fit in 160 more bytes.
export const OUTPUT_TREE_MEMBER_RECORD_BYTES = 6 * KERNEL_CLIENT_OUTPUT.maxPathBytes + 160;
export const OUTPUT_TREE_MANIFEST_BYTES =
  OUTPUT_TREE_HEADER_BYTES + KERNEL_CLIENT_OUTPUT.maxMembers * OUTPUT_TREE_MEMBER_RECORD_BYTES;
export const OUTPUT_TREE_TRANSPORT_BYTES = MAGIC.length + OUTPUT_TREE_MANIFEST_BYTES + KERNEL_CLIENT_OUTPUT.maxBytes;
const HASH = /^[a-f0-9]{64}$/;
const RUN = /^[a-z0-9-]{1,64}$/;
const STAGING = 'packages/client/src/.kernel-output-tree';

export type OutputTreeBinding = { host: string; run: string; sourceSha256: string };
/** Supplied by the physical receiver, from its own native/prepared/return receipts, never from the bundle. */
export type OutputTreeAuthority = OutputTreeBinding & { exitCode: number; bundleSha256: string };
export type OutputTreeMember = { path: string; size: number; sha256: string };
export type OutputTreeHeader = OutputTreeBinding & {
  version: 1;
  profile: typeof KERNEL_CLIENT_OUTPUT.profile;
  root: typeof KERNEL_CLIENT_OUTPUT.root;
  status: 'complete';
  count: number;
  totalBytes: number;
  catalogueSha256: string;
};
export type ValidatedOutputTree = { header: OutputTreeHeader; members: OutputTreeMember[]; contents: Buffer[] };
export const outputTreeDigest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function outputTreeProfile(profile: string): typeof KERNEL_CLIENT_OUTPUT {
  if (profile !== KERNEL_CLIENT_OUTPUT.profile) throw new Error('check-output-tree: unknown output profile');
  return KERNEL_CLIENT_OUTPUT;
}
export function hasOutputTreeReturn(paths: readonly string[]): boolean {
  return paths.includes(KERNEL_CLIENT_OUTPUT.transport);
}
/** Retain declarations as compiler inputs; exclude only transport and restoration staging. */
export function outputTreeInputExclusions(paths: readonly string[]): string[] {
  return [...paths, ...(hasOutputTreeReturn(paths) ? [STAGING] : [])];
}
function fail(message: string): never {
  throw new Error(`check-output-tree: ${message}`);
}
function binding(value: OutputTreeBinding): void {
  if (!new RegExp(CHECK_HOST_NAME_PATTERN).test(value.host) || !RUN.test(value.run) || !HASH.test(value.sourceSha256))
    fail('invalid physical source binding');
}
function keys(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names)
    fail('invalid record shape');
}
export function outputTreeMemberPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > KERNEL_CLIENT_OUTPUT.maxPathBytes ||
    value !== value.normalize('NFC') ||
    Buffer.from(value).toString('utf8') !== value ||
    /[\\\x00-\x1f\x7f:]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
    value.split('/').length > KERNEL_CLIENT_OUTPUT.maxDepth
  )
    fail('unsafe member path or path/depth bound');
  return value;
}
/** Checks every ancestor, including an existing final component; never resolves a symlink into permission. */
export function safeOutputTreePath(root: string, path: string, createParents = false): string {
  if (realpathSync(root) !== resolve(root)) fail('workspace has symlink ancestors');
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\\\0\r\n]/.test(path) ||
    /^[A-Za-z]:/.test(path)
  )
    fail('unsafe contained path');
  const parts = path.split('/');
  let current = resolve(root);
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()))
        fail('symlink or unsafe ancestor');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && index < parts.length - 1) {
        mkdirSync(current, { mode: 0o700 });
        syncDirectory(dirname(current));
      }
    }
  }
  return current;
}
export function readOutputTreeFile(root: string, path: string, maxBytes = OUTPUT_TREE_TRANSPORT_BYTES): Buffer {
  const file = safeOutputTreePath(root, path);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('unsafe file or encoded/member byte bound');
    const bytes = Buffer.alloc(stat.size);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(descriptor, bytes, count, bytes.length - count, count);
      if (!received) fail('incomplete file');
      count += received;
    }
    const after = fstatSync(descriptor);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      fail('file changed while reading');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableRename(from: string, to: string): void {
  renameSync(from, to);
  syncDirectory(dirname(from));
  if (dirname(from) !== dirname(to)) syncDirectory(dirname(to));
}
function atomic(root: string, path: string, bytes: Uint8Array): void {
  const file = safeOutputTreePath(root, path, true);
  const temporary = `${file}.${randomUUID()}.pending`;
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    durableRename(temporary, file);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}
function ordered(members: readonly OutputTreeMember[]): void {
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const member of members) {
    outputTreeMemberPath(member.path);
    const folded = member.path.toUpperCase().toLowerCase();
    if (seen.has(folded) || (previous !== undefined && previous >= member.path))
      fail('duplicate/case collision or unordered catalogue');
    for (let parent = dirname(folded); parent !== '.'; parent = dirname(parent)) {
      if (seen.has(parent)) fail('file/ancestor collision');
    }
    seen.add(folded);
    previous = member.path;
  }
  // A case-folded parent can sort after a child in the original ordering.
  for (const path of seen) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent))
      if (seen.has(parent)) fail('file/ancestor collision');
  }
}
/** Finite traversal uses streaming directory enumeration, with an independent bound on empty directories. */
export function collectOutputTree(root: string): { members: OutputTreeMember[]; contents: Buffer[] } {
  const owned = safeOutputTreePath(root, KERNEL_CLIENT_OUTPUT.root);
  if (!lstatSync(owned).isDirectory()) fail('generated tree is missing or not a directory');
  const collected: Array<{ member: OutputTreeMember; bytes: Buffer }> = [];
  let examined = 0;
  let total = 0;
  function visit(path: string, prefix: string): void {
    if (++examined > 1 + KERNEL_CLIENT_OUTPUT.maxMembers * KERNEL_CLIENT_OUTPUT.maxDepth)
      fail('directory traversal bound');
    const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        outputTreeMemberPath(key);
        const relative = `${KERNEL_CLIENT_OUTPUT.root}/${key}`;
        const full = safeOutputTreePath(root, relative);
        const stat = lstatSync(full);
        if (stat.isDirectory()) visit(full, key);
        else {
          if (collected.length >= KERNEL_CLIENT_OUTPUT.maxMembers) fail('member count bound');
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > KERNEL_CLIENT_OUTPUT.maxMemberBytes)
            fail('unsafe member or per-member bound');
          total += stat.size;
          if (total > KERNEL_CLIENT_OUTPUT.maxBytes) fail('aggregate decoded byte bound');
          const bytes = readOutputTreeFile(root, relative, stat.size);
          if (bytes.length !== stat.size) fail('member changed during capture');
          collected.push({ member: { path: key, size: bytes.length, sha256: outputTreeDigest(bytes) }, bytes });
        }
      }
    } finally {
      directory.closeSync();
    }
  }
  visit(owned, '');
  collected.sort((a, b) => (a.member.path < b.member.path ? -1 : a.member.path > b.member.path ? 1 : 0));
  ordered(collected.map((item) => item.member));
  return { members: collected.map((item) => item.member), contents: collected.map((item) => item.bytes) };
}
export function encodeOutputTree(root: string, source: OutputTreeBinding): Buffer {
  binding(source);
  const { members, contents } = collectOutputTree(root);
  const catalogue = Buffer.from(members.map((member) => `${JSON.stringify(member)}\n`).join(''));
  for (const member of members)
    if (Buffer.byteLength(`${JSON.stringify(member)}\n`) > OUTPUT_TREE_MEMBER_RECORD_BYTES)
      fail('encoded record bound');
  const header: OutputTreeHeader = {
    version: 1,
    profile: KERNEL_CLIENT_OUTPUT.profile,
    root: KERNEL_CLIENT_OUTPUT.root,
    ...source,
    status: 'complete',
    count: members.length,
    totalBytes: contents.reduce((sum, bytes) => sum + bytes.length, 0),
    catalogueSha256: outputTreeDigest(catalogue),
  };
  const record = Buffer.from(`${JSON.stringify(header)}\n`);
  if (record.length > OUTPUT_TREE_HEADER_BYTES) fail('encoded header bound');
  return Buffer.concat([MAGIC, record, catalogue, ...contents]);
}
/** Count is admitted before allocating/parsing the member catalogue. All hashes validate before publication. */
export function validateOutputTree(bytes: Buffer, authority: OutputTreeAuthority): ValidatedOutputTree {
  binding(authority);
  if (bytes.length > OUTPUT_TREE_TRANSPORT_BYTES) fail('encoded byte bound');
  if (
    authority.exitCode !== 0 ||
    !HASH.test(authority.bundleSha256) ||
    outputTreeDigest(bytes) !== authority.bundleSha256
  )
    fail('failed command or unauthenticated transport bytes');
  if (bytes.length > OUTPUT_TREE_TRANSPORT_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC))
    fail('unknown tree version or encoded byte bound');
  let offset = MAGIC.length;
  function line(max: number): Buffer {
    const end = bytes.indexOf(10, offset);
    if (end < offset || end - offset + 1 > max) fail('incomplete or oversized manifest record');
    const record = bytes.subarray(offset, end + 1);
    if (!Buffer.from(record.toString('utf8')).equals(record)) fail('invalid manifest UTF-8');
    offset = end + 1;
    return record;
  }
  const header = JSON.parse(line(OUTPUT_TREE_HEADER_BYTES).toString('utf8')) as OutputTreeHeader;
  keys(header, 'catalogueSha256,count,host,profile,root,run,sourceSha256,status,totalBytes,version');
  if (header.version !== 1) fail('unknown tree version');
  if (
    header.profile !== KERNEL_CLIENT_OUTPUT.profile ||
    header.root !== KERNEL_CLIENT_OUTPUT.root ||
    header.host !== authority.host ||
    header.run !== authority.run ||
    header.sourceSha256 !== authority.sourceSha256 ||
    header.status !== 'complete'
  )
    fail('wrong source/run/profile or incomplete output');
  if (
    !Number.isSafeInteger(header.count) ||
    header.count < 0 ||
    header.count > KERNEL_CLIENT_OUTPUT.maxMembers ||
    !Number.isSafeInteger(header.totalBytes) ||
    header.totalBytes < 0 ||
    header.totalBytes > KERNEL_CLIENT_OUTPUT.maxBytes ||
    !HASH.test(header.catalogueSha256)
  )
    fail('manifest count or decoded byte bound');
  const catalogueStart = offset;
  const members: OutputTreeMember[] = [];
  let total = 0;
  for (let index = 0; index < header.count; index++) {
    const member = JSON.parse(line(OUTPUT_TREE_MEMBER_RECORD_BYTES).toString('utf8')) as OutputTreeMember;
    keys(member, 'path,sha256,size');
    outputTreeMemberPath(member.path);
    if (
      !Number.isSafeInteger(member.size) ||
      member.size < 0 ||
      member.size > KERNEL_CLIENT_OUTPUT.maxMemberBytes ||
      !HASH.test(member.sha256)
    )
      fail('invalid member size/hash');
    total += member.size;
    if (total > KERNEL_CLIENT_OUTPUT.maxBytes) fail('aggregate decoded byte bound');
    members.push(member);
  }
  if (outputTreeDigest(bytes.subarray(catalogueStart, offset)) !== header.catalogueSha256)
    fail('catalogue digest mismatch');
  ordered(members);
  if (total !== header.totalBytes || offset + total !== bytes.length) fail('incomplete/trailing tree bytes');
  const contents: Buffer[] = [];
  for (const member of members) {
    const content = bytes.subarray(offset, offset + member.size);
    if (outputTreeDigest(content) !== member.sha256) fail('member digest mismatch');
    contents.push(content);
    offset += member.size;
  }
  return { header, members, contents };
}

type Publication = { version: 1; authority: OutputTreeAuthority; owner: RunnerIdentity };
function sameAuthority(left: OutputTreeAuthority, right: OutputTreeAuthority): boolean {
  return (
    left.host === right.host &&
    left.run === right.run &&
    left.sourceSha256 === right.sourceSha256 &&
    left.exitCode === right.exitCode &&
    left.bundleSha256 === right.bundleSha256
  );
}
function readPublication(root: string, path: string): Publication {
  const value = JSON.parse(readOutputTreeFile(root, path, 4096).toString('utf8')) as Publication;
  if (value.version !== 1 || !value.owner || !value.authority) fail('invalid publication journal');
  binding(value.authority);
  validateRunnerIdentity(value.owner);
  return value;
}
function removeSafeTree(root: string, path: string): void {
  const absolute = safeOutputTreePath(root, path);
  if (!existsSync(absolute)) return;
  // Validate bounded children without ever following links, even during recovery/backup cleanup.
  let examined = 0;
  function inspect(full: string, depth: number): void {
    if (depth > 20 || ++examined > 1 + KERNEL_CLIENT_OUTPUT.maxMembers * 20) fail('cleanup traversal bound');
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)))
      fail('unsafe cleanup member');
    if (stat.isDirectory()) {
      const directory = opendirSync(full);
      try {
        for (let child = directory.readSync(); child; child = directory.readSync())
          inspect(join(full, child.name), depth + 1);
      } finally {
        directory.closeSync();
      }
    }
  }
  inspect(absolute, 0);
  rmSync(absolute, { recursive: true });
}
/** Synchronous publication also serves the existing synchronous artifact receiver. No other run can steal a live lock. */
export function restoreOutputTree(
  root: string,
  bytes: Buffer,
  authority: OutputTreeAuthority,
  interrupt?: (phase: 'backed-up' | 'published') => void,
): OutputTreeMember[] {
  const tree = validateOutputTree(bytes, authority);
  safeOutputTreePath(root, `${STAGING}/lock`, true);
  const lock = `${STAGING}/lock`;
  try {
    mkdirSync(join(root, lock));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = readPublication(root, `${lock}/owner.json`);
    if (!sameAuthority(prior.authority, authority) || sameProcess(prior.owner))
      fail('concurrent receiving or foreign interrupted owner');
    rmSync(safeOutputTreePath(root, `${lock}/owner.json`));
    rmdirSync(safeOutputTreePath(root, lock));
    mkdirSync(join(root, lock));
  }
  const publication: Publication = {
    version: 1,
    authority,
    owner: processIdentity() ?? fail('publication owner identity unavailable'),
  };
  atomic(root, `${lock}/owner.json`, Buffer.from(JSON.stringify(publication)));
  const journal = `${STAGING}/journal.json`;
  const done = `${STAGING}/receipt.json`;
  const candidate = `${STAGING}/candidate`;
  const backup = `${STAGING}/backup`;
  const destination = KERNEL_CLIENT_OUTPUT.root;
  try {
    // Recover only this exact terminal bundle. A backup is never inferred from an arbitrary directory name.
    if (existsSync(safeOutputTreePath(root, journal))) {
      const previous = readPublication(root, journal);
      if (!sameAuthority(previous.authority, authority))
        fail('interrupted publication belongs to another physical result');
      if (existsSync(safeOutputTreePath(root, backup))) {
        if (existsSync(safeOutputTreePath(root, destination))) {
          const current = collectOutputTree(root);
          if (JSON.stringify(current.members) !== JSON.stringify(tree.members)) fail('interrupted destination changed');
          atomic(root, done, Buffer.from(JSON.stringify(publication)));
          removeSafeTree(root, backup);
        } else durableRename(join(root, backup), safeOutputTreePath(root, destination, true));
      }
      removeSafeTree(root, candidate);
      rmSync(join(root, journal));
      syncDirectory(join(root, STAGING));
    }
    if (existsSync(safeOutputTreePath(root, done))) {
      const previous = readPublication(root, done);
      if (sameAuthority(previous.authority, authority)) {
        if (JSON.stringify(collectOutputTree(root).members) !== JSON.stringify(tree.members))
          fail('same-terminal destination changed');
        return tree.members;
      }
    }
    if (existsSync(safeOutputTreePath(root, candidate)) || existsSync(safeOutputTreePath(root, backup)))
      fail('unowned publication staging without a journal');
    if (existsSync(safeOutputTreePath(root, destination))) collectOutputTree(root); // safe bounded prior tree
    atomic(root, journal, Buffer.from(JSON.stringify(publication)));
    mkdirSync(safeOutputTreePath(root, candidate));
    syncDirectory(join(root, STAGING));
    for (let index = 0; index < tree.members.length; index++) {
      const path = `${candidate}/${tree.members[index]!.path}`;
      atomic(root, path, tree.contents[index]!);
    }
    if (existsSync(safeOutputTreePath(root, destination))) durableRename(join(root, destination), join(root, backup));
    interrupt?.('backed-up');
    durableRename(join(root, candidate), safeOutputTreePath(root, destination, true));
    interrupt?.('published');
    atomic(root, done, Buffer.from(JSON.stringify(publication)));
    removeSafeTree(root, backup);
    rmSync(join(root, journal));
    syncDirectory(join(root, STAGING));
    return tree.members;
  } finally {
    rmSync(safeOutputTreePath(root, `${lock}/owner.json`));
    rmdirSync(safeOutputTreePath(root, lock));
  }
}
/** Only a physical receiver's prior publication can authorize the legacy artifact receiver's idempotent replay. */
export function verifyPublishedOutputTree(root: string, bytes: Buffer): void {
  const prior = readPublication(root, `${STAGING}/receipt.json`);
  const tree = validateOutputTree(bytes, prior.authority);
  if (JSON.stringify(collectOutputTree(root).members) !== JSON.stringify(tree.members)) fail('published tree changed');
}

/** The official command is called once, after physical admission and prepared-source receipt verification. */
export async function withKernelClientOutput(
  root: string,
  command: () => Promise<number>,
  dependencies: {
    recognize?: typeof recognizeCheckHostRun;
    prepared?: (root: string, run: string) => OutputTreeBinding;
    /** Additional already-declared ordinary outputs, such as a schema dump in combined emission. */
    returns?: readonly string[];
  } = {},
): Promise<number> {
  const recognized = (dependencies.recognize ?? recognizeCheckHostRun)(root);
  if (recognized.outcome !== 'admitted') fail('capture requires admitted physical custody');
  const source = dependencies.prepared
    ? dependencies.prepared(root, recognized.runId)
    : (() => {
        const receiptRoot = '/srv/rezics-check/receipts';
        const receipt = JSON.parse(
          readOutputTreeFile(receiptRoot, `${recognized.runId}/prepared-inputs.json`, 4096).toString('utf8'),
        ) as OutputTreeBinding & { schema: number };
        if (receipt.schema !== 1) fail('prepared source receipt is missing or stale');
        const marker = JSON.parse(readOutputTreeFile(root, '.remote-check-supervisor', 4096).toString('utf8')) as {
          host: string;
          run: string;
        };
        if (marker.host !== receipt.host || marker.run !== receipt.run)
          fail('prepared source and physical marker disagree');
        return { host: receipt.host, run: receipt.run, sourceSha256: receipt.sourceSha256 };
      })();
  binding(source);
  if (source.run !== recognized.runId) fail('prepared source receipt is stale');
  const transport = safeOutputTreePath(root, KERNEL_CLIENT_OUTPUT.transport, true);
  if (existsSync(transport)) rmSync(transport);
  // The compiler imports the retained client declarations. The emitter replaces
  // this entire directory; its marker prevents publishing untouched compiler inputs.
  const generationMarker = `${KERNEL_CLIENT_OUTPUT.root}/.generation-pending`;
  if (existsSync(safeOutputTreePath(root, KERNEL_CLIENT_OUTPUT.root)))
    atomic(root, generationMarker, Buffer.from(source.run));
  const stage = process.env.REZICS_CHECK_ARTIFACTS_DIR;
  const physicalRunId = process.env.REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID;
  const artifacts = stage && physicalRunId ? await import('./check-artifacts.ts') : undefined;
  const declarations = [
    KERNEL_CLIENT_OUTPUT.transport,
    ...(dependencies.returns ?? []).filter((path) => path !== KERNEL_CLIENT_OUTPUT.transport),
  ];
  if (artifacts) await artifacts.registerArtifactDeclarations(root, stage!, physicalRunId!, declarations);
  let code: number | undefined;
  try {
    code = await command();
    if (code !== 0) return code; // failed output can never become a successful tree receipt
    if (existsSync(safeOutputTreePath(root, generationMarker)))
      fail('client generation did not replace previous declarations');
    const bytes = encodeOutputTree(root, source);
    atomic(root, KERNEL_CLIENT_OUTPUT.transport, bytes);
    return code;
  } finally {
    if (artifacts) {
      try {
        await artifacts.captureArtifactReturns(root, stage!, physicalRunId!, declarations);
      } catch (error) {
        if (code === undefined || code === 0) throw error;
        console.error(`check-output-tree: failed-command diagnostic capture unavailable: ${String(error)}`);
      }
    }
  }
}

/** Normal transport inventory stays schema 1: the tree is one real bounded regular file, not 512 generic returns. */
export type OutputTreeTransportManifest = {
  status: string;
  entries: Array<{ path: string; size: number; sha256: string; kind: 'file' | 'directory' }>;
};
function boundedTransportInventory(manifest: OutputTreeTransportManifest, declarations: readonly string[]): void {
  if (!Array.isArray(manifest.entries) || manifest.entries.length > 64 || declarations.length > 64)
    fail('ordinary transport file count bound');
  let total = 0;
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !entry.path ||
      Buffer.byteLength(entry.path) > 1024 ||
      entry.path.startsWith('/') ||
      /^[A-Za-z]:/.test(entry.path) ||
      /[\\\0\r\n]/.test(entry.path) ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(entry.path) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !HASH.test(entry.sha256) ||
      !['file', 'directory'].includes(entry.kind)
    )
      fail('invalid transport inventory');
    seen.add(entry.path);
    total += entry.size;
    if (total > 256 * 1024 * 1024) fail('ordinary aggregate transport byte bound');
  }
}
export function outputTreeTransportCandidates(
  sourceRoot: string,
  manifest: OutputTreeTransportManifest,
  declarations: readonly string[],
): Array<{ path: string; sha256: string; size: number }> {
  boundedTransportInventory(manifest, declarations);
  const candidates: Array<{ path: string; sha256: string; size: number }> = [];
  function authenticatedFile(path: string): { path: string; sha256: string; size: number } {
    const entries = manifest.entries.filter((entry) => entry.path === path);
    if (entries.length !== 1 || entries[0]!.kind !== 'file') fail('missing authenticated bundle/manifest inventory');
    return entries[0]!;
  }
  if (hasOutputTreeReturn(declarations)) candidates.push(authenticatedFile(KERNEL_CLIENT_OUTPUT.transport));
  // Nested stack placement retains its existing per-physical-run ordinary artifact envelope.
  for (const declaration of declarations) {
    const found = declaration.match(/^\.temp\/goal\/checks\/artifact-returns\/([a-f0-9-]{36})$/);
    if (!found) continue;
    const manifestPath = `${declaration}/manifest.json`;
    const listed = manifest.entries.find((entry) => entry.path === manifestPath);
    // Ordinary envelopes keep their old missing/malformed diagnostic semantics. They grant no tree authority.
    if ((!listed || listed.size > 256 * 1024) && !hasOutputTreeReturn(declarations)) continue;
    const inventory = authenticatedFile(manifestPath);
    const bytes = readOutputTreeFile(sourceRoot, inventory.path, 256 * 1024);
    if (bytes.length !== inventory.size || outputTreeDigest(bytes) !== inventory.sha256)
      fail('artifact manifest custody mismatch');
    const envelope = parseArtifactManifest(bytes, found[1]!);
    if (!envelope) {
      if (hasOutputTreeReturn(declarations)) fail('invalid nested artifact envelope');
      continue;
    }
    const declaredTree = envelope.declarations?.includes(KERNEL_CLIENT_OUTPUT.transport);
    const treeEntries = envelope.entries.filter((entry) => entry.path === KERNEL_CLIENT_OUTPUT.transport);
    if (!declaredTree && !treeEntries.length) continue; // unchanged ordinary schema-1 envelopes
    if (!declaredTree || treeEntries.length !== 1 || envelope.oversizePaths?.length)
      fail('missing/duplicate/incomplete nested tree declaration');
    const used = new Set<string>();
    let total = 0;
    for (const entry of envelope.entries) {
      if (
        entry.status !== 'returned' ||
        !entry.file ||
        !HASH.test(entry.sha256 ?? '') ||
        !Number.isSafeInteger(entry.size) ||
        entry.size! < 0 ||
        used.has(entry.file) ||
        !envelope.declarations!.some((path) => entry.path === path || entry.path.startsWith(`${path}/`))
      )
        fail('incomplete or unsafe nested artifact catalogue');
      used.add(entry.file);
      total += entry.size!;
      if (total > 256 * 1024 * 1024) fail('nested transport byte bound');
      const item = authenticatedFile(`${declaration}/${entry.file}`);
      if (item.sha256 !== entry.sha256 || item.size !== entry.size) fail('nested artifact custody mismatch');
      if (entry.path === KERNEL_CLIENT_OUTPUT.transport) candidates.push(item);
    }
    for (const path of envelope.declarations!)
      if (!envelope.entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`)))
        fail('missing nested declared output');
  }
  const unique = new Map<string, { path: string; sha256: string; size: number }>();
  for (const candidate of candidates) {
    if (candidate.size > OUTPUT_TREE_TRANSPORT_BYTES) fail('encoded transport byte bound');
    const key = `${candidate.sha256}:${candidate.size}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  if (unique.size > 1) fail('mixed direct/nested physical output trees');
  return [...unique.values()];
}
export function receiveOutputTrees(
  sourceRoot: string,
  destinationRoot: string,
  manifest: OutputTreeTransportManifest,
  terminal: OutputTreeBinding & { exitCode: number },
  declarations: readonly string[],
): void {
  const candidates = outputTreeTransportCandidates(sourceRoot, manifest, declarations);
  if (!candidates.length) return;
  if (manifest.status !== 'complete' || terminal.exitCode !== 0) fail('incomplete or failed physical output');
  if (candidates.length !== 1) fail('duplicate physical output tree');
  const contains = (declaration: string, path: string) => path === declaration || path.startsWith(`${declaration}/`);
  if (
    declarations.some((declaration) => !manifest.entries.some((entry) => contains(declaration, entry.path))) ||
    manifest.entries.some((entry) => !declarations.some((declaration) => contains(declaration, entry.path)))
  )
    fail('missing or undeclared complete transport catalogue');
  for (const entry of manifest.entries) {
    if (entry.kind === 'directory') {
      const directory = opendirSync(safeOutputTreePath(sourceRoot, entry.path));
      try {
        if (entry.size !== 0 || directory.readSync() || entry.sha256 !== outputTreeDigest(Buffer.from('directory\0')))
          fail('invalid transport directory');
      } finally {
        directory.closeSync();
      }
    } else if (entry.kind === 'file') {
      const content = readOutputTreeFile(sourceRoot, entry.path, entry.size);
      if (content.length !== entry.size || outputTreeDigest(content) !== entry.sha256)
        fail('transport member custody mismatch');
    } else fail('invalid transport member kind');
  }
  const candidate = candidates[0]!;
  const bytes = readOutputTreeFile(sourceRoot, candidate.path);
  if (bytes.length !== candidate.size) fail('transport size mismatch');
  restoreOutputTree(destinationRoot, bytes, { ...terminal, bundleSha256: candidate.sha256 });
}
