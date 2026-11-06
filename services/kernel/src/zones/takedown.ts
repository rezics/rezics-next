import type { ZoneConfiguration } from '@rezics/composition';
import type { Json } from 'reylo';
import { jsonParameter } from '../database/json.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { ZoneHead } from './resource-head.ts';

/**
 * Takedown state lives in `zones.zone.withholding`. Keys that are pointers (`''` or starting with `/`) are live
 * decisions, the only keys the read filters match. The `custody` key is not a pointer, so no read filter matches it:
 * its entries are restricted originals with their version and exact locator, and no read API returns them.
 */
export type Segment = { key: string } | { id: string } | { index: number };
export type Decision = { version: string; chain: Segment[] };
export type Retained = { pointer: string; version: string; chain: Segment[]; original: unknown };
export type Withholding = { decisions: Record<string, Partial<Decision>>; custody: Retained[] };

const CUSTODY = 'custody';
const INDEX = /^(0|[1-9][0-9]*)$/;

export function pointerTokens(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function escapeToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type Step = { found: true; value: unknown } | { found: false };
function step(container: unknown, token: string): Step {
  if (Array.isArray(container)) {
    if (!INDEX.test(token) || Number(token) >= container.length) return { found: false };
    return { found: true, value: container[Number(token)] };
  }
  if (isRecord(container) && Object.hasOwn(container, token)) return { found: true, value: container[token] };
  return { found: false };
}

function valueAt(root: unknown, pointer: string): Step {
  let node: unknown = root;
  for (const token of pointerTokens(pointer)) {
    const next = step(node, token);
    if (!next.found) return next;
    node = next.value;
  }
  return { found: true, value: node };
}

/** The admitted revision addressed as the Zone read filters address withheld fields (`/mounts/N` is the mount column). */
function document(configuration: ZoneConfiguration, mounts: string[]): Record<string, unknown> {
  return { ...configuration, mounts };
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Stable identity of an array element: a page route, a composition node id, or the string value itself. */
function identityOf(element: unknown): string | undefined {
  if (typeof element === 'string') return `value:${element}`;
  if (!isRecord(element)) return undefined;
  if (typeof element.route === 'string') return `route:${element.route}`;
  const props = element.props;
  if (isRecord(props) && typeof props.id === 'string') return `node:${props.id}`;
  return undefined;
}

/** The identity chain of a pointer in the admitted revision, or null when nothing resolves there. */
export function chainOf(root: unknown, pointer: string): Segment[] | null {
  const chain: Segment[] = [];
  let node = root;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(node)) {
      if (!INDEX.test(token) || Number(token) >= node.length) return null;
      const index = Number(token);
      const id = identityOf(node[index]);
      chain.push(id === undefined ? { index } : { id });
      node = node[index];
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      chain.push({ key: token });
      node = node[token];
    } else return null;
  }
  return chain;
}

/** Resolves a chain in another revision. Ambiguous or missing identities resolve to null, never to a guess. */
export function resolveChain(root: unknown, chain: Segment[]): string | null {
  let node = root;
  let pointer = '';
  for (const segment of chain) {
    if ('key' in segment) {
      if (!isRecord(node) || !Object.hasOwn(node, segment.key)) return null;
      pointer += `/${escapeToken(segment.key)}`;
      node = node[segment.key];
    } else if ('id' in segment) {
      if (!Array.isArray(node)) return null;
      const matches = node.flatMap((element, index) => (identityOf(element) === segment.id ? [index] : []));
      if (matches.length !== 1) return null;
      pointer += `/${matches[0]}`;
      node = node[matches[0]!];
    } else {
      if (!Array.isArray(node) || segment.index >= node.length || identityOf(node[segment.index]) !== undefined)
        return null;
      pointer += `/${segment.index}`;
      node = node[segment.index];
    }
  }
  return pointer;
}

export function withholdingOf(value: unknown): Withholding {
  const json = isRecord(value) ? value : {};
  const decisions: Record<string, Partial<Decision>> = {};
  for (const [key, decision] of Object.entries(json))
    if (key === '' || key.startsWith('/')) decisions[key] = decision as Partial<Decision>;
  const custody = Array.isArray(json[CUSTODY]) ? (json[CUSTODY] as Retained[]) : [];
  return { decisions, custody };
}

export function withholdingJson(next: Withholding): Json {
  return jsonParameter({ ...next.decisions, ...(next.custody.length > 0 ? { [CUSTODY]: next.custody } : {}) });
}

/** Whether a live takedown decision exists. Configuration then reads only for the Zone owner. */
export function hasWithholding(row: ZoneHead): boolean {
  return Object.keys(withholdingOf(row.withholding).decisions).length > 0;
}

/** Adds or releases exact decisions on the locked head. A takedown must name a field of the current revision; a
 * release must name a live decision. Anything else is a conflict, never a silent no-op. Custody is untouched. */
export function changeTakedown(row: ZoneHead, pointers: string[], takedown: boolean, version: string): Withholding {
  const before = withholdingOf(row.withholding);
  const decisions = { ...before.decisions };
  const root = document(row.configuration!, row.mounts!);
  pointers.forEach((pointer, index) => {
    const decided = Object.hasOwn(decisions, pointer);
    if (takedown) {
      const chain = chainOf(root, pointer);
      if (chain === null)
        throw new ProblemError('invalid_request', {
          errors: [{ pointer: `/pointers/${index}`, code: 'invalid_format' }],
        });
      if (decided) throw new ProblemError('conflict');
      decisions[pointer] = { version, chain };
    } else {
      if (!decided) throw new ProblemError('conflict');
      delete decisions[pointer];
    }
  });
  return { decisions, custody: before.custody };
}

/** Rebinds every live decision to its element in the edited configuration, in the same transaction. A decision
 * whose element moved follows it. An element that was removed, or whose covered value changed, leaves its superseded
 * original in custody with the revision and pointer it was live at. Nothing is guessed: an unresolved chain is removed
 * from the live decisions and retained, so a later element never inherits it. */
export function rebindWithholding(
  row: ZoneHead,
  configured: ZoneConfiguration,
  mounts: string[],
  version: string,
): Withholding {
  const before = withholdingOf(row.withholding);
  const oldRoot = document(row.configuration!, row.mounts!);
  const newRoot = document(configured, mounts);
  const decisions: Record<string, Partial<Decision>> = {};
  const custody = [...before.custody];
  for (const [pointer, decision] of Object.entries(before.decisions)) {
    const chain = decision.chain ?? chainOf(oldRoot, pointer);
    const original = valueAt(oldRoot, pointer);
    if (!chain || !original.found) continue;
    const target = resolveChain(newRoot, chain);
    if (target === null) {
      custody.push({ pointer, version: row.revision, chain, original: original.value });
      continue;
    }
    const current = valueAt(newRoot, target);
    if (!current.found || !sameJson(original.value, current.value))
      custody.push({ pointer, version: row.revision, chain, original: original.value });
    if (Object.hasOwn(decisions, target)) throw new ProblemError('conflict');
    decisions[target] = { version, chain };
  }
  return { decisions, custody };
}
