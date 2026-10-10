import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { callEnd, edenCalls, operationPattern, readWebSources } from './support/eden-calls.ts';

// A browser call to a public read sends the session cookie only when it also names an acting subject.
// Otherwise the response depends on who is signed in, shared caches cannot keep it, and Main rejects an
// authenticated read that names no Agent. The scan reads features/ and app/ the way the closed-operations
// guard does: Eden chains, then the generated exposure table. A read whose OpenAPI security is bearer-only
// keeps the cookie; that call is the credential, and it has no acting-subject parameter to pass.

const repoRoot = join(import.meta.dir, '../../..');

function bearerOnly(spec: {
  paths: Record<string, Record<string, { operationId?: string; security?: object[] }>>;
}) {
  const ids = new Set<string>();
  for (const methods of Object.values(spec.paths)) {
    for (const operation of Object.values(methods)) {
      if (!operation?.operationId || !operation.security?.length) continue;
      const optional = operation.security.some((entry) => Object.keys(entry).length === 0);
      const required = operation.security.some((entry) => 'bearerAuth' in entry);
      if (required && !optional) ids.add(operation.operationId);
    }
  }
  return ids;
}

const bearerRequired = bearerOnly(
  JSON.parse(readFileSync(join(repoRoot, 'generated/openapi/main/public.json'), 'utf8')),
);
const publicReads = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) =>
    operationExposures[id] === 'public' &&
    !bearerRequired.has(id) &&
    (id.startsWith('get') || id === 'postV1Query'),
);

interface PublicCall {
  start: number;
  source: string;
  operations: string[];
  args: string;
}

function publicCalls(text: string): PublicCall[] {
  return edenCalls(text).flatMap((call) => {
    if (call.method === null) return [];
    const operations = publicReads.filter((id) =>
      operationPattern(call.method, call.segments, false).test(id),
    );
    if (!operations.length) return [];
    return [{ start: call.start, source: call.invocation, operations, args: call.args }];
  });
}

function receiver(text: string, v1At: number): string {
  let index = v1At - 1;
  while (index >= 0 && /\s/.test(text[index]!)) index--;
  if (text[index] !== '.') return '';
  index--;
  while (index >= 0 && /\s/.test(text[index]!)) index--;
  if (text[index] !== ')') return text.slice(0, index + 1).match(/([A-Za-z_]\w*)\s*$/)?.[1] ?? '';
  let depth = 0;
  for (; index >= 0; index--) {
    if (text[index] === ')') depth++;
    else if (text[index] === '(') {
      depth--;
      if (depth === 0) break;
    }
  }
  return `${text.slice(Math.max(0, index - 80), index).match(/([A-Za-z_][\w.]*)\s*$/)?.[1] ?? ''}()`;
}

