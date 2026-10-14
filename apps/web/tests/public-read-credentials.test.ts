import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  operationExposures,
  type PlatformOperationId,
} from '../../../generated/openapi/main/exposure.ts';
import { callEnd, edenCalls, operationPattern, readWebSources } from './support/eden-calls.ts';

// Every browser call to a Main read is one of three classes, taken from the route:
// `anonymous` ignores the bearer, `credential` personalises from it and takes no subject,
// `acting-subject` names the reader. An unlisted operation fails. Anonymous reads require
// the route's explicit public branch; authenticated acting-subject reads must name the reader.

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
const mainReads = (Object.keys(operationExposures) as PlatformOperationId[]).filter(
  (id) =>
    operationExposures[id] === 'public' && (id.startsWith('get') || id === 'postV1Query'),
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
    const operations = mainReads.filter((id) =>
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

type ReadClass = 'anonymous' | 'credential' | 'acting-subject';
interface ReadRule {
  kind: ReadClass;
  /** A public branch accepts no bearer and no acting subject. */
  anonymous?: boolean;
  /** Some operations use authority only for particular named scopes. */
  scopes?: Readonly<Record<string, ReadClass>>;
}

/** Route evidence for every Main read a browser call can reach. An id missing here fails the scan. */
const readClasses: Readonly<Record<string, ReadRule & { evidence: string }>> = {
  getV1Zones: {
    kind: 'anonymous',
    evidence: 'services/main/src/routes/zones.ts:334 lists official Zones without reading the request or bearer',
  },
  getV1RealmsByRealmZone: {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/routes/realm-reads.ts:110 workRead accepts a public visitor or the named member',
  },
  getV1ZonesById: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/zones.ts:646 requires actingSubject and zonePage verifies the viewer',
  },
  'getV1ZonesByIdShowcase-editor': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/zones.ts:409 requires actingSubject and requireZoneEditor verifies zone.edit',
  },
  getV1Facets: {
    kind: 'anonymous',
    evidence: 'services/main/src/routes/facets.ts:7 drops the bearer; one body per deploy',
  },
  getV1Realms: {
    kind: 'anonymous',
    evidence: 'services/main/src/routes/realm-directory.ts:68 publicRequest strips the bearer',
  },
  getV1SearchTypeahead: {
    kind: 'credential',
    evidence: 'services/main/src/routes/search.ts:190 applies mutes from the bearer and takes no subject',
  },
  getV1Works: {
    kind: 'credential',
    evidence: 'services/main/src/routes/discovery.ts:54 publicWorkRead discloses from the bearer',
  },
  postV1Query: {
    kind: 'credential',
    evidence: 'services/main/src/routes/query.ts:118 publicWorkRead discloses from the bearer',
  },
  getV1RealmsByRealmThreads: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/realm-reply-threads.ts:53 workRead; a private Realm needs the member',
  },
  getV1RealmsByRealmDecisions: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/realm-reads.ts:98 workRead; a private Realm needs the member',
  },
  getV1RealmsByRealmThreadsByReply: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/realm-reply-threads.ts:62 workRead names the member on a thread page',
  },
  getV1DiscoveryConcepts: {
    kind: 'credential',
    evidence: 'services/main/src/routes/discovery.ts:31 publicWorkRead discloses from the bearer',
  },
  getV1DiscoverySections: {
    kind: 'credential',
    evidence: 'services/main/src/routes/discovery.ts:36 publicWorkRead discloses from the bearer',
  },
  'getV1Rating-populations': {
    kind: 'credential',
    evidence: 'services/main/src/routes/rating-populations.ts:22 publicWorkRead discloses from the bearer',
  },
  getV1AddressesResolve: {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/routes/addresses.ts:216 resolves as query.actingSubject when the bearer is present',
  },
  getV1AddressesAvailability: {
    kind: 'acting-subject',
    scopes: { agent: 'anonymous', space: 'anonymous', work: 'anonymous' },
    evidence: 'services/main/src/modules/address/write.ts:157 ignores authority outside the Zone scope; Zone requires its editor',
  },
  getV1OnboardingChoices: {
    kind: 'anonymous',
    evidence: 'services/main/src/routes/onboarding-interests.ts:27 drops request headers before workRead',
  },
  'getV1AgentsByIdLibrary-visibility': {
    kind: 'credential',
    evidence: 'services/main/src/routes/profiles.ts:119 verifies the owner bearer and takes no acting subject',
  },
  getV1ZonesByIdPresentation: {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/modules/zone/route.ts:68 reads the public publication without a subject; verifies the subject when present',
  },
  getV1ZonesByIdRoutes: {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/modules/zone/route.ts:68 reads public routes without a subject; verifies the subject when present',
  },
  'getV1Content-revisionsByRevision': {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/routes/content.ts:427 permits public published revisions; unpublished revisions require an acting subject',
  },
  'getV1MePerson-preferences': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/preferences.ts:46 requires actingSubject with the bearer',
  },
  'getV1MeManaged-realms': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/managed-realms.ts:52 requires actingSubject with the bearer',
  },
  'getV1MeFeed-preferences': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/feed.ts:108 reads preferences for query.actingSubject',
  },
  getV1MeFollows: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/follows.ts:70 verifies the bearer and reads query.actingSubject',
  },
  getV1RealmsByRealmModeration: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/management-reads.ts:92 moderation queue is read as the member',
  },
  getV1RealmsByRealmModerationByCaseId: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/management-reads.ts:55 a case is read as the member',
  },
  getV1RealmsByRealmAudit: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/management-reads.ts:118 the audit log is read as the member',
  },
  getV1RealmsByRealmJoining: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/managed-realms.ts:79 join policy is read as the member',
  },
  getV1RealmsByRealm: {
    kind: 'acting-subject',
    anonymous: true,
    evidence: 'services/main/src/routes/realm-reads.ts:77 workRead takes the optional member on the header',
  },
  'getV1RealmsByRealmZone-attachments': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/zones.ts:692 lists attachments as query.actingSubject',
  },
  getV1ZonesByIdConfiguration: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/zones.ts:572 requires the zone editor as actingSubject',
  },
  getV1AgentsById: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/profiles.ts:86 workRead; a token must name the acting Agent',
  },
  getV1ContributionsByContributionDraftsByRevision: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/contributions.ts:148 the draft is read as actingSubject',
  },
  getV1EditorialProposals: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/editorial-proposals.ts:174 lists proposals for the bearer and actingSubject',
  },
  getV1EditorialProposalsByProposal: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/editorial-proposals.ts:165 reads one proposal for the bearer and actingSubject',
  },
  getV1WorksById: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/work-reads.ts:62 workRead discloses from the bearer and the subject',
  },
  getV1WorksByIdMetadata: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/work-metadata.ts:93 the header head is read as actingSubject',
  },
  getV1WorksByIdRealizations: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/realizations.ts:60 the edition list is read as actingSubject',
  },
  getV1PostsByIdIdentifications: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/post-identification.ts:62 workRead names the reader on the links',
  },
  'getV1Reading-positionsByWork': {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/reading-positions.ts:56 workRead seeks as the reader',
  },
  getV1ReaderSettings: {
    kind: 'acting-subject',
    evidence: 'services/main/src/routes/reading-settings.ts:45 requires actingSubject with the bearer',
  },
};

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

