import type { ZoneConfiguration } from '@rezics/composition';
import { ProblemError } from '../http/problem.ts';
import type { ZoneHead } from './resource-store.ts';

/** Decisions are keyed by the exact escaped RFC 6901 text the moderator named. `zoneWithheld` matches the same
 * strings, so a decision never addresses a field spelled differently from its read filter. */
const INDEX = /^(0|[1-9][0-9]*)$/;

export function pointerTokens(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

type Step = { found: true; value: unknown } | { found: false };
function step(container: unknown, token: string): Step {
  if (Array.isArray(container)) {
    if (!INDEX.test(token) || Number(token) >= container.length) return { found: false };
    return { found: true, value: container[Number(token)] };
  }
  if (container !== null && typeof container === 'object' && Object.hasOwn(container, token))
    return { found: true, value: (container as Record<string, unknown>)[token] };
  return { found: false };
}

/** The admitted revision addressed as the Zone read filters address withheld fields (`/mounts/N` is the mount column). */
function document(configuration: ZoneConfiguration, mounts: string[]): Record<string, unknown> {
  return { ...configuration, mounts };
}

function resolves(root: unknown, pointer: string): boolean {
  let node = root;
  for (const token of pointerTokens(pointer)) {
    const next = step(node, token);
    if (!next.found) return false;
    node = next.value;
  }
  return true;
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
        Object.hasOwn(b, key) &&
        sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/** Adds or releases exact decisions on the locked head. A takedown must name a field of the current revision;
 * a release must name a decision that exists. Anything else is a conflict, never a silent no-op. */
export function changeTakedown(row: ZoneHead, pointers: string[], takedown: boolean): Record<string, unknown> {
  const current = (row.withholding ?? {}) as Record<string, unknown>;
  const next = { ...current };
  const root = document(row.configuration!, row.mounts!);
  pointers.forEach((pointer, index) => {
    const decided = Object.hasOwn(current, pointer);
    if (takedown) {
      if (!resolves(root, pointer))
        throw new ProblemError('invalid_request', {
          errors: [{ pointer: `/pointers/${index}`, code: 'invalid_format' }],
        });
      if (decided) throw new ProblemError('conflict');
      next[pointer] = {};
    } else {
      if (!decided) throw new ProblemError('conflict');
      delete next[pointer];
    }
  });
  return next;
}

/** A decision on an array element stays bound to that element only while the element is unchanged. Owner
 * configuration that removes, reorders or edits such an element would move the decision, so it is refused. */
export function movesWithheldElement(row: ZoneHead, configuration: ZoneConfiguration, mounts: string[]): boolean {
  const before = document(row.configuration!, row.mounts!);
  const after = document(configuration, mounts);
  for (const pointer of Object.keys((row.withholding ?? {}) as Record<string, unknown>)) {
    let previous: unknown = before;
    let current: unknown = after;
    for (const token of pointerTokens(pointer)) {
      const old = step(previous, token);
      if (!old.found) break;
      const now = step(current, token);
      if (Array.isArray(previous) && (!now.found || !sameJson(old.value, now.value))) return true;
      previous = old.value;
      if (!now.found) break;
      current = now.value;
    }
  }
  return false;
}
