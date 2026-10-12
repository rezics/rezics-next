import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied } from '../src/modules/access/admission.ts';
import { checkedComponentState } from '../src/modules/semantic/change.ts';
import { SemanticChangeRejected } from '../src/modules/semantic/command.ts';
import { STAGE_PROFILE } from '../src/modules/semantic/stage-schema.ts';
import { semanticError, semanticRoutes } from '../src/routes/semantic.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { issuer: 'https://account.test', subject: 'reader' };
const property = (ref: string, predicate = 'https://schema.org/about') => ({
  predicate, value: { kind: 'resource', ref },
});
const resource = (properties: unknown[] = []) => ({
  component: 'resource', types: ['https://schema.org/Thing'], properties, lifecycle: 'active',
});
const role = (key: string, members: string[]) => ({
  key, minParticipants: 0, maxParticipants: 2, ordered: false, members,
});
const problem = (itemIndex: number, pointer: string, reference: string) => ({
  type: 'https://rezics.com/problems/unavailable_reference', title: 'Semantic change is not admitted',
  status: 422, code: 'unavailable_reference', itemIndex, pointer, reference,
});

// Compare the complete response surface, including any future rate-limit headers.
const volatileHeaders = new Set(['date', 'request-id', 'x-request-id', 'trace-id', 'x-trace-id']);
const comparableHeaders = (response: Response) => Object.fromEntries(
  [...response.headers].filter(([name]) => !volatileHeaders.has(name)),
);

class ReferenceGraph extends FusekiClient {
  override async query(query: string): Promise<SparqlResult> {
    if (query.includes('ASK')) return { boolean: true };
    if (query.includes('SELECT ?type WHERE')) return { results: { bindings: [] } };
    throw new Error(`Unexpected graph dispatch: ${query.slice(0, 120)}`);
  }
}

function fixture(available: string[] = [], hidden: string[] = []) {
  const graph = new ReferenceGraph('http://localhost:1/rezics');
  const reads: string[] = [];
  let admissions = 0;
  // Availability and visibility are independent fixture inputs. Existing private
  // resources and missing resources both fail the same Access reader decision.
  const resources = new Set([...available, ...hidden]);
  const visible = new Set(available);
  const work = {
    environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: '0' }, objectDirectory: '.temp' },
    account: { verify: async () => principal },
    access: {
      canReadSemanticResource: async (_principal: unknown, _actor: string, reference: string) => {
        reads.push(reference);
        return resources.has(reference) && visible.has(reference);
      },
      canReadWork: async () => false,
      register: async () => { admissions++; throw new AdmissionDenied('fixture admission sentinel'); },
    },
    semanticStages: {},
  } as unknown as MainWorkDependencies;
  return { app: semanticRoutes(graph, work), reads, admissions: () => admissions };
}

