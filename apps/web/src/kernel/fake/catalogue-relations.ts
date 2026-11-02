import { createKernelClient, type SubjectRead } from '@rezics/client';
import type { Release } from '@rezics/definitions';
import {
  readRelationEditor,
  proposeRelation,
  confirmRelation,
  relationDraft,
  type RelationStatementInput,
  type RelationSlot,
  type RelationTransport,
  type RelationTypeDescriptor,
} from '../../subject/relation-candidates';
import { candidateContext, type Candidate } from '../../subject/candidates';
import recording from '../recorded/subject.json';
import definitions from '../recorded/definitions-release.json';

export const relationProperty = 'wdt:P725';
export const relationActor = '00000000-0000-8000-8000-000000000101';
export const relationRole = '00000000-0000-8000-8000-000000000102';
const otherRole = '00000000-0000-8000-8000-000000000103';
const otherActor = '00000000-0000-8000-8000-000000000104';
export type RelationScenario =
  | 'ready'
  | 'empty'
  | 'denied'
  | 'invalid'
  | 'stale'
  | 'unavailable'
  | 'pending'
  | 'loading'
  | 'retracted'
  | 'unresolved'
  | 'lost-response'
  | 'lost-proposal-response';

function exactDescriptor(release: Release, typeId: string, digest: string): RelationTypeDescriptor {
  const definition = release.types[typeId]!;
  const ids = new Set(definition.properties);
  for (const id of definition.properties)
    for (const qualifier of release.properties[id]?.qualifiers ?? []) ids.add(qualifier);
  return {
    typeId,
    releaseDigest: digest,
    definition,
    properties: Object.fromEntries(
      [...ids].flatMap((id) => (release.properties[id] ? [[id, release.properties[id]]] : [])),
    ),
  };
}