function initializer(text: string, name: string): string | null {
  const found = [
    ...text.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*browserMainApi\\(`, 'g')),
  ];
  const last = found.at(-1);
  if (!last) return null;
  const open = last.index + last[0].length - 1;
  return text.slice(open, callEnd(text, open) + 1);
}

/** Credentials are omitted, or omitted exactly when the call names no acting subject. */
function omits(args: string | null): boolean {
  if (!args) return false;
  return (
    /anonymous\s*:\s*true/.test(args) || (/anonymous\s*:/.test(args) && /actingSubject/.test(args))
  );
}

function functionBodies(text: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const header = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/g;
  for (const found of text.matchAll(header)) {
    const name = found[1]!;
    const brace = text.indexOf('{', found.index + found[0].length - 1);
    if (brace < 0) continue;
    let depth = 0;
    let end = brace;
    for (let index = brace; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}') {
        depth--;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    bodies.set(name, text.slice(brace, end + 1));
  }
  return bodies;
}

function clientArgs(text: string, call: PublicCall): string | null {
  const who = receiver(text, call.start);
  if (who === 'browserMainApi()') {
    const open = text.lastIndexOf('browserMainApi(', call.start);
    return text.slice(
      open + 'browserMainApi'.length,
      callEnd(text, open + 'browserMainApi'.length) + 1,
    );
  }
  if (/^[A-Za-z_]/.test(who) && !who.endsWith('()')) return initializer(text, who);
  return null;
}

/**
 * Typeahead has no acting-subject parameter. Main still applies the signed-in reader's mutes from
 * the cookie, so these sites keep it. A new site is a violation until it is listed here.
 */
const credentialPersonalised: readonly { file: string; operation: string; reason: string }[] = [
  {
    file: 'features/search/typeahead.tsx',
    operation: 'getV1SearchTypeahead',
    reason: 'the server personalises this read from the credential',
  },
  {
    file: 'features/post-composer/composer.tsx',
    operation: 'getV1SearchTypeahead',
    reason: 'the server personalises this read from the credential',
  },
  {
    file: 'features/work-levels-edit/work-picker.tsx',
    operation: 'getV1SearchTypeahead',
    reason: 'the server personalises this read from the credential',
  },
];

function personalised(file: string, operations: readonly string[]): boolean {
  return credentialPersonalised.some(
    (entry) =>
      entry.file === file &&
      entry.reason === 'the server personalises this read from the credential' &&
      operations.length === 1 &&
      operations[0] === entry.operation,
  );
}

/** Credentialed browser calls to public reads that do not name an acting subject. */
export function violations(files: Readonly<Record<string, string>>): string[] {
  const functions = new Map<string, string>();
  for (const text of Object.values(files)) {
    for (const [name, body] of functionBodies(text)) functions.set(name, body);
  }
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const call of publicCalls(text)) {
      if (/actingSubject/.test(call.args) || personalised(file, call.operations)) continue;
      const args = clientArgs(text, call);
      if (args === null || omits(args)) continue;
      found.push(
        `${file}: ${call.source} reaches ${call.operations.join(', ')} with the session cookie and no acting subject`,
      );
    }
    for (const created of text.matchAll(/browserMainApi\(/g)) {
      const before = text.slice(Math.max(0, created.index - 40), created.index);
      if (/function\s+$/.test(before) || /=\s*$/.test(before)) continue;
      const open = created.index + 'browserMainApi'.length;
      const end = callEnd(text, open);
      const args = text.slice(open, end + 1);
      if (omits(args) || /^\s*\??\.\s*v1/.test(text.slice(end + 1))) continue;
      let depth = 0;
      let start = created.index;
      for (let index = created.index - 1; index >= 0; index--) {
        if (text[index] === ')') depth++;
        else if (text[index] === '(') {
          if (depth === 0) {
            start = index;
            break;
          }
          depth--;
        }
      }
      const callee = text.slice(Math.max(0, start - 80), start).match(/([A-Za-z_]\w*)\s*$/)?.[1];
      if (!callee) continue;
      const callText = text.slice(start, callEnd(text, start) + 1);
      if (/actingSubject/.test(callText)) continue;
      const body = functions.get(callee);
      const read = body
        ? publicCalls(body).find((call) => !/actingSubject/.test(call.args))
        : undefined;
      if (read)
        found.push(
          `${file}: ${callee}() reaches ${read.operations.join(', ')} with the session cookie and no acting subject`,
        );
    }
  }
  return found;
}

const webSources = readWebSources();

const readers = `
  export async function readConceptWorks(main) { return main.v1.query.post(query); }
  export async function readDiscovery(main, query) { return main.v1.works.get({ query }); }
  export async function readQueryDiscovery(main, state, page) { return main.v1.query.post(query); }
`;

test('the exposure table has public reads the scan can name', () => {
  expect(publicReads).toContain('getV1Works');
  expect(publicReads).toContain('postV1Query');
  expect(publicReads).toContain('getV1SearchTypeahead');
  expect(bearerRequired.has('getV1AgentsByIdListing')).toBe(true);
  expect(publicReads).not.toContain('getV1AgentsByIdListing');
});

test('a credentialed public read is rejected, and an anonymous or acting-subject read is not', () => {
  expect(
    violations({
      'features/old.tsx': `${readers}
      const works = () => readConceptWorks(browserMainApi(), state, locale, cursor);
      const shelf = query => readDiscovery(browserMainApi(), query);
      const filtered = page => readQueryDiscovery(browserMainApi(), state, page);
      void browserMainApi().v1.realms({ realm }).threads.get({ query: { sort: 'new', limit: 1 } });
      void browserMainApi().v1.realms.get({ query: { limit: 20 } });
      void browserMainApi().v1.search.typeahead.get({ query: { prefix } });
      void browserMainApi().v1.agents({ id }).listing.get();
      void browserMainApi().v1.realms({ realm }).get({ query: { actingSubject } });
      const mine = query => readDiscovery(browserMainApi(undefined, { anonymous: !query.actingSubject }), query);
      const publicList = () => readConceptWorks(browserMainApi(undefined, { anonymous: true }), state, locale, cursor);`,
    }),
  ).toEqual([
    'features/old.tsx: .v1.realms({realm}).threads.get( reaches getV1RealmsByRealmThreads with the session cookie and no acting subject',
    'features/old.tsx: .v1.realms.get( reaches getV1Realms with the session cookie and no acting subject',
    'features/old.tsx: .v1.search.typeahead.get( reaches getV1SearchTypeahead with the session cookie and no acting subject',
    'features/old.tsx: readConceptWorks() reaches postV1Query with the session cookie and no acting subject',
    'features/old.tsx: readDiscovery() reaches getV1Works with the session cookie and no acting subject',
    'features/old.tsx: readQueryDiscovery() reaches postV1Query with the session cookie and no acting subject',
  ]);
});

test('browser public reads omit the session cookie unless they name an acting subject', () => {
  expect(violations(webSources)).toEqual([]);
});

test('typeahead keeps the cookie only at the sites the server personalises from it', () => {
  expect(credentialPersonalised.map((entry) => entry.reason)).toEqual([
    'the server personalises this read from the credential',
    'the server personalises this read from the credential',
    'the server personalises this read from the credential',
  ]);
  expect(credentialPersonalised.map((entry) => entry.file)).toEqual([
    'features/search/typeahead.tsx',
    'features/post-composer/composer.tsx',
    'features/work-levels-edit/work-picker.tsx',
  ]);
});
