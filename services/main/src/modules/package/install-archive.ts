import { posix } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** A package archive entry after the single top-level npm directory is stripped. */
export interface ArchiveEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  executable: boolean;
  target: string | null;
  bytes: Uint8Array | null;
}

export type ArchiveViolationKind = 'path-traversal' | 'link-escape' | 'hard-link' | 'special-entry'
  | 'case-collision' | 'budget' | 'malformed';

export interface ArchiveViolation { kind: ArchiveViolationKind; path: string }

export interface ArchiveInspection {
  entries: ArchiveEntry[];
  violations: ArchiveViolation[];
  /** npm lifecycle hooks the archive would run on install (including implicit node-gyp). */
  lifecycleHooks: string[];
}

export const archiveLimits = { compressedBytes: 32 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024,
  entries: 10_000 } as const;

/** Mirrors `pkg.confined_path`: relative, no '.', '..', empty, drive, backslash or control. */
export function confinedPath(path: string): boolean {
  return Buffer.byteLength(path) >= 1 && Buffer.byteLength(path) <= 1024
    && /^[^/\\]+(\/[^/\\]+)*$/.test(path) && !/(^|\/)\.\.?(\/|$)/.test(path)
    && !/^[A-Za-z]:/.test(path) && !/\p{Cc}/u.test(path);
}

/** Platform-neutral collision folding: NFC plus lower case, as on a case-insensitive root. */
export function collisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function text(block: Uint8Array, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return Buffer.from(end < 0 ? slice : slice.subarray(0, end)).toString('utf8');
}

function octal(block: Uint8Array, start: number, length: number): number {
  const value = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) return Number.NaN;
  return value ? Number.parseInt(value, 8) : 0;
}

function pax(bytes: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  const source = Buffer.from(bytes).toString('utf8');
  let offset = 0;
  while (offset < source.length) {
    const space = source.indexOf(' ', offset);
    const length = Number.parseInt(source.slice(offset, space), 10);
    if (!(length > 0) || space < 0) break;
    const record = source.slice(space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Reads a gzip ustar/pax npm tarball without writing anything. Every entry is
 * checked before any effect: traversal, escaping or hard links, device/FIFO
 * entries, case-folding collisions and byte/entry budgets are violations.
 */
export function inspectNpmTarball(compressed: Uint8Array): ArchiveInspection {
  const violations: ArchiveViolation[] = [];
  const entries: ArchiveEntry[] = [];
  if (compressed.byteLength > archiveLimits.compressedBytes) {
    return { entries, violations: [{ kind: 'budget', path: '' }], lifecycleHooks: [] };
  }
  let tar: Uint8Array;
  try { tar = gunzipSync(compressed, { maxOutputLength: archiveLimits.expandedBytes }); }
  catch { return { entries, violations: [{ kind: 'malformed', path: '' }], lifecycleHooks: [] }; }
  const seen = new Map<string, string>();
  let offset = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let extended: Record<string, string> = {};
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]!) || '0';
    if (!Number.isFinite(size) || offset + 512 + size > tar.byteLength) {
      violations.push({ kind: 'malformed', path: text(header, 0, 100) });
      break;
    }
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { extended = pax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(data, 0, data.byteLength); continue; }
    if (type === 'K') { longLink = text(data, 0, data.byteLength); continue; }
    const prefix = text(header, 345, 155);
    const raw = extended.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    const link = extended.linkpath ?? longLink ?? text(header, 157, 100);
    extended = {};
    longName = null;
    longLink = null;
    if (entries.length + violations.length >= archiveLimits.entries) {
      violations.push({ kind: 'budget', path: raw });
      break;
    }
    const slash = raw.indexOf('/');
    const path = (slash < 0 ? '' : raw.slice(slash + 1)).replace(/\/+$/, '');
    const first = slash < 0 ? raw : raw.slice(0, slash);
    if (first === '..' || first === '.' || /^[A-Za-z]:/.test(first) || raw.includes('\\')) {
      violations.push({ kind: 'path-traversal', path: raw });
      continue;
    }
    if (raw.startsWith('/') || slash <= 0 || !path || !confinedPath(path)) {
      if (path || raw.startsWith('/') || raw.includes('..')) violations.push({ kind: 'path-traversal', path: raw });
      continue;
    }
    const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'directory'
      : type === '2' ? 'symlink' : null;
    if (type === '1') { violations.push({ kind: 'hard-link', path }); continue; }
    if (!kind) { violations.push({ kind: 'special-entry', path }); continue; }
    let target: string | null = null;
    if (kind === 'symlink') {
      const resolved = posix.normalize(posix.join(posix.dirname(path), link));
      if (!link || link.startsWith('/') || !confinedPath(resolved) || resolved.startsWith('..')) {
        violations.push({ kind: 'link-escape', path });
        continue;
      }
      target = link;
    }
    const folded = collisionKey(path);
    const previous = seen.get(folded);
    if (previous !== undefined && previous !== path) {
      violations.push({ kind: 'case-collision', path });
      continue;
    }
    seen.set(folded, path);
    const mode = octal(header, 100, 8);
    entries.push({ path, kind, executable: kind === 'file' && (mode & 0o111) !== 0, target,
      bytes: kind === 'file' ? new Uint8Array(data) : null });
  }
  return { entries, violations, lifecycleHooks: violations.length ? [] : lifecycleHooks(entries) };
}

function lifecycleHooks(entries: ArchiveEntry[]): string[] {
  const manifest = entries.find(entry => entry.path === 'package.json' && entry.bytes);
  const hooks = new Set<string>();
  if (manifest) {
    try {
      const scripts = (JSON.parse(Buffer.from(manifest.bytes!).toString('utf8')) as
        { scripts?: Record<string, unknown> }).scripts ?? {};
      for (const name of ['preinstall', 'install', 'postinstall']) {
        if (typeof scripts[name] === 'string') hooks.add(name);
      }
    } catch { hooks.add('unparseable-package-json'); }
  }
  // npm runs `node-gyp rebuild` for a binding.gyp without an explicit install script.
  if (entries.some(entry => entry.path === 'binding.gyp') && !hooks.has('install')
    && !hooks.has('preinstall')) hooks.add('install:node-gyp');
  return [...hooks].sort();
}