/** Small request-seam fixture shared by the page stories and focused exact-slot cases. */
export function relationFixture(scenario: RelationScenario = 'ready', locale = 'en') {
  const release = definitions.release as unknown as Release;
  const publicRead = structuredClone(recording) as unknown as SubjectRead;
  publicRead.subject.type = 'schema:Movie';
  publicRead.subject.context = candidateContext;
  let descriptor = exactDescriptor(release, publicRead.subject.type, publicRead.subject.release);
  let descriptorAvailable = true;
  const id = publicRead.subject.id;
  const slot: RelationSlot = { property: relationProperty, target: relationActor, key: relationRole };
  const snak = (
    property: string,
    content: string,
    data_type: 'wikibase-item' | 'string' | 'url' = 'wikibase-item',
  ) => ({ property: { id: property, data_type }, value: { type: 'value' as const, content } });
  const statement = (suffix: string, actor: string, role: string): Candidate['statement'] => ({
    ...snak(relationProperty, actor),
    id: `00000000-0000-8000-8000-000000000${suffix}`,
    rank: 'normal',
    qualifiers: [snak('wdt:P453', role), snak('wdt:P1932', 'Original credit', 'string')],
    references: [{ hash: 'reference', parts: [snak('schema:url', 'https://example.org/credits', 'url')] }],
    rezics: { release: publicRead.subject.release, revision: 1 },
  });
  const original = statement('201', relationActor, relationRole);
  const sibling = statement('202', relationActor, otherRole);
  const neighbor = statement('203', otherActor, relationRole);
  if (scenario === 'unresolved') {
    original.value = { type: 'somevalue' };
    original.qualifiers = [snak('schema:sameAs', 'https://example.org/people/original', 'url')];
    // Use an actually released relation that admits sameAs for this unresolved source record.
    original.property.id = 'schema:author';
    publicRead.subject.type = 'schema:Book';
  }
  publicRead.subject.statements[relationProperty] =
    scenario === 'empty' || scenario === 'unresolved' ? [] : [original, sibling, neighbor];
  if (scenario === 'unresolved') publicRead.subject.statements['schema:author'] = [original];
  for (const [target, label, type] of [
    [relationActor, 'Aoi Yuki', 'schema:Person'],
    [relationRole, 'The traveler', 'wd:Q95074'],
    [otherRole, 'The narrator', 'wd:Q95074'],
    [otherActor, 'Kana Hanazawa', 'schema:Person'],
  ])
    publicRead.related[target!] = { labels: { en: label! }, type: type! };
  const candidate: Candidate = {
    id: '00000000-0000-8000-8000-000000000301',
    source: null,
    retracted: scenario === 'retracted' ? 4 : null,
    retraction: null,
    release: publicRead.subject.release,
    revision: 2,
    decision: null,
    head: null,
    rank: null,
    statement: { ...structuredClone(original), id: '00000000-0000-8000-8000-000000000301' },
  };
  const candidates = scenario === 'empty' ? [] : [candidate];
  let adoptionHead = 7;
  let revision = 2;
  let adopted = false;
  let lost = false;
  let proposalLost = false;
  let failedRead = false;
  const calls: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: Record<string, unknown> | null;
    authorization: string | null;
    session: string | null;
    key: string | null;
  }[] = [];
  const receipts = new Map<string, unknown>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
        'rezics-session-token': 'relation-session',
      },
    });
  const matches = (item: Candidate['statement'], address: Record<string, unknown>) => {
    const key = item.qualifiers.find((snak) => snak.property.id === 'wdt:P453');
    return (
      item.property.id === address.property &&
      (address.sameAs
        ? item.value.type === 'somevalue' &&
          item.qualifiers.some(
            (snak) =>
              snak.property.id === 'schema:sameAs' &&
              snak.value.type === 'value' &&
              snak.value.content === address.sameAs,
          )
        : item.value.type === 'value' &&
          item.value.content === address.target &&
          (item.property.id !== relationProperty ||
            (key?.value.type === 'value' ? key.value.content : undefined) === address.key))
    );
  };
  const fetcher = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const body = request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : null;
    const key = request.headers.get('idempotency-key');
    calls.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.get('authorization'),
      session: request.headers.get('rezics-session-token'),
      key,
    });
    if (url.pathname === `/v1/subjects/${id}` && request.method === 'GET') return json(publicRead);
    if (scenario === 'denied') return json({ code: 'forbidden' }, 403);
    if (url.pathname.endsWith('/candidates') && request.method === 'GET') {
      if (scenario === 'loading') return await new Promise<Response>(() => {});
      if (scenario === 'unavailable' && !failedRead) {
        failedRead = true;
        return json({ code: 'semantic_not_ready' }, 503);
      }
      return json({
        candidates: candidates.filter((item) => matches(item.statement, Object.fromEntries(url.searchParams))),
        adoption: { mode: 'replace', head: adoptionHead },
        next: null,
      });
    }
    if (!request.headers.has('authorization')) return json({ code: 'authentication_required' }, 401);
    if (key && receipts.has(key)) return json(receipts.get(key), url.pathname.endsWith('/candidates') ? 201 : 200);
    if (scenario === 'invalid') return json({ code: 'invalid_request' }, 400);
    if (scenario === 'stale') return json({ code: 'stale_editorial_head' }, 409);
    if (url.pathname.endsWith('/candidates') && body) {
      const proposed = body.statement as RelationStatementInput;
      const readSnak = (input: RelationStatementInput['qualifiers'][number]) => ({
        ...input,
        property: { id: input.property.id, data_type: release.properties[input.property.id]!.datatype },
      });
      const added: Candidate = {
        ...structuredClone(candidate),
        id: `00000000-0000-8000-8000-000000000${++revision + 400}`,
        statement: {
          ...readSnak(proposed),
          id: `00000000-0000-8000-8000-000000000${revision + 400}`,
          rank: 'normal',
          qualifiers: proposed.qualifiers.map(readSnak),
          references: proposed.references.map(({ parts }) => ({ parts: parts.map(readSnak), hash: 'citation' })),
          rezics: { release: publicRead.subject.release, revision },
        },
      };
      candidates.push(added);
      const receipt = { candidate: added.id, revision };
      if (key) receipts.set(key, receipt);
      if (scenario === 'lost-proposal-response' && !proposalLost) {
        proposalLost = true;
        throw new Error('Response lost');
      }
      return json(receipt, 201);
    }
    const selected = candidates.find((item) => url.pathname.includes(item.id));
    if (selected && (url.pathname.endsWith(':accept') || url.pathname.endsWith(':reject')) && body) {
      if (body.expected_head !== selected.head) return json({ code: 'stale_editorial_head' }, 409);
      selected.decision = url.pathname.endsWith(':reject') ? 'rejected' : 'accepted';
      selected.head = (selected.head ?? 0) + 1;
      const receipt = {
        acceptance: {
          context: candidateContext,
          candidate: selected.id,
          decision: selected.decision === 'accepted' ? 'accept' : 'reject',
          head: selected.head,
        },
        revision: ++revision,
      };
      if (key) receipts.set(key, receipt);
      return json(receipt);
    }
    if (url.pathname.endsWith(':adopt') && body) {
      if (body.expected_head !== adoptionHead) return json({ code: 'stale_editorial_head' }, 409);
      const selection = (body.selection as { candidate: string; rank: 'normal' | 'preferred' }[])[0]!;
      const choice = candidates.find((item) => item.id === selection.candidate);
      if (!choice || choice.decision !== 'accepted' || !matches(choice.statement, body))
        return json({ code: 'conflict' }, 409);
      adopted = true;
      if (scenario !== 'pending')
        publicRead.subject.statements[String(body.property)] = [
          ...(publicRead.subject.statements[String(body.property)] ?? []).filter((item) => !matches(item, body)),
          { ...structuredClone(choice.statement), rank: selection.rank },
        ];
      const receipt = { adoption: { ...body, head: ++adoptionHead }, revision: ++revision };
      if (key) receipts.set(key, receipt);
      if (scenario === 'lost-response' && !lost) {
        lost = true;
        throw new Error('Response lost');
      }
      return json(receipt);
    }
    return json({ code: 'not_found' }, 404);
  }) as typeof fetch;
  const client = createKernelClient('https://relations.test', { fetch: fetcher });
  const descriptorReader = async (typeId: string) =>
    descriptorAvailable && typeId === descriptor.typeId
      ? { ok: true as const, descriptor }
      : { ok: false as const, reason: 'unavailable' as const };
  const transport: RelationTransport = {
    read: (address, cursor, session) =>
      readRelationEditor(client, 'Bearer fixture', descriptorReader, id, locale, address, cursor, session),
    propose: (input) => proposeRelation(client, 'Bearer fixture', descriptorReader, input),
    confirm: (input) => confirmRelation(client, 'Bearer fixture', input),
  };
  return {
    id,
    slot,
    original,
    sibling,
    neighbor,
    candidate,
    candidates,
    publicRead,
    release,
    descriptor,
    client,
    transport,
    calls,
    draft: relationDraft(original),
    get adopted() {
      return adopted;
    },
    setScenario(next: RelationScenario) {
      scenario = next;
    },
    setDescriptor(next: RelationTypeDescriptor) {
      descriptor = next;
    },
    setDescriptorAvailable(available: boolean) {
      descriptorAvailable = available;
    },
  };
}