function anonymousTrue(args: string | null): boolean {
  return !!args && /anonymous\s*:\s*true\b/.test(args);
}

/** Any `anonymous:` option can drop the bearer. Credential routes have no subject to gate that on. */
function anonymousOption(args: string | null): boolean {
  return !!args && /anonymous\s*:/.test(args);
}

function judge(
  file: string,
  label: string,
  operations: readonly string[],
  client: string | null,
  apiArgs: string,
  classes: Readonly<Record<string, ReadRule>>,
  reader?: Reader,
  invocation?: string,
): string[] {
  const subject =
    subjectPassed(apiArgs, client) ||
    (!!reader &&
      !!invocation &&
      !!client &&
      subjectForwarded(reader, invocation, client, apiArgs));
  const found: string[] = [];
  for (const operation of operations) {
    const entry = classes[operation];
    if (!entry) {
      found.push(`${file}: ${label} reaches ${operation}, which has no read class`);
      continue;
    }
    const scope = /\bscope\s*:\s*(['"])([^'"]+)\1/.exec(apiArgs)?.[2];
    const kind = (scope ? entry.scopes?.[scope] : undefined) ?? entry.kind;
    if (kind === 'anonymous') {
      if (!anonymousTrue(client))
        found.push(
          `${file}: ${label} reaches ${operation} with the session cookie; the route ignores the bearer`,
        );
    } else if (entry.anonymous && anonymousTrue(client) && !subject) {
      // Explicit public reads cannot accidentally carry a session or an actor.
      continue;
    } else if (
      anonymousTrue(client) ||
      (kind === 'credential' && anonymousOption(client))
    ) {
      found.push(`${file}: ${label} reaches ${operation} anonymously; the route reads the bearer`);
    } else if (kind === 'acting-subject' && !subject) {
      found.push(`${file}: ${label} reaches ${operation} with no acting subject`);
    }
  }
  return found;
}

/** Browser calls to Main reads that disagree with their route class. */
export function violations(
  files: Readonly<Record<string, string>>,
  classes: Readonly<Record<string, ReadRule>> = readClasses,
): string[] {
  const functions = new Map<string, Reader>();
  for (const text of Object.values(files)) {
    for (const [name, reader] of functionBodies(text)) functions.set(name, reader);
  }
  const found: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    for (const call of publicCalls(text)) {
      const args = clientArgs(text, call);
      if (args === null) continue;
      found.push(...judge(file, call.source, call.operations, args, call.args, classes));
    }
    for (const created of text.matchAll(/browserMainApi\(/g)) {
      const before = text.slice(Math.max(0, created.index - 40), created.index);
      // A default `= () => browserMainApi(...)` is the helper's own client, not a call into it.
      if (/function\s+$/.test(before) || /=\s*$/.test(before) || /=>\s*$/.test(before)) continue;
      const open = created.index + 'browserMainApi'.length;
      const end = callEnd(text, open);
      const args = text.slice(open, end + 1);
      if (/^\s*\??\.\s*v1/.test(text.slice(end + 1))) continue;
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
      if (!reader) continue;
      for (const call of publicCalls(reader.body)) {
        found.push(
          ...judge(file, `${callee}()`, call.operations, args, call.args, classes, reader, callText),
        );
      }
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

test('a browser read must match its route class', () => {
  expect(
    violations({
      'features/old.tsx': `${readers}
      void browserMainApi().v1.realms({ realm }).threads.get({ query: { sort: 'new', limit: 1 } });
      void browserMainApi().v1.realms.get({ query: { limit: 20 } });
      void browserMainApi().v1.search.typeahead.get({ query: { prefix } });
      void browserMainApi().v1.facets.get();
      const works = () => readConceptWorks(browserMainApi(), state, locale, cursor);
      const shelf = query => readDiscovery(browserMainApi(), query);
      const mine = query => readDiscovery(browserMainApi(undefined, { anonymous: !query.actingSubject }), query);
      const publicList = () => readConceptWorks(browserMainApi(undefined, { anonymous: true }), state, locale, cursor);
      const topic = () => readConceptFeed(browserMainApi(undefined, { anonymous: !actingSubject }), conceptId, locale, cursor);
      void browserMainApi().v1.realms({ realm }).threads.get({ query: { actingSubject } });`,
    }),
  ).toEqual([
    'features/old.tsx: .v1.realms({realm}).threads.get( reaches getV1RealmsByRealmThreads with no acting subject',
    'features/old.tsx: .v1.realms.get( reaches getV1Realms with the session cookie; the route ignores the bearer',
    'features/old.tsx: .v1.facets.get( reaches getV1Facets with the session cookie; the route ignores the bearer',
    'features/old.tsx: readDiscovery() reaches getV1Works anonymously; the route reads the bearer',
    'features/old.tsx: readConceptWorks() reaches postV1Query anonymously; the route reads the bearer',
    'features/old.tsx: readConceptFeed() reaches postV1Query anonymously; the route reads the bearer',
  ]);
});

test('an unlisted Main read fails', () => {
  expect(
    violations(
      { 'features/new.tsx': 'void browserMainApi().v1.works.get({ query });' },
      {},
    ),
  ).toEqual(['features/new.tsx: .v1.works.get( reaches getV1Works, which has no read class']);
});

test('optional public branches accept anonymous reads only without an acting subject', () => {
  for (const route of ['realms({ realm })', 'realms({ realm }).zone', 'addresses.resolve', 'zones({ id }).presentation',
    'zones({ id }).routes', "['content-revisions']({ revision })"]) {
    const client = 'browserMainApi(undefined, { anonymous: true })';
    const endpoint = route.startsWith('[') ? route : `.${route}`;
    expect(violations({ fixture: `void ${client}.v1${endpoint}.get({ query: {} });` })).toEqual([]);
    expect(violations({ fixture: `void ${client}.v1${endpoint}.get({ query: { actingSubject } });` }))
      .toHaveLength(1);
    expect(violations({ fixture: `void browserMainApi().v1${endpoint}.get({ query: {} });` }))
      .toHaveLength(1);
    expect(violations({ fixture: `void browserMainApi().v1${endpoint}.get({ query: { actingSubject } });` }))
      .toEqual([]);
  }
});

test('Zone directory reads omit credentials and editor reads name their authenticated subject', () => {
  expect(violations({ fixture: `
    void browserMainApi(undefined, { anonymous: true }).v1.zones.get({ query: { official: 'true' } });
    void browserMainApi().v1.zones({ id }).get({ query: { actingSubject } });
    void browserMainApi().v1.zones({ id })['showcase-editor'].get({ query: { actingSubject } });
  ` })).toEqual([]);
  expect(violations({ fixture: `
    void browserMainApi().v1.zones.get({ query: { official: 'true' } });
    void browserMainApi().v1.zones({ id }).get();
    void browserMainApi(undefined, { anonymous: true }).v1.zones({ id })['showcase-editor'].get({ query: { actingSubject } });
  ` })).toHaveLength(3);
});

test('address availability uses its public scope while Zone availability requires the editor', () => {
  const call = (client: string, scope: string, actor = '') => ({ fixture:
    `void ${client}.v1.addresses.availability.get({ query: { scope: '${scope}', alias: handle ${actor} } });` });
  const anonymous = 'browserMainApi(undefined, { anonymous: true })';
  expect(violations(call(anonymous, 'agent'))).toEqual([]);
  expect(violations(call('browserMainApi()', 'agent'))).toHaveLength(1);
  expect(violations(call(anonymous, 'zone:urn:zone'))).toHaveLength(1);
  expect(violations(call('browserMainApi()', 'zone:urn:zone', ', actingSubject'))).toEqual([]);
});

test('browser Main reads match the route class', () => {
  expect(violations(webSources)).toEqual([]);
});

test('each class names the route that decides it', () => {
  const kinds = new Set(Object.values(readClasses).map((entry) => entry.kind));
  expect(kinds).toEqual(new Set(['anonymous', 'credential', 'acting-subject']));
  expect(Object.values(readClasses).every((entry) => entry.evidence.includes('services/main/'))).toBe(
    true,
  );
});
