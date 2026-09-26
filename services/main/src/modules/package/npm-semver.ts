// Bounded node-semver subset used by npm 11.19.1's manifest picker: versions, x-ranges,
// tilde/caret/hyphen desugaring, `||` sets and the prerelease tuple rule.
export type NpmSemver = { major: number; minor: number; patch: number; prerelease: (string | number)[] };
type Operator = '<' | '<=' | '>' | '>=' | '=';
interface Comparator { operator: Operator; version: NpmSemver }
export type NpmRange = Comparator[][];
const NUMBER = '0|[1-9]\\d*';
const IDENTIFIER = `(?:${NUMBER}|\\d*[a-zA-Z-][a-zA-Z0-9-]*)`;
const VERSION = new RegExp(`^[=v]*(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})`
  + `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
const PART = '(?:0|[1-9]\\d*|[xX*])';
const PARTIAL = new RegExp(`^[=v]*(${PART})(?:\\.(${PART})(?:\\.(${PART})`
  + `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?)?)?$`);
const MAX_RANGE = 256;
const MAX_COMPARATORS = 32;
const SAFE = Number.MAX_SAFE_INTEGER;

function number(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > SAFE) throw new Error('version number out of range');
  return parsed;
}
function identifiers(value: string | undefined): (string | number)[] {
  return value ? value.split('.').map(part => /^\d+$/.test(part) ? number(part) : part) : [];
}
export function parseNpmVersion(value: string): NpmSemver | null {
  if (typeof value !== 'string' || value.length > MAX_RANGE) return null;
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  try {
    return { major: number(match[1]!), minor: number(match[2]!), patch: number(match[3]!),
      prerelease: identifiers(match[4]) };
  } catch { return null; }
}
export function formatNpmVersion(version: NpmSemver): string {
  return `${version.major}.${version.minor}.${version.patch}${
    version.prerelease.length ? `-${version.prerelease.join('.')}` : ''}`;
}
export function compareNpmVersions(left: NpmSemver, right: NpmSemver): number {
  const main = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (main) return Math.sign(main);
  if (!left.prerelease.length || !right.prerelease.length) {
    return Math.sign(right.prerelease.length - left.prerelease.length);
  }
  for (let index = 0; ; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
}
const version = (major: number, minor: number, patch: number, prerelease: (string | number)[] = []):
  NpmSemver => ({ major, minor, patch, prerelease });
const wild = (part: string | undefined) => part === undefined || /^[xX*]$/.test(part);
function comparator(operator: Operator, value: NpmSemver): Comparator { return { operator, version: value } }

function primitive(token: string): Comparator[] {
  const match = /^(~>?|\^|<=|>=|<|>|=)?(.*)$/.exec(token)!;
  const operator = match[1] ?? '';
  const partial = PARTIAL.exec(match[2]!);
  if (!partial) throw new Error('invalid comparator');
  const [, rawMajor, rawMinor, rawPatch, pre] = partial;
  const prerelease = identifiers(pre);
  if (wild(rawMajor)) {
    return operator === '<' || operator === '>' ? [comparator('<', version(0, 0, 0, [0]))] : [];
  }
  const major = number(rawMajor!);
  const minor = wild(rawMinor) ? null : number(rawMinor!);
  const patch = minor === null || wild(rawPatch) ? null : number(rawPatch!);
  const lower = version(major, minor ?? 0, patch ?? 0, patch === null ? [] : prerelease);
  if (operator === '~' || operator === '~>') {
    return [comparator('>=', lower), comparator('<', minor === null
      ? version(major + 1, 0, 0, [0]) : version(major, minor + 1, 0, [0]))];
  }
  if (operator === '^') {
    const upper = major > 0 || minor === null ? version(major + 1, 0, 0, [0])
      : minor > 0 || patch === null ? version(0, minor + 1, 0, [0]) : version(0, 0, patch + 1, [0]);
    return [comparator('>=', lower), comparator('<', upper)];
  }
  if (patch !== null) return [comparator((operator || '=') as Operator, lower)];
  const next = minor === null ? version(major + 1, 0, 0, [0]) : version(major, minor + 1, 0, [0]);
  if (operator === '>') return [comparator('>=', minor === null ? version(major + 1, 0, 0) : version(major, minor + 1, 0))];
  if (operator === '>=') return [comparator('>=', lower)];
  if (operator === '<') return [comparator('<', version(major, minor ?? 0, 0, [0]))];
  if (operator === '<=') return [comparator('<', next)];
  return [comparator('>=', lower), comparator('<', next)];
}
function hyphen(from: string, to: string): Comparator[] {
  const low = PARTIAL.exec(from);
  const high = PARTIAL.exec(to);
  if (!low || !high) throw new Error('invalid hyphen range');
  const lower = wild(low[1]) ? [] : [comparator('>=', version(number(low[1]!), wild(low[2]) ? 0 : number(low[2]!),
    wild(low[2]) || wild(low[3]) ? 0 : number(low[3]!), wild(low[2]) || wild(low[3]) ? [] : identifiers(low[4])))];
  if (wild(high[1])) return lower;
  const major = number(high[1]!);
  if (wild(high[2])) return [...lower, comparator('<', version(major + 1, 0, 0, [0]))];
  const minor = number(high[2]!);
  if (wild(high[3])) return [...lower, comparator('<', version(major, minor + 1, 0, [0]))];
  return [...lower, comparator('<=', version(major, minor, number(high[3]!), identifiers(high[4])))];
}
/** Returns null for a string that node-semver would not accept as a range. */
export function parseNpmRange(value: string): NpmRange | null {
  if (typeof value !== 'string' || value.length > MAX_RANGE) return null;
  try {
    let comparators = 0;
    const sets = value.split('||').map(raw => {
      const text = raw.trim().replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, '$1');
      const range = /^(\S+)\s+-\s+(\S+)$/.exec(text);
      const set = range ? hyphen(range[1]!, range[2]!)
        : text === '' ? [] : text.split(/\s+/).flatMap(primitive);
      comparators += set.length;
      if (comparators > MAX_COMPARATORS) throw new Error('range comparator budget');
      return set;
    });
    return sets;
  } catch { return null; }
}
function test(item: Comparator, value: NpmSemver): boolean {
  const order = compareNpmVersions(value, item.version);
  return item.operator === '<' ? order < 0 : item.operator === '<=' ? order <= 0
    : item.operator === '>' ? order > 0 : item.operator === '>=' ? order >= 0 : order === 0;
}
export function npmSatisfies(value: NpmSemver, range: NpmRange, includePrerelease = false): boolean {
  return range.some(set => {
    if (!set.every(item => test(item, value))) return false;
    if (!value.prerelease.length || includePrerelease) return true;
    return set.some(item => item.version.prerelease.length > 0 && item.version.major === value.major
      && item.version.minor === value.minor && item.version.patch === value.patch);
  });
}
export function npmSatisfiesText(value: string, range: string, includePrerelease = false): boolean {
  const parsed = parseNpmVersion(value);
  const parsedRange = parseNpmRange(range);
  return !!parsed && !!parsedRange && npmSatisfies(parsed, parsedRange, includePrerelease);
}
