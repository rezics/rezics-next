import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The closed-operations guard and the public-read credential scan both read Eden chains in
// features/ and app/. One parser keeps those scans from drifting apart.

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const WORD_PARAMETER = 'By[A-Z][a-z0-9]*';
const upper = (word: string) => word[0]!.toUpperCase() + word.slice(1);

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A route's operation ID pattern from path segments: a string is a literal segment, null an unnamed parameter. */
export function operationPattern(
  method: string | null,
  segments: readonly (string | null)[],
  prefix = false,
): RegExp {
  const path = segments
    .map((segment) =>
      segment === null
        ? WORD_PARAMETER
        : segment.startsWith('By')
          ? segment
          : escape(upper(segment)),
    )
    .join('');
  const verb = method ?? '(?:get|post|put|patch|delete)';
  // A chain that ends before a method is an alias for a client: it may reach every operation below it.
  return new RegExp(`^${verb}V1${path}${prefix ? '(?:[A-Z].*)?' : ''}$`);
}

export const chain =
  /(?<=\.)v1((?:\s*\??\.\s*[A-Za-z_]\w*|\[['"][^'"]+['"]\]|\((?:[^()]|\([^()]*\))*\))*)/g;
export const link = /\.\s*([A-Za-z_]\w*)|\[['"]([^'"]+)['"]\]|\((?:[^()]|\([^()]*\))*\)/g;

export function callEnd(text: string, openParen: number): number {
  let depth = 0;
  for (let index = openParen; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return text.length - 1;
}

export interface EdenCall {
  /** Index of `v1` in the source. */
  start: number;
  /** `.v1` plus the matched chain, whitespace collapsed, including a method's arguments. */
  chain: string;
  /** `.v1…method(` when a method is invoked; empty when the chain names no method. */
  invocation: string;
  method: string | null;
  segments: (string | null)[];
  /** Method arguments, including parentheses; empty when the chain names no method. */
  args: string;
}

/** Eden calls such as `x.v1.me['saved-filters'].get(...)`, or the same chain kept in a variable. */
export function edenCalls(text: string): EdenCall[] {
  const calls: EdenCall[] = [];
  for (const found of text.matchAll(chain)) {
    const segments: (string | null)[] = [];
    let method: string | null = null;
    let methodAt = 0;
    for (const item of found[1]!.matchAll(link)) {
      const name = item[1] ?? item[2];
      if (name === undefined) {
        const key = /^\(\s*\{\s*(\w+)/.exec(item[0])?.[1];
        segments.push(key ? `By${upper(key)}` : null);
        continue;
      }
      const at = found.index + 2 + item.index + item[0].length;
      if (item[1] && METHODS.includes(name) && text[at] === '(') {
        method = name;
        methodAt = at;
        break;
      }
      segments.push(name);
    }
    // A bare `.v1` names no route.
    if (!segments.length && method === null) continue;
    const rest = found[1]!;
    const end = methodAt === 0 ? 0 : callEnd(text, methodAt);
    calls.push({
      start: found.index,
      chain: `.v1${rest.replace(/\s+/g, '')}`,
      invocation:
        methodAt === 0
          ? ''
          : `.v1${rest.slice(0, methodAt - (found.index + 2)).replace(/\s+/g, '')}(`,
      method,
      segments,
      args: methodAt === 0 ? '' : text.slice(methodAt, end + 1),
    });
  }
  return calls;
}

const webRoot = join(import.meta.dir, '../..');
const skipped = /\.(?:test|stories|e2e)\.tsx?$|(?:fixtures?|story-fetch)\.tsx?$/;

export function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !skipped.test(name) ? [path] : [];
  });
}

/** Feature and app sources, keyed by path relative to `apps/web`. Tests and stories are omitted. */
export function readWebSources(): Record<string, string> {
  return Object.fromEntries(
    [...sources(join(webRoot, 'features')), ...sources(join(webRoot, 'app'))].map((path) => [
      relative(webRoot, path),
      readFileSync(path, 'utf8'),
    ]),
  );
}