function request(items: unknown[], bulk = true, extra: Record<string, unknown> = {}) {
  return new Request(`http://main.test/v1/semantic/changes${bulk ? '/bulk' : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer reader',
      'idempotency-key': 'reference-diagnostic-test' },
    body: JSON.stringify({ profile: bulk ? STAGE_PROFILE : 'semantic-change-v1', actingSubject: id(1),
      ...(bulk ? { items } : { state: items[0], expectedHead: null }), ...extra }),
  });
}

test('Bulk refusal identifies the first submitted item and property, before canonical reference sorting', async () => {
  const available = id(2), first = id(90), second = id(10), laterItem = id(3);
  const state = resource([
    { predicate: 'https://schema.org/name', value: { kind: 'string', lexical: 'Caller supplied description' } },
    property(available), property(first, 'https://schema.org/mentions'), property(second),
  ]);
  const canonical = checkedComponentState(state);
  expect(canonical.component).toBe('resource');
  if (canonical.component !== 'resource') throw new Error('resource fixture expected');
  expect(canonical.properties.findIndex(item => item.value.kind === 'resource' && item.value.ref === second))
    .toBeLessThan(canonical.properties.findIndex(item => item.value.kind === 'resource' && item.value.ref === first));
  const f = fixture([available]);
  const response = await f.app.handle(request([resource(), state, resource([property(laterItem)])]));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(problem(1, '/properties/2/value/ref', first));
  expect(f.reads).toEqual([available, first]);
  expect(f.admissions()).toBe(0);
});

test('Bulk role diagnostics preserve the submitted role and member positions', async () => {
  const first = id(90), second = id(10);
  const state = { component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
    roles: [role('z-member', [first, second]), role('a-member', [id(3)])] };
  const canonical = checkedComponentState(state);
  expect(canonical.component).toBe('definition');
  if (canonical.component !== 'definition') throw new Error('definition fixture expected');
  expect(canonical.roles[0]?.key).toBe('a-member');
  expect(canonical.roles[1]?.members).toEqual([second, first]);
  const f = fixture();
  const response = await f.app.handle(request([state]));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(problem(0, '/roles/0/members/0', first));
  expect(f.reads).toEqual([first]);
  expect(f.admissions()).toBe(0);
});

for (const bulk of [true, false]) {
  test(`${bulk ? 'Bulk' : 'Single'} hidden and absent references have identical complete response headers and byte-identical diagnostic bodies`, async () => {
    const ref = id(90), state = resource([property(ref)]);
    const absent = fixture(), hidden = fixture([], [ref]);
    const absentResponse = await absent.app.handle(request([state], bulk));
    const hiddenResponse = await hidden.app.handle(request([state], bulk));
    expect(absentResponse.status).toBe(422);
    expect(hiddenResponse.status).toBe(422);
    expect(comparableHeaders(hiddenResponse)).toEqual(comparableHeaders(absentResponse));
    const absentText = await absentResponse.text(), hiddenText = await hiddenResponse.text();
    expect(hiddenText).toBe(absentText);
    // Exact keys also prevent disclosure of labels, ownership, policies, revisions
    // or other server data in either response.
    expect(JSON.parse(hiddenText)).toEqual(problem(0, '/properties/0/value/ref', ref));
    expect(new TextEncoder().encode(JSON.parse(hiddenText).reference)).toHaveLength(58);
    expect(hidden.reads).toEqual(absent.reads);
    expect(hidden.admissions()).toBe(0);
    expect(absent.admissions()).toBe(0);
  });

  for (const [inputKind, invalidReference] of [
    ['malformed', 'https://rezics.com/id/not-a-uuid'],
    ['over-long', `${id(90)}${'x'.repeat(4096)}`],
    ['non-native IRI', 'https://example.org/id/00000000-0000-4000-8000-000000000090'],
  ] as const) {
    const positions = [
      { name: 'resource property', state: resource([property(id(2)), property(invalidReference)]),
        code: 'invalid_semantic_value', title: 'Semantic value is invalid' },
      { name: 'definition successor', state: { component: 'definition', kind: 'property', lifecycle: 'retired',
        successor: invalidReference, roles: [] },
        code: 'invalid_semantic_change', title: 'Semantic change does not match its profile' },
      { name: 'role member', state: { component: 'definition', kind: 'relation', lifecycle: 'active',
        successor: null, roles: [role('participant', [id(2), invalidReference])] },
        code: 'invalid_semantic_change', title: 'Semantic change does not match its profile' },
    ];
    for (const position of positions) {
      test(`${bulk ? 'Bulk' : 'Single'} ${inputKind} ${position.name} is rejected before reference lookup with a generic body and no echo`, async () => {
        const f = fixture([id(2)]);
        const response = await f.app.handle(request([position.state], bulk));
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ type: `https://rezics.com/problems/${position.code}`,
          title: position.title, status: 400, code: position.code });
        expect(text).not.toContain(invalidReference);
        // Even the preceding valid reference is never looked up: the whole item
        // must pass its profile before any diagnostic or admission can run.
        expect(f.reads).toEqual([]);
        expect(f.admissions()).toBe(0);
      });
    }
  }

  test(`${bulk ? 'Bulk' : 'Single'} available references proceed to Access registration`, async () => {
    const first = id(90), second = id(10), f = fixture([first, second]);
    const response = await f.app.handle(request([resource([property(first), property(second)])], bulk));
    // Registration deliberately refuses: reaching its sentinel proves preflight
    // succeeded without exercising graph publication in this owner test.
    expect(f.admissions()).toBe(1);
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('itemIndex');
    expect(new Set(f.reads)).toEqual(new Set([first, second]));
  });

  test(`${bulk ? 'Bulk' : 'Single'} definition successor points to the submitted successor field`, async () => {
    const successor = id(90), f = fixture();
    const state = { component: 'definition', kind: 'property', lifecycle: 'retired', successor, roles: [] };
    const response = await f.app.handle(request([state], bulk));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(problem(0, '/successor', successor));
    expect(f.admissions()).toBe(0);
  });
}

test('Single changes preserve the submitted property index despite canonicalization', async () => {
  const available = id(2), first = id(90), second = id(10), f = fixture([available]);
  const response = await f.app.handle(request([resource([
    property(available), property(first, 'https://schema.org/mentions'), property(second),
  ])], false));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(problem(0, '/properties/1/value/ref', first));
  expect(f.reads).toEqual([available, first]);
  expect(f.admissions()).toBe(0);
});

test('A target outside the submitted state does not acquire an item diagnostic', async () => {
  const f = fixture();
  const response = await f.app.handle(request([resource()], false, { target: id(90), expectedHead: id(91) }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ type: 'https://rezics.com/problems/unavailable_reference',
    title: 'Semantic change is not admitted', status: 422, code: 'unavailable_reference' });
  expect(f.admissions()).toBe(0);
});

test('Generic and server-derived unavailable-reference rejections never echo their private message', async () => {
  const response = semanticError(new SemanticChangeRejected('unavailable-reference',
    `private label; owner ${id(7)}; policy ${id(8)}; discovered reference ${id(9)}`));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ type: 'https://rezics.com/problems/unavailable_reference',
    title: 'Semantic change is not admitted', status: 422, code: 'unavailable_reference' });
});
