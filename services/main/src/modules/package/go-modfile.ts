// General go.mod reader following golang.org/x/mod/modfile: line and block
// directives, `//` comments attached before or after an entry, interpreted and
// raw strings, and retract rationale. `strict` is the main-module parse: an
// unknown verb is an error. `lax` is the dependency parse Go uses: only module,
// go, retract and require are read; every other verb (replace, exclude,
// toolchain, godebug, tool, unknown) is recorded as ignored, unchecked. The original line-oriented parser
// stays frozen for the earlier receipt profiles.

export interface GoModVersion { path: string; version: string }
export interface GoModRetraction { low: string; high: string; rationale: string }
export interface GoModReplacement { old: { path: string; version: string | null };
  new: { path: string; version: string | null } }
export interface GoModFile {
  module: string | null;
  go: string | null;
  toolchain: string | null;
  require: Array<GoModVersion & { indirect: boolean }>;
  exclude: GoModVersion[];
  replace: GoModReplacement[];
  retract: GoModRetraction[];
  godebug: Array<{ key: string; value: string }>;
  tool: string[];
  ignore: string[];
  /** Directives Go ignores in this mode (lax unknown verbs, dependency replace/exclude). */
  ignored: string[];
  errors: string[];
}

const MAX_BYTES = 262_144;
const MAX_ENTRIES = 4_096;
const GO_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)|(?:rc|beta)[1-9]\d*)?$/;
const TOOLCHAIN = /^(?:go(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}(?:(?:rc|beta)[1-9]\d*)?(?:-[A-Za-z0-9._-]+)?|default)$/;
const MODULE_PATH = /^[A-Za-z0-9][A-Za-z0-9._~\/-]*$/;
export const GO_MODULE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+incompatible)?$/;

interface Token { text: string; quoted: boolean }
interface Line { tokens: Token[]; before: string[]; suffix: string[]; number: number }

function lex(raw: string, number: number, errors: string[]): { tokens: Token[]; comment: string | null } {
  const tokens: Token[] = [];
  let at = 0;
  while (at < raw.length) {
    const char = raw[at]!;
    if (/\s/.test(char)) { at++; continue; }
    if (raw.startsWith('//', at)) return { tokens, comment: raw.slice(at + 2).trim() };
    if (raw.startsWith('=>', at)) { tokens.push({ text: '=>', quoted: false }); at += 2; continue; }
    if ('()[],'.includes(char)) { tokens.push({ text: char, quoted: false }); at++; continue; }
    if (char === '"') {
      let end = at + 1;
      while (end < raw.length && raw[end] !== '"') end += raw[end] === '\\' ? 2 : 1;
      if (end >= raw.length) { errors.push(`line ${number}: unterminated string`); return { tokens, comment: null }; }
      try { tokens.push({ text: JSON.parse(raw.slice(at, end + 1)) as string, quoted: true }); }
      catch { errors.push(`line ${number}: invalid quoted string`); }
      at = end + 1;
      continue;
    }
    if (char === '`') {
      const end = raw.indexOf('`', at + 1);
      if (end < 0) { errors.push(`line ${number}: unterminated raw string`); return { tokens, comment: null }; }
      tokens.push({ text: raw.slice(at + 1, end), quoted: true });
      at = end + 1;
      continue;
    }
    let end = at;
    while (end < raw.length && !/\s/.test(raw[end]!) && !'()[],"`'.includes(raw[end]!)
      && !raw.startsWith('//', end) && !raw.startsWith('=>', end)) end++;
    tokens.push({ text: raw.slice(at, end), quoted: false });
    at = end;
  }
  return { tokens, comment: null };
}

export function parseGoModFile(text: string, mode: 'strict' | 'lax'): GoModFile {
  const file: GoModFile = { module: null, go: null, toolchain: null, require: [], exclude: [],
    replace: [], retract: [], godebug: [], tool: [], ignore: [], ignored: [], errors: [] };
  const errors = file.errors;
  if (Buffer.byteLength(text) > MAX_BYTES) { errors.push('go.mod exceeds byte limit'); return file; }
  if (text.includes('\0') || text.includes('\r')) { errors.push('go.mod contains NUL or CR'); return file; }
  let pending: string[] = [];
  let block: { verb: string; before: string[]; suffix: string[] } | null = null;
  let entries = 0;
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    const { tokens, comment } = lex(raw, number, errors);
    if (!tokens.length) {
      if (comment !== null) pending.push(comment);
      else pending = [];
      continue;
    }
    const line: Line = { tokens, before: pending, suffix: comment === null ? [] : [comment], number };
    pending = [];
    if (++entries > MAX_ENTRIES) { errors.push('go.mod exceeds entry limit'); break; }
    if (block) {
      if (tokens.length === 1 && tokens[0]!.text === ')' && !tokens[0]!.quoted) { block = null; continue; }
      directive(file, block.verb, line, mode, block);
      continue;
    }
    const verb = tokens[0]!;
    if (verb.quoted) { errors.push(`line ${number}: quoted directive`); continue; }
    if (tokens.length === 2 && tokens[1]!.text === '(' && !tokens[1]!.quoted) {
      block = { verb: verb.text, before: line.before, suffix: line.suffix };
      continue;
    }
    directive(file, verb.text, { ...line, tokens: tokens.slice(1) }, mode, null);
  }
  if (block) errors.push(`unclosed ${block.verb} block`);
  return file;
}

