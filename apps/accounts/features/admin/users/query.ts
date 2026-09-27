import type { DirectoryParams, OperatorRole, UserStatus } from '../api/types.ts';

// The directory's one search box: free text plus `key:value` filters, with a
// leading `-` to negate. Parsed the same way on the server (first render) and
// in the browser (search as you type); the raw text is the `q` URL parameter.

const filterKeys = ['email', 'name', 'id', 'status', 'role', 'verified', '2fa', 'created'] as const;
export type FilterKey = typeof filterKeys[number];
const statusValues = { active: 'active', suspended: 'suspended', reset: 'password-reset-required' } as const satisfies
  Record<string, UserStatus>;
type StatusValue = keyof typeof statusValues;
const roleValues = ['owner', 'admin', 'support', 'none'] as const;
type RoleValue = OperatorRole | 'none';

export interface QueryToken {
  kind: 'text' | 'filter';
  /** Where the token sits in the text, so a chip can remove exactly it. */
  start: number; end: number;
  key: FilterKey | null; value: string; negated: boolean;
}
export type QueryProblem = { kind: 'unknown-filter'; key: string } | { kind: 'no-handle' }
  | { kind: 'bad-value'; key: FilterKey; value: string } | { kind: 'no-negation'; key: FilterKey | 'text' }
  | { kind: 'contradiction'; key: 'status' | 'role' };
type DirectoryFilters = Pick<DirectoryParams, 'q' | 'email' | 'name' | 'status' | 'role' | 'verified' | 'hasTwoFactor'
  | 'createdFrom' | 'createdTo'>;
export interface ParsedQuery { filters: DirectoryFilters; tokens: QueryToken[]; problems: QueryProblem[] }

const yes = new Set(['yes', 'true', 'on', '1']);
const no = new Set(['no', 'false', 'off', '0']);
const statusAliases: Record<string, StatusValue> = { active: 'active', suspended: 'suspended', reset: 'reset',
  'reset-required': 'reset', 'password-reset-required': 'reset' };
const roleAliases: Record<string, RoleValue[]> = { owner: ['owner'], admin: ['admin'], support: ['support'],
  none: ['none'], staff: ['owner', 'admin', 'support'], operator: ['owner', 'admin', 'support'] };

function tokenize(text: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  // -key:"quoted value" | -key:value | "quoted text" | text
  const pattern = /(-)?(?:([A-Za-z0-9]+):)?(?:"([^"]*)"?|([^\s"]+))/g;
  for (const match of text.matchAll(pattern)) {
    const [raw, minus, key, quoted, bare] = match;
    if (!raw.trim()) continue;
    tokens.push({ kind: key ? 'filter' : 'text', start: match.index, end: match.index + raw.length,
      key: (key?.toLowerCase() ?? null) as FilterKey | null, value: quoted ?? bare ?? '', negated: !!minus });
  }
  return tokens;
}

/** `2026`, `2026-03` or `2026-03-14` as its first UTC instant and the next period's. */
function period(value: string): [Date, Date] | null {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), match[2] ? Number(match[2]) - 1 : null, match[3] ? Number(match[3]) : null];
  const start = new Date(Date.UTC(year, month ?? 0, day ?? 1));
  const end = new Date(Date.UTC(year + (month === null ? 1 : 0), (month ?? 0) + (month !== null && day === null ? 1 : 0),
    (day ?? 1) + (day === null ? 0 : 1)));
  // Reject dates that roll over, such as 2026-02-30.
  if (start.getUTCFullYear() !== year || (month !== null && start.getUTCMonth() !== month) || (day !== null && start.getUTCDate() !== day)) return null;
  return [start, end];
}

/** `>d`, `>=d`, `<d`, `<=d`, `d` (that whole period) or `a..b` (both inclusive). */
export function createdRange(value: string): { from?: string; to?: string } | null {
  const range = /^([^.]+)\.\.([^.]+)$/.exec(value);
  if (range) {
    const [from, to] = [period(range[1]!), period(range[2]!)];
    return from && to && from[0] < to[1] ? { from: from[0].toISOString(), to: to[1].toISOString() } : null;
  }
  const match = /^(>=|<=|>|<)?(.+)$/.exec(value)!;
  const bounds = period(match[2]!);
  if (!bounds) return null;
  const [start, end] = bounds;
  switch (match[1]) {
    case '>': return { from: end.toISOString() };
    case '>=': return { from: start.toISOString() };
    case '<': return { to: start.toISOString() };
    case '<=': return { to: end.toISOString() };
    default: return { from: start.toISOString(), to: end.toISOString() };
  }
}

