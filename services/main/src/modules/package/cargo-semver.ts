// Cargo version and requirement semantics, following the `semver` crate used
// by Cargo 1.98.1: comparator operators, partial versions, wildcards and the
// pre-release opt-in rule. Build metadata never affects matching.

export interface CargoVersion { major: number; minor: number; patch: number;
  pre: string[]; text: string }
type Op = '=' | '>' | '>=' | '<' | '<=' | '~' | '^' | '*';
interface Comparator { op: Op; major: number; minor: number | null;
  patch: number | null; pre: string[] }
export interface CargoRequirement { text: string; comparators: Comparator[] }

export class CargoSemverSyntax extends Error {}

const NUMBER = /^(?:0|[1-9]\d{0,15})$/;
const IDENT = /^[0-9A-Za-z-]+$/;
const VERSION = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function preParts(text: string | undefined): string[] {
  if (text === undefined) return [];
  const parts = text.split('.');
  for (const part of parts) {
    if (!IDENT.test(part) || (/^\d+$/.test(part) && !NUMBER.test(part))) {
      throw new CargoSemverSyntax(`invalid pre-release ${text}`);
    }
  }
  return parts;
}

export function parseCargoVersion(text: string): CargoVersion {
  const match = VERSION.exec(text);
  if (!match || text.length > 128) throw new CargoSemverSyntax(`invalid version ${text}`);
  if (match[5] !== undefined) preParts(match[5]);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    pre: preParts(match[4]), text };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return (a.length ? -1 : 0) + (b.length ? 1 : 0);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = a[index]!;
    const right = b[index]!;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left);
    const rightNumber = /^\d+$/.test(right);
    if (leftNumber && rightNumber) return Number(left) < Number(right) ? -1 : 1;
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return Math.sign(a.length - b.length);
}

export function compareCargoVersions(a: CargoVersion, b: CargoVersion): number {
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor)
    || Math.sign(a.patch - b.patch) || comparePre(a.pre, b.pre);
}

/** Cargo's semver-compatibility bucket: one activation per bucket and source. */
export function cargoCompatibility(version: CargoVersion): string {
  return version.major > 0 ? `${version.major}` : version.minor > 0
    ? `0.${version.minor}` : `0.0.${version.patch}`;
}

function comparator(text: string): Comparator {
  const match = /^(=|>=|>|<=|<|~|\^)?\s*(.*)$/.exec(text)!;
  const explicit = match[1] as Op | undefined;
  const body = match[2]!;
  const parts = /^(\*|x|X|0|[1-9]\d{0,15})(?:\.(\*|x|X|0|[1-9]\d{0,15})(?:\.(\*|x|X|0|[1-9]\d{0,15})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$/.exec(body);
  if (!parts) throw new CargoSemverSyntax(`invalid requirement ${text}`);
  const wild = (value: string | undefined) => value === '*' || value === 'x' || value === 'X';
  const [, majorText, minorText, patchText, pre] = parts;
  if (wild(majorText)) {
    if (explicit || minorText !== undefined) throw new CargoSemverSyntax(`unsupported wildcard ${text}`);
    return { op: '*', major: 0, minor: null, patch: null, pre: [] };
  }
  const minorWild = wild(minorText);
  const patchWild = wild(patchText);
  if ((minorWild && patchText !== undefined && !patchWild) || ((minorWild || patchWild) && pre)) {
    throw new CargoSemverSyntax(`invalid wildcard ${text}`);
  }
  if ((minorWild || patchWild) && explicit && explicit !== '=') {
    throw new CargoSemverSyntax(`unsupported wildcard operator ${text}`);
  }
  const minor = minorText === undefined || minorWild ? null : Number(minorText);
  const patch = patchText === undefined || patchWild || minor === null ? null : Number(patchText);
  if (pre && patch === null) throw new CargoSemverSyntax(`invalid pre-release ${text}`);
  const op: Op = explicit ?? (minorWild || patchWild ? '=' : '^');
  return { op, major: Number(majorText), minor, patch, pre: preParts(pre) };
}

export function parseCargoRequirement(text: string): CargoRequirement {
  if (typeof text !== 'string' || text.length > 256) throw new CargoSemverSyntax('invalid requirement');
  const trimmed = text.trim();
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return { text, comparators: [] };
  const parts = trimmed.split(',').map(part => part.trim());
  if (!parts.length || parts.some(part => !part) || parts.length > 32) {
    throw new CargoSemverSyntax(`invalid requirement ${text}`);
  }
  return { text, comparators: parts.map(comparator).filter(item => item.op !== '*') };
}

function exact(c: Comparator, v: CargoVersion): boolean {
  if (v.major !== c.major) return false;
  if (c.minor !== null && v.minor !== c.minor) return false;
  if (c.patch !== null && v.patch !== c.patch) return false;
  return comparePre(v.pre, c.pre) === 0;
}
function greater(c: Comparator, v: CargoVersion): boolean {
  if (v.major !== c.major) return v.major > c.major;
  if (c.minor === null) return false;
  if (v.minor !== c.minor) return v.minor > c.minor;
  if (c.patch === null) return false;
  if (v.patch !== c.patch) return v.patch > c.patch;
  return comparePre(v.pre, c.pre) > 0;
}
function less(c: Comparator, v: CargoVersion): boolean {
  if (v.major !== c.major) return v.major < c.major;
  if (c.minor === null) return false;
  if (v.minor !== c.minor) return v.minor < c.minor;
  if (c.patch === null) return false;
  if (v.patch !== c.patch) return v.patch < c.patch;
  return comparePre(v.pre, c.pre) < 0;
}
function tilde(c: Comparator, v: CargoVersion): boolean {
  if (v.major !== c.major) return false;
  if (c.minor !== null && v.minor !== c.minor) return false;
  if (c.patch !== null && v.patch !== c.patch) return v.patch > c.patch;
  return comparePre(v.pre, c.pre) >= 0;
}
function caret(c: Comparator, v: CargoVersion): boolean {
  if (v.major !== c.major) return false;
  if (c.minor === null) return true;
  if (c.patch === null) return c.major > 0 ? v.minor >= c.minor : v.minor === c.minor;
  if (c.major > 0) {
    if (v.minor !== c.minor) return v.minor > c.minor;
    if (v.patch !== c.patch) return v.patch > c.patch;
  } else if (c.minor > 0) {
    if (v.minor !== c.minor) return false;
    if (v.patch !== c.patch) return v.patch > c.patch;
  } else if (v.minor !== c.minor || v.patch !== c.patch) return false;
  return comparePre(v.pre, c.pre) >= 0;
}
function matchesOne(c: Comparator, v: CargoVersion): boolean {
  switch (c.op) {
    case '=': case '*': return exact(c, v);
    case '>': return greater(c, v);
    case '>=': return exact(c, v) || greater(c, v);
    case '<': return less(c, v);
    case '<=': return exact(c, v) || less(c, v);
    case '~': return tilde(c, v);
    case '^': return caret(c, v);
  }
}

export function cargoRequirementMatches(requirement: CargoRequirement, version: CargoVersion): boolean {
  if (!requirement.comparators.every(item => matchesOne(item, version))) return false;
  if (!version.pre.length) return true;
  return requirement.comparators.some(item => item.major === version.major
    && item.minor === version.minor && item.patch === version.patch && item.pre.length > 0);
}