function words(line: Line): string[] { return line.tokens.map(token => token.text); }
function rationale(line: Line, block: { before: string[]; suffix: string[] } | null): string {
  const own = [...line.before, ...line.suffix];
  return (own.length || !block ? own : [...block.before, ...block.suffix]).join('\n');
}
function modulePath(value: string | undefined): value is string {
  return typeof value === 'string' && value.length <= 256 && MODULE_PATH.test(value)
    && !value.includes('//') && !value.endsWith('/');
}

function directive(file: GoModFile, verb: string, line: Line, mode: 'strict' | 'lax',
  block: { before: string[]; suffix: string[] } | null): void {
  const args = words(line);
  const error = (message: string) => file.errors.push(`line ${line.number}: ${message}`);
  // x/mod's add(): a dependency keeps only these verbs and skips all others unchecked.
  if (mode === 'lax' && !['module', 'go', 'retract', 'require'].includes(verb)) {
    file.ignored.push(`${verb} ${args.join(' ')}`.trim().slice(0, 200));
    return;
  }
  switch (verb) {
    case 'module': {
      if (block || args.length !== 1 || !modulePath(args[0]) || file.module !== null) error('invalid module');
      else file.module = args[0]!;
      return;
    }
    case 'go': {
      if (block || args.length !== 1 || !GO_VERSION.test(args[0]!) || file.go !== null) error('invalid go');
      else file.go = args[0]!;
      return;
    }
    case 'toolchain': {
      if (block || args.length !== 1 || !TOOLCHAIN.test(args[0]!) || file.toolchain !== null) error('invalid toolchain');
      else file.toolchain = args[0]!;
      return;
    }
    case 'require': case 'exclude': {
      if (args.length !== 2 || !modulePath(args[0]) || !GO_MODULE_VERSION.test(args[1]!)) {
        error(`invalid ${verb}`);
        return;
      }
      const item = { path: args[0]!, version: args[1]! };
      if (verb === 'require') {
        file.require.push({ ...item, indirect: line.suffix.some(text => /^indirect(?:;|$)/.test(text)) });
      } else file.exclude.push(item);
      return;
    }
    case 'replace': {
      const arrow = args.indexOf('=>');
      const left = args.slice(0, arrow);
      const right = args.slice(arrow + 1);
      if (arrow < 1 || left.length > 2 || right.length < 1 || right.length > 2 || !modulePath(left[0])
        || (left[1] !== undefined && !GO_MODULE_VERSION.test(left[1]))
        || (right.length === 2 && (!modulePath(right[0]) || !GO_MODULE_VERSION.test(right[1]!)))) {
        error('invalid replace');
        return;
      }
      const item = { old: { path: left[0]!, version: left[1] ?? null },
        new: { path: right[0]!, version: right[1] ?? null } };
      file.replace.push(item);
      return;
    }
    case 'retract': {
      let low: string | undefined;
      let high: string | undefined;
      if (args.length === 1) { low = high = args[0]; }
      else if (args.length === 5 && args[0] === '[' && args[2] === ',' && args[4] === ']') {
        low = args[1]; high = args[3];
      }
      if (!low || !high || !GO_MODULE_VERSION.test(low) || !GO_MODULE_VERSION.test(high)
        || compareGoVersions(low, high) > 0) {
        error('invalid retract');
        return;
      }
      file.retract.push({ low, high, rationale: rationale(line, block) });
      return;
    }
    case 'godebug': {
      const match = args.length === 1 ? /^([A-Za-z0-9_.-]+)=([^\s]*)$/.exec(args[0]!) : null;
      if (!match) error('invalid godebug');
      else file.godebug.push({ key: match[1]!, value: match[2]! });
      return;
    }
    case 'tool': case 'ignore': {
      if (args.length !== 1) error(`invalid ${verb}`);
      else file[verb].push(args[0]!);
      return;
    }
    default:
      error(`unknown directive ${verb}`);
  }
}

function prerelease(value: string): string[] {
  const match = GO_MODULE_VERSION.exec(value);
  return match?.[4] ? match[4].slice(1).split('.') : [];
}

/** golang.org/x/mod/semver.Compare for canonical module versions; build metadata is ignored. */
export function compareGoVersions(left: string, right: string): number {
  const a = GO_MODULE_VERSION.exec(left);
  const b = GO_MODULE_VERSION.exec(right);
  if (!a || !b) throw new Error(`invalid Go module version ${a ? right : left}`);
  for (const index of [1, 2, 3]) {
    const x = BigInt(a[index]!);
    const y = BigInt(b[index]!);
    if (x !== y) return x < y ? -1 : 1;
  }
  const p = prerelease(left);
  const q = prerelease(right);
  if (!p.length || !q.length) return (p.length ? -1 : 0) + (q.length ? 1 : 0);
  for (let index = 0; index < Math.min(p.length, q.length); index++) {
    const x = p[index]!;
    const y = q[index]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return x.length !== y.length ? Math.sign(x.length - y.length) : x < y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return Math.sign(p.length - q.length);
}

/** Go toolchain order (go/version): 1.21 < 1.21beta1 < 1.21rc1 < 1.21.0 < 1.21.1. */
export function compareGoLanguage(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+)|(beta|rc)(\d+))?$/.exec(value);
    if (!match) throw new Error(`invalid Go version ${value}`);
    const rank = match[3] !== undefined ? 3 : match[4] === 'rc' ? 2 : match[4] === 'beta' ? 1 : 0;
    return [Number(match[1]), Number(match[2]), rank, Number(match[3] ?? match[5] ?? 0)];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}
