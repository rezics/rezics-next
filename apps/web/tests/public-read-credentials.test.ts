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

/** The client sends no cookie. Gating that on an acting subject still sends one when the subject is set. */
function omits(args: string | null): boolean {
  return !!args && /anonymous\s*:\s*true\b/.test(args);
}

interface Reader {
  params: string[];
  body: string;
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '{' || char === '[' || char === '<') depth++;
    else if (char === ')' || char === '}' || char === ']' || char === '>') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function functionBodies(text: string): Map<string, Reader> {
  const bodies = new Map<string, Reader>();
  const header = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/g;
  for (const found of text.matchAll(header)) {
    const name = found[1]!;
    const open = found.index + found[0].length - 1;
    const close = callEnd(text, open);
    let depth = 0;
    let brace = -1;
    for (let index = close + 1; index < text.length; index++) {
      const char = text[index];
      if (char === '{' && depth === 0) {
        brace = index;
        break;
      }
      if (char === '(' || char === '{' || char === '[' || char === '<') depth++;
      else if (char === ')' || char === '}' || char === ']' || char === '>') depth--;
    }
    if (brace < 0) continue;
    let bodyDepth = 0;
    let end = brace;
    for (let index = brace; index < text.length; index++) {
      if (text[index] === '{') bodyDepth++;
      else if (text[index] === '}') {
        bodyDepth--;
        if (bodyDepth === 0) {
          end = index;
          break;
        }
      }
    }
    const params = splitTop(text.slice(open + 1, close))
      .map((part) => part.trim().match(/^(?:\.\.\.)?([A-Za-z_]\w*)/)?.[1] ?? '')
      .filter((part) => part.length > 0);
    bodies.set(name, { params, body: text.slice(brace, end + 1) });
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
 * These reads have no acting-subject parameter, and Main still changes the result from the cookie.
 * A new site is a violation until it is listed here.
 */
const credentialPersonalised: readonly {
  file: string;
  operation: string;
  callee?: string;
  reason: string;
}[] = [
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
  {
    file: 'features/home/tabs.tsx',
    operation: 'postV1Query',
    callee: 'readConceptFeed',
    reason: 'the server personalises this read from the credential',
  },
];

const personalisation = 'the server personalises this read from the credential';

function personalised(file: string, operations: readonly string[], callee?: string): boolean {
  return credentialPersonalised.some(
    (entry) =>
      entry.file === file &&
      entry.reason === personalisation &&
      operations.length === 1 &&
      operations[0] === entry.operation &&
      entry.callee === callee,
  );
}

/** The Eden arguments name an acting subject, or they send the value whose subject gates the cookie. */
function subjectPassed(apiArgs: string, clientArgs: string | null): boolean {
  if (/actingSubject/.test(apiArgs)) return true;
  const binding = /anonymous\s*:\s*!\s*([A-Za-z_][\w.]*)\.actingSubject/
    .exec(clientArgs ?? '')?.[1]
    ?.split('.')
    .pop();
  return !!binding && new RegExp(`\\b${binding}\\b`).test(apiArgs);
}

/** The caller's subject reaches the helper's request: as that parameter, or copied onto the body. */
function subjectForwarded(
  reader: Reader,
  invocation: string,
  clientArgs: string,
  apiArgs: string,
): boolean {
  const args = splitTop(invocation.slice(1, -1));
  const clientAt = args.findIndex((arg) => arg.includes('browserMainApi('));
  const binding = /anonymous\s*:\s*!\s*([A-Za-z_][\w.]*)\.actingSubject/
    .exec(clientArgs)?.[1]
    ?.split('.')
    .pop();
  const passed = args.flatMap((arg, index) => {
    if (index === clientAt) return [];
    const param = reader.params[index];
    if (!param) return [];
    const namesSubject = binding
      ? new RegExp(`^${binding}$`).test(arg.trim()) ||
        new RegExp(`\\b${binding}\\.actingSubject\\b`).test(arg)
      : /\bactingSubject\b/.test(arg);
    return namesSubject ? [param] : [];
  });
  return passed.some((param) => {
    if (new RegExp(`\\b${param}\\b`).test(apiArgs)) return true;
    if (new RegExp(`\\b${param}\\.actingSubject\\b`).test(reader.body)) return true;
    const rest = new RegExp(`\\.\\.\\.([A-Za-z_]\\w*)\\s*\\}\\s*=\\s*${param}\\b`).exec(
      reader.body,
    )?.[1];
    return !!rest && new RegExp(`\\.{3}${rest}\\b`).test(apiArgs);
  });
}

/** Credentialed browser calls to public reads that do not name an acting subject. */
export function violations(files: Readonly<Record<string, string>>): string[] {
  const functions = new Map<string, Reader>();
  for (const text of Object.values(files)) {
    for (const [name, reader] of functionBodies(text)) functions.set(name, reader);
  }
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const call of publicCalls(text)) {
      if (personalised(file, call.operations)) continue;
      const args = clientArgs(text, call);
      if (args === null || omits(args) || subjectPassed(call.args, args)) continue;
      found.push(
        `${file}: ${call.source} reaches ${call.operations.join(', ')} with the session cookie and no acting subject`,
      );
    }
    for (const created of text.matchAll(/browserMainApi\(/g)) {
      const before = text.slice(Math.max(0, created.index - 40), created.index);
      // A default `= () => browserMainApi(...)` is the helper's own client, not a call into it.
      if (/function\s+$/.test(before) || /=\s*$/.test(before) || /=>\s*$/.test(before)) continue;
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
      const reader = functions.get(callee);
      const handed = splitTop(callText.slice(1, -1)).some(
        (arg) => !arg.includes('browserMainApi(') && /\bactingSubject\b/.test(arg),
      );
      const read =
        reader && !(handed && /\bactingSubject\b/.test(reader.body))
          ? publicCalls(reader.body).find(
              (call) =>
                !subjectPassed(call.args, args) &&
                !subjectForwarded(reader, callText, args, call.args),
            )
          : undefined;
      if (read && !personalised(file, read.operations, callee))
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
  export async function readConceptFeed(main, conceptId, language, cursor) { return main.v1.query.post(query); }
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
      const publicList = () => readConceptWorks(browserMainApi(undefined, { anonymous: true }), state, locale, cursor);
      const topic = () => readConceptFeed(browserMainApi(undefined, { anonymous: !actingSubject }), conceptId, locale, cursor);`,
    }),
  ).toEqual([
    'features/old.tsx: .v1.realms({realm}).threads.get( reaches getV1RealmsByRealmThreads with the session cookie and no acting subject',
    'features/old.tsx: .v1.realms.get( reaches getV1Realms with the session cookie and no acting subject',
    'features/old.tsx: .v1.search.typeahead.get( reaches getV1SearchTypeahead with the session cookie and no acting subject',
    'features/old.tsx: readConceptWorks() reaches postV1Query with the session cookie and no acting subject',
    'features/old.tsx: readDiscovery() reaches getV1Works with the session cookie and no acting subject',
    'features/old.tsx: readQueryDiscovery() reaches postV1Query with the session cookie and no acting subject',
    'features/old.tsx: readConceptFeed() reaches postV1Query with the session cookie and no acting subject',
  ]);
});

test('browser public reads omit the session cookie unless they name an acting subject', () => {
  expect(violations(webSources)).toEqual([]);
});

test('typeahead keeps the cookie only at the sites the server personalises from it', () => {
  expect(credentialPersonalised.map((entry) => entry.reason)).toEqual([
    personalisation,
    personalisation,
    personalisation,
    personalisation,
  ]);
  expect(
    credentialPersonalised.map((entry) => `${entry.file} ${entry.callee ?? entry.operation}`),
  ).toEqual([
    'features/search/typeahead.tsx getV1SearchTypeahead',
    'features/post-composer/composer.tsx getV1SearchTypeahead',
    'features/work-levels-edit/work-picker.tsx getV1SearchTypeahead',
    'features/home/tabs.tsx readConceptFeed',
  ]);
});