function set<T extends string>(tokens: QueryToken[], all: readonly T[], parse: (value: string) => T[] | null,
  problems: QueryProblem[], key: 'status' | 'role'): T[] | undefined {
  const include = new Set<T>();
  const exclude = new Set<T>();
  for (const token of tokens) {
    const values = token.value.toLowerCase().split(',').filter(Boolean).map(parse);
    if (!values.length || values.some(value => !value)) { problems.push({ kind: 'bad-value', key, value: token.value }); continue; }
    for (const value of values.flat() as T[]) (token.negated ? exclude : include).add(value);
  }
  if (!include.size && !exclude.size) return undefined;
  const chosen = (include.size ? [...include] : [...all]).filter(value => !exclude.has(value));
  if (!chosen.length) { problems.push({ kind: 'contradiction', key }); return undefined; }
  return chosen;
}

export function parseQuery(text: string): ParsedQuery {
  const tokens = tokenize(text);
  const problems: QueryProblem[] = [];
  const filters: DirectoryFilters = {};
  const words: string[] = [];
  const byKey = (key: FilterKey) => tokens.filter(token => token.kind === 'filter' && token.key === key);
  for (const token of tokens) {
    if (token.kind === 'text') {
      if (token.negated) problems.push({ kind: 'no-negation', key: 'text' });
      else words.push(token.value);
    } else if (token.key as string === 'handle') problems.push({ kind: 'no-handle' });
    else if (!filterKeys.includes(token.key!)) problems.push({ kind: 'unknown-filter', key: token.key! });
    else if (token.negated && ['email', 'name', 'id', 'created'].includes(token.key!)) problems.push({ kind: 'no-negation', key: token.key! });
  }
  const last = (key: FilterKey) => byKey(key).filter(token => !token.negated).at(-1)?.value.trim();
  const id = last('id');
  const q = [...words, ...(id ? [id] : [])].join(' ').trim();
  if (q) filters.q = q;
  const email = last('email');
  if (email) filters.email = email.toLowerCase();
  const name = last('name');
  if (name) filters.name = name;
  const status = set(byKey('status'), Object.keys(statusValues) as StatusValue[],
    value => statusAliases[value] ? [statusAliases[value]] : null, problems, 'status');
  if (status) filters.status = status.map(value => statusValues[value]).join(',');
  const role = set(byKey('role'), roleValues, value => roleAliases[value] ?? null, problems, 'role');
  if (role) filters.role = role.join(',');
  for (const [key, field] of [['verified', 'verified'], ['2fa', 'hasTwoFactor']] as const) {
    for (const token of byKey(key)) {
      const value = token.value.toLowerCase();
      if (!yes.has(value) && !no.has(value)) { problems.push({ kind: 'bad-value', key, value: token.value }); continue; }
      filters[field] = yes.has(value) !== token.negated;
    }
  }
  for (const token of byKey('created').filter(item => !item.negated)) {
    const range = createdRange(token.value);
    if (!range) { problems.push({ kind: 'bad-value', key: 'created', value: token.value }); continue; }
    if (range.from) filters.createdFrom = range.from;
    if (range.to) filters.createdTo = range.to;
  }
  return { filters, tokens, problems };
}

/** The text without one token, tidying the whitespace it leaves behind. */
export function removeToken(text: string, token: QueryToken): string {
  return `${text.slice(0, token.start)} ${text.slice(token.end)}`.replace(/\s+/g, ' ').trim();
}

/** The text with a filter added (quoted when it holds a space). */
export function addFilter(text: string, key: FilterKey, value: string): string {
  const written = /\s/.test(value) ? `"${value}"` : value;
  return `${text.trim()} ${key}:${written}`.trim();
}

/** A filter token that is understood: it becomes a removable chip. */
export function isChip(token: QueryToken): boolean {
  return token.kind === 'filter' && token.key !== null && filterKeys.includes(token.key)
    && !(token.negated && ['email', 'name', 'id', 'created'].includes(token.key));
}
