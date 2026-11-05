import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import { profileDigest, resolveTemplate } from '@rezics/composition';
import { platformProfile } from '../../src/presentation/setup.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

const databaseUrl = process.env.DATABASE_URL;
const memberToken = process.env.PAGE_DATA_CHECK_MEMBER_TOKEN;
const databaseName = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1)) : '';
const retainedStackAvailable = Boolean(databaseUrl && memberToken && !databaseName.startsWith('kernel_test_'));
const SOURCE = 'bangumi_cross_media';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUMMARY_DIGEST = /^[0-9a-f]{64}$/;
const MAX_BINDINGS_PER_TYPE = 128;
const MAX_CANDIDATE_PAGES = 4;
const RELATION_LIMIT = 12;

type RecordValue = Record<string, unknown>;
type Persona = 'anonymous' | 'member';
type CandidateRank = 'normal' | 'preferred' | 'deprecated';
type CandidateDecision = 'accepted' | 'rejected' | 'abstained' | null;
type SourceBinding = {
  route: number;
  subjectId: string;
  externalId: string;
  candidateIds: string[];
};
type PersonBinding = { route: number; subjectId: string };
type ImportedCandidate = {
  id: string;
  source: { source: string; externalId: string; fieldGroup: string } | null;
  retracted: number | null;
  statement: RecordValue;
  decision: CandidateDecision;
  head: number | null;
  rank: CandidateRank | null;
};
type Synopsis = {
  binding: SourceBinding;
  candidate: ImportedCandidate;
  documentId: string;
  digest: string;
  language: string;
  recordUrl: string;
};
type CandidateListing = { candidates: ImportedCandidate[]; adoptionHead: number | null };
type HttpResult = { status: number; body: unknown };
type Relation = { statement: RecordValue; target: string | null; type: string | null };
type RelationPair = { anonymous: Relation[]; member: Relation[] };
type EditionLink = { subject: string; property: string; statement: string; type: string };
type EditionPair = { anonymous: EditionLink[]; member: EditionLink[] };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`Malformed ${label}`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Malformed ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Malformed ${label}`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new Error(`Malformed ${label}`);
  return result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Malformed ${label}`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const id = string(value, label);
  if (!UUID.test(id)) throw new Error(`Malformed ${label}`);
  return id;
}

function rank(value: unknown, label: string): CandidateRank | null {
  if (value === null) return null;
  if (value === 'normal' || value === 'preferred' || value === 'deprecated') return value;
  throw new Error(`Malformed ${label}`);
}

function status(result: HttpResult, expected: number, label: string): RecordValue {
  if (result.status !== expected) {
    const code = isRecord(result.body) && typeof result.body.code === 'string' ? ` (${result.body.code})` : '';
    throw new Error(`${label} returned HTTP ${result.status}${code}`);
  }
  return record(result.body, `${label} response`);
}

function queryPath(path: string, values: Record<string, string>): string {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
}

function resolveKernelOrigin(): URL {
  const origin = new URL(process.env.KERNEL_ORIGIN?.trim() || `http://127.0.0.1:${process.env.KERNEL_PORT ?? '4100'}`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    (origin.protocol !== 'https:' && !loopback)
  )
    throw new Error('KERNEL_ORIGIN must be HTTPS or loopback and must not contain credentials');
  return origin;
}

async function nativeRequest(
  origin: URL,
  method: 'GET' | 'POST',
  path: string,
  persona: Persona,
  body?: unknown,
  idempotent = false,
): Promise<HttpResult> {
  const headers = new Headers({ accept: 'application/json' });
  if (persona === 'member') {
    if (!memberToken) throw new Error('Development-member token is required for retained readback');
    headers.set('authorization', `Bearer ${memberToken}`);
  }
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (idempotent) headers.set('idempotency-key', `"${randomUUID()}"`);
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function parseSourceBinding(value: unknown): SourceBinding {
  const row = record(value, 'source binding');
  const route = integer(row.route, 'source binding route');
  if (route < 0 || route > 4095) throw new Error('Malformed source binding route');
  const subjectId = uuid(row.subject_id, 'source binding Subject');
  const externalId = string(row.external_id, 'source binding external ID');
  if (!/^\d{1,20}$/.test(externalId)) throw new Error('Malformed Bangumi source binding');
  const candidateIds = array(row.candidate_ids, 'source binding candidate IDs').map((candidate) =>
    uuid(candidate, 'source binding candidate ID'),
  );
  if (candidateIds.length === 0) throw new Error('Empty source binding candidate set');
  return { route, subjectId, externalId, candidateIds };
}

function parsePersonBinding(value: unknown): PersonBinding {
  const row = record(value, 'Person source binding');
  const route = integer(row.route, 'Person source binding route');
  if (route < 0 || route > 4095) throw new Error('Malformed Person source binding route');
  return { route, subjectId: uuid(row.subject_id, 'Person source binding Subject') };
}

function parseCandidate(value: unknown): ImportedCandidate | null {
  const row = record(value, 'candidate');
  const id = uuid(row.id, 'candidate ID');
  if (row.deleted === true) return null;
  if (row.deleted !== undefined) throw new Error('Malformed candidate deletion state');
  let source: ImportedCandidate['source'] = null;
  if (row.source !== null) {
    const sourceValue = record(row.source, 'candidate source');
    source = {
      source: string(sourceValue.source, 'candidate source name'),
      externalId: string(sourceValue.external_id, 'candidate source external ID'),
      fieldGroup: string(sourceValue.field_group, 'candidate source field group'),
    };
  }
  const retracted = row.retracted === null ? null : positiveInteger(row.retracted, 'candidate retraction revision');
  const decision = row.decision;
  if (decision !== null && decision !== 'accepted' && decision !== 'rejected' && decision !== 'abstained')
    throw new Error('Malformed candidate decision');
  const head = row.head === null ? null : positiveInteger(row.head, 'candidate decision head');
  const candidateRank = rank(row.rank, 'candidate adoption rank');
  return {
    id,
    source,
    retracted,
    statement: record(row.statement, 'candidate statement'),
    decision,
    head,
    rank: candidateRank,
  };
}

function candidateProperty(candidate: ImportedCandidate): string {
  return string(record(candidate.statement.property, 'candidate property').id, 'candidate property ID');
}

function candidateContent(candidate: ImportedCandidate): RecordValue {
  const value = record(candidate.statement.value, 'candidate value');
  if (value.type !== 'value') throw new Error('Malformed imported summary value');
  return record(value.content, 'imported summary content');
}

function sourceCitation(candidate: ImportedCandidate, externalId: string): string {
  const recordUrl = `https://bgm.tv/subject/${externalId}`;
  const references = array(candidate.statement.references, 'candidate references');
  const cited = references.some((reference) => {
    const parts = array(record(reference, 'candidate reference').parts, 'reference parts');
    return parts.some((part) => {
      const snak = record(part, 'reference snak');
      const property = record(snak.property, 'reference property');
      const value = record(snak.value, 'reference value');
      return property.id === 'schema:url' && value.type === 'value' && value.content === recordUrl;
    });
  });
  if (!cited) throw new Error('Imported summary lost its exact Bangumi source citation');
  return recordUrl;
}

function synopsis(binding: SourceBinding, candidate: ImportedCandidate): Synopsis {
  if (
    candidate.source?.source !== SOURCE ||
    candidate.source.externalId !== binding.externalId ||
    candidate.source.fieldGroup !== 'summary' ||
    candidateProperty(candidate) !== 'schema:abstract'
  )
    throw new Error('Source binding does not match the current summary candidate');
  const content = candidateContent(candidate);
  const documentId = uuid(content.document, 'imported summary document ID');
  const digest = string(content.digest, 'imported summary document digest');
  if (!SUMMARY_DIGEST.test(digest)) throw new Error('Malformed imported summary document digest');
  const language = string(content.language, 'imported summary language');
  if (language !== 'und') throw new Error('Bangumi summary language changed from its source evidence');
  return {
    binding,
    candidate,
    documentId,
    digest,
    language,
    recordUrl: sourceCitation(candidate, binding.externalId),
  };
}

function parseAdoptionHead(value: unknown): number | null {
  if (value === null) return null;
  const adoption = record(value, 'candidate adoption');
  return positiveInteger(adoption.head, 'candidate adoption head');
}

function parseListing(value: unknown): { candidates: ImportedCandidate[]; adoptionHead: number | null; next: string | null } {
  const response = record(value, 'candidate listing');
  const candidates = array(response.candidates, 'candidate listing rows')
    .map(parseCandidate)
    .filter((candidate): candidate is ImportedCandidate => candidate !== null);
  const next = response.next;
  if (next !== null && typeof next !== 'string') throw new Error('Malformed candidate listing cursor');
  return { candidates, adoptionHead: parseAdoptionHead(response.adoption), next };
}

async function candidateListing(
  origin: URL,
  subjectId: string,
  member: Persona = 'member',
): Promise<CandidateListing> {
  const candidates: ImportedCandidate[] = [];
  let cursor: string | null = null;
  let adoptionHead: number | null | undefined;
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
    const path = queryPath(`/v1/subjects/${subjectId}/candidates`, {
      property: 'schema:abstract',
      context: GLOBAL_CONTEXT,
      limit: '100',
      ...(cursor === null ? {} : { cursor }),
    });
    const response = await nativeRequest(origin, 'GET', path, member);
    const parsed = parseListing(status(response, 200, 'native candidate listing'));
    if (adoptionHead === undefined) adoptionHead = parsed.adoptionHead;
    else if (adoptionHead !== parsed.adoptionHead) throw new Error('Global adoption changed while reading candidate pages');
    candidates.push(...parsed.candidates);
    if (parsed.next === null) return { candidates, adoptionHead: adoptionHead ?? null };
    cursor = parsed.next;
  }
  throw new Error('Native candidate listing exceeded its bounded page window');
}

function nestedTypeLists(value: unknown, output: RecordValue[] = []): RecordValue[] {
  if (Array.isArray(value)) {
    for (const child of value) nestedTypeLists(child, output);
    return output;
  }
  if (!isRecord(value)) return output;
  if (value.type === 'TypeList' && isRecord(value.props)) output.push(value);
  if (isRecord(value.props))
    for (const child of Object.values(value.props)) nestedTypeLists(child, output);
  return output;
}

function descendantOf(type: string, base: string): boolean {
  const seen = new Set<string>();
  const pending = [type];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === base) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const definition = bundledRelease.types[current];
    if (definition) pending.push(...definition.bases);
  }
  return false;
}

function parseRelations(value: unknown, property: string, targetBase: string): Relation[] {
  const response = record(value, 'native relation page');
  const freshness = record(response.freshness, 'relation freshness');
  expect(freshness).toMatchObject({ consistency: 'eventual', caught_up: true });
  const next = response.next;
  if (next !== null && typeof next !== 'string') throw new Error('Malformed relation cursor');
  const relations = array(response.relations, 'native relations').map((entry): Relation => {
    const relation = record(entry, 'relation');
    const statement = record(relation.statement, 'relation statement');
    const statementProperty = record(statement.property, 'relation statement property');
    expect(statementProperty.id).toBe(property);
    const target = relation.target === null ? null : uuid(relation.target, 'relation target');
    const type = relation.type === undefined ? null : string(relation.type, 'related Subject type');
    if (target === null || type === null) throw new Error('Released relation did not resolve its target Subject');
    expect(bundledRelease.types[type]).toBeDefined();
    expect(descendantOf(type, targetBase)).toBe(true);
    return { statement, target, type };
  });
  if (relations.length > RELATION_LIMIT) throw new Error('Native relation page exceeded its requested finite limit');
  return relations;
}

async function relationPair(
  origin: URL,
  subjectId: string,
  property: string,
  targetBase: string,
): Promise<RelationPair> {
  const path = queryPath(`/v1/subjects/${subjectId}/relations`, {
    property,
    context: GLOBAL_CONTEXT,
    limit: String(RELATION_LIMIT),
  });
  const anonymous = await nativeRequest(origin, 'GET', path, 'anonymous');
  const member = await nativeRequest(origin, 'GET', path, 'member');
  const anonymousBody = status(anonymous, 200, `anonymous ${property} relation read`);
  const memberBody = status(member, 200, `member ${property} relation read`);
  const anonymousRelations = parseRelations(anonymousBody, property, targetBase);
  const memberRelations = parseRelations(memberBody, property, targetBase);
  expect(memberRelations.map(({ statement, target }) => [statement.id, target])).toEqual(
    anonymousRelations.map(({ statement, target }) => [statement.id, target]),
  );
  const next = anonymousBody.next;
  if (next !== null && typeof next !== 'string') throw new Error('Malformed relation cursor');
  return { anonymous: anonymousRelations, member: memberRelations };
}

function parseEditionLinks(value: unknown): EditionLink[] {
  const response = record(value, 'native Book edition links');
  const freshness = record(response.freshness, 'Book edition link freshness');
  expect(freshness).toMatchObject({ consistency: 'eventual', caught_up: true });
  const next = response.next;
  if (next !== null && typeof next !== 'string') throw new Error('Malformed Book edition link cursor');
  const links = array(response.links, 'Book edition links').map((entry): EditionLink => {
    const link = record(entry, 'Book edition link');
    const subject = uuid(link.subject, 'edition Subject');
    const property = string(link.property, 'edition relation property');
    const statement = uuid(link.statement, 'edition relation statement');
    const type = string(link.type, 'edition Subject type');
    expect(property).toBe('schema:exampleOfWork');
    expect(bundledRelease.types[type]).toBeDefined();
    expect(descendantOf(type, 'schema:CreativeWork')).toBe(true);
    if (link.assertion !== undefined) {
      const assertionProperty = record(record(link.assertion, 'edition assertion').property, 'edition assertion property');
      expect(assertionProperty.id).toBe('schema:exampleOfWork');
    }
    return { subject, property, statement, type };
  });
  if (links.length > RELATION_LIMIT) throw new Error('Native Book edition page exceeded its finite limit');
  return links;
}

async function editionPair(origin: URL, bookId: string): Promise<EditionPair> {
  const path = queryPath(`/v1/subjects/${bookId}/links`, {
    property: 'schema:exampleOfWork',
    context: GLOBAL_CONTEXT,
    limit: String(RELATION_LIMIT),
  });
  const anonymous = await nativeRequest(origin, 'GET', path, 'anonymous');
  const member = await nativeRequest(origin, 'GET', path, 'member');
  const anonymousLinks = parseEditionLinks(status(anonymous, 200, 'anonymous Book editions link read'));
  const memberLinks = parseEditionLinks(status(member, 200, 'member Book editions link read'));
  expect(memberLinks).toEqual(anonymousLinks);
  return { anonymous: anonymousLinks, member: memberLinks };
}

async function readSubject(
  origin: URL,
  subjectId: string,
  type: string,
  persona: Persona,
): Promise<RecordValue> {
  const response = await nativeRequest(
    origin,
    'GET',
    queryPath(`/v1/subjects/${subjectId}`, { context: GLOBAL_CONTEXT }),
    persona,
  );
  const subject = record(status(response, 200, `${persona} current Subject read`).subject, 'current Subject');
  expect(subject.id).toBe(subjectId);
  expect(subject.type).toBe(type);
  record(subject.statements, 'current Subject statements');
  return subject;
}

function statementsFor(subject: RecordValue, property: string): RecordValue[] {
  const statements = record(subject.statements, 'current Subject statements');
  const value = statements[property];
  return value === undefined ? [] : array(value, `current ${property} statements`).map((item) => record(item, 'statement'));
}

function selectedAbstracts(subject: RecordValue): { candidate: string; rank: CandidateRank }[] {
  const selected = statementsFor(subject, 'schema:abstract').map((statement) => ({
    candidate: uuid(statement.id, 'selected summary candidate'),
    rank: rank(statement.rank, 'selected summary rank'),
  }));
  if (selected.some((entry) => entry.rank === null)) throw new Error('Current abstract statement has no adoption rank');
  if (selected.length > 32) throw new Error('Current abstract selection exceeds the native selection bound');
  return selected as { candidate: string; rank: CandidateRank }[];
}

function eligibleCandidate(candidate: ImportedCandidate): boolean {
  return candidate.retracted === null && (candidate.decision === null || candidate.decision === 'accepted');
}

async function discoverSynopsis(
  origin: URL,
  rows: readonly SourceBinding[],
  type: 'schema:TVSeries' | 'schema:Book',
  needsEdition: boolean,
): Promise<{ target: Synopsis; unadopted: Synopsis }> {
  let selected: Synopsis | null = null;
  let firstUnadopted: Synopsis | null = null;
  let unadopted: Synopsis | null = null;
  const visited = new Set<string>();
  for (const binding of rows) {
    if (visited.has(binding.subjectId)) continue;
    visited.add(binding.subjectId);
    await readSubject(origin, binding.subjectId, type, 'member');
    if (needsEdition) {
      const editions = await editionPair(origin, binding.subjectId);
      if (editions.anonymous.length === 0) continue;
    }
    const listing = await candidateListing(origin, binding.subjectId);
    const boundIds = new Set(binding.candidateIds);
    for (const candidate of listing.candidates) {
      if (!boundIds.has(candidate.id) || !eligibleCandidate(candidate)) continue;
      const candidateSynopsis = synopsis(binding, candidate);
      if (candidate.rank !== null && selected === null) selected = candidateSynopsis;
      if (candidate.rank === null) {
        if (firstUnadopted === null) firstUnadopted = candidateSynopsis;
        else if (candidate.id !== firstUnadopted.candidate.id) unadopted ??= candidateSynopsis;
      }
    }
    if (selected && firstUnadopted) unadopted ??= firstUnadopted;
    if (selected && unadopted) break;
    if (selected === null && firstUnadopted && unadopted) break;
  }
  const target = selected ?? firstUnadopted;
  if (!target || !unadopted || target.candidate.id === unadopted.candidate.id)
    throw new Error(`Retained ${type} source bindings lack a current publishable and withheld synopsis pair`);
  return { target, unadopted };
}

function sourceBindingsSql(type: string): string {
  return `
    SELECT sc.route, sc.subject_id::text AS subject_id, ec.external_id,
           array_agg(sc.candidate_id::text ORDER BY sc.candidate_id::text) AS candidate_ids
    FROM semantic.source_candidate sc
    JOIN semantic.external_claim ec
      ON ec.route=sc.route AND ec.source=sc.source AND ec.external_id=sc.external_id AND ec.subject_id=sc.subject_id
    JOIN semantic.subject s ON s.route=sc.route AND s.subject_id=sc.subject_id
    WHERE sc.source=$1 AND sc.field_group='summary' AND s.type=$2 AND s.visibility='visible'
      AND NOT EXISTS (SELECT 1 FROM semantic.redirect r WHERE r.route=s.route AND r.subject_id=s.subject_id)
    GROUP BY sc.route, sc.subject_id, ec.external_id
    ORDER BY sc.route, sc.subject_id
    LIMIT ${MAX_BINDINGS_PER_TYPE}`;
}

async function readBindings(): Promise<{
  anime: SourceBinding[];
  books: SourceBinding[];
  people: PersonBinding[];
}> {
  if (!databaseUrl) throw new Error('Retained database URL is required for source binding discovery');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const anime = await client.query(sourceBindingsSql('schema:TVSeries'), [SOURCE, 'schema:TVSeries']);
    const books = await client.query(sourceBindingsSql('schema:Book'), [SOURCE, 'schema:Book']);
    const people = await client.query(
      `
        SELECT DISTINCT s.route, s.subject_id::text AS subject_id
        FROM semantic.source_candidate sc
        JOIN semantic.external_claim ec
          ON ec.route=sc.route AND ec.source=sc.source AND ec.external_id=sc.external_id AND ec.subject_id=sc.subject_id
        JOIN semantic.subject s ON s.route=sc.route AND s.subject_id=sc.subject_id
        JOIN semantic.candidate c
          ON c.route=sc.route AND c.subject_id=sc.subject_id AND c.candidate_id=sc.candidate_id
        WHERE sc.source=$1 AND s.type='schema:Person' AND s.visibility='visible' AND c.property='wdt:P106'
          AND NOT EXISTS (SELECT 1 FROM semantic.redirect r WHERE r.route=s.route AND r.subject_id=s.subject_id)
        ORDER BY s.route, s.subject_id
        LIMIT 128`,
      [SOURCE],
    );
    await client.query('COMMIT');
    return {
      anime: anime.rows.map(parseSourceBinding),
      books: books.rows.map(parseSourceBinding),
      people: people.rows.map(parsePersonBinding),
    };
  } finally {
    await client.end();
  }
}

async function discoverPersonOccupation(origin: URL, rows: readonly PersonBinding[]): Promise<string> {
  for (const binding of rows) {
    await readSubject(origin, binding.subjectId, 'schema:Person', 'member');
    const occupations = await relationPair(origin, binding.subjectId, 'wdt:P106', 'skos:Concept');
    if (occupations.anonymous.length > 0) return binding.subjectId;
  }
  throw new Error('Retained Person source bindings have no current native occupation relations');
}

function abstractIds(subject: RecordValue): string[] {
  return statementsFor(subject, 'schema:abstract').map((statement) => uuid(statement.id, 'current abstract candidate'));
}

async function assertPrivateSynopsis(origin: URL, synopsisValue: Synopsis, type: string): Promise<void> {
  for (const persona of ['anonymous', 'member'] as const) {
    const subject = await readSubject(origin, synopsisValue.binding.subjectId, type, persona);
    expect(abstractIds(subject)).not.toContain(synopsisValue.candidate.id);
    const document = await nativeRequest(
      origin,
      'GET',
      `/v1/documents/${synopsisValue.documentId}`,
      persona,
    );
    status(document, 404, `${persona} unadopted document read`);
  }
}

async function publishSynopsis(origin: URL, synopsisValue: Synopsis, type: string): Promise<void> {
  const { binding, candidate } = synopsisValue;
  const before = await candidateListing(origin, binding.subjectId);
  const current = before.candidates.find(({ id }) => id === candidate.id);
  if (!current) throw new Error('Current source-bound summary candidate disappeared before publication');
  if (current.rank === null) {
    if (current.decision === null) {
      const accepted = await nativeRequest(
        origin,
        'POST',
        `/v1/subjects/${binding.subjectId}/candidates/${candidate.id}:accept`,
        'member',
        { context: GLOBAL_CONTEXT, expected_head: current.head },
        true,
      );
      const acceptance = record(status(accepted, 200, 'native candidate acceptance').acceptance, 'candidate acceptance');
      expect(acceptance).toMatchObject({ context: GLOBAL_CONTEXT, candidate: candidate.id, decision: 'accept' });
    } else if (current.decision !== 'accepted') {
      throw new Error('Unadopted summary candidate is not eligible for acceptance');
    }
    const latest = await candidateListing(origin, binding.subjectId);
    const latestCandidate = latest.candidates.find(({ id }) => id === candidate.id);
    if (!latestCandidate || latestCandidate.decision !== 'accepted')
      throw new Error('Native acceptance did not make the summary candidate accepted');
    const currentSubject = await readSubject(origin, binding.subjectId, type, 'member');
    const selection = selectedAbstracts(currentSubject);
    if (selection.some(({ candidate: selected }) => selected === candidate.id)) return;
    selection.push({ candidate: candidate.id, rank: 'normal' });
    const adopted = await nativeRequest(
      origin,
      'POST',
      `/v1/subjects/${binding.subjectId}:adopt`,
      'member',
      {
        context: GLOBAL_CONTEXT,
        property: 'schema:abstract',
        mode: 'replace',
        selection,
        expected_head: latest.adoptionHead,
      },
      true,
    );
    const adoption = record(status(adopted, 200, 'native Global adoption').adoption, 'Global adoption');
    expect(adoption).toMatchObject({ context: GLOBAL_CONTEXT, property: 'schema:abstract', mode: 'replace' });
    expect(array(adoption.selection, 'adopted summary selection')).toContainEqual({
      candidate: candidate.id,
      rank: 'normal',
    });
  } else if (current.decision !== 'accepted') {
    throw new Error('Selected Global summary candidate lacks current acceptance');
  }
}

function sourceReferences(value: unknown, recordUrl: string): boolean {
  return array(value, 'public document source references').some((reference) => {
    const parts = array(record(reference, 'public source reference').parts, 'public source reference parts');
    return parts.some((part) => {
      const snak = record(part, 'public source reference snak');
      const property = record(snak.property, 'public source property');
      const snakValue = record(snak.value, 'public source value');
      return property.id === 'schema:url' && snakValue.type === 'value' && snakValue.content === recordUrl;
    });
  });
}

async function assertPublicSynopsis(origin: URL, synopsisValue: Synopsis, type: string): Promise<void> {
  const statementIds: string[][] = [];
  for (const persona of ['anonymous', 'member'] as const) {
    const subject = await readSubject(origin, synopsisValue.binding.subjectId, type, persona);
    const statement = statementsFor(subject, 'schema:abstract').find(({ id }) => id === synopsisValue.candidate.id);
    expect(statement).toBeDefined();
    expect(record(statement!.property, 'published abstract property').id).toBe('schema:abstract');
    const content = record(record(statement!.value, 'published abstract value').content, 'published abstract content');
    expect(content).toMatchObject({
      document: synopsisValue.documentId,
      digest: synopsisValue.digest,
      language: synopsisValue.language,
    });
    statementIds.push(abstractIds(subject));

    const response = await nativeRequest(origin, 'GET', `/v1/documents/${synopsisValue.documentId}`, persona);
    const document = record(status(response, 200, `${persona} independent authored document read`).document, 'public document');
    expect(document).toMatchObject({
      id: synopsisValue.documentId,
      subjectId: synopsisValue.binding.subjectId,
      candidateId: synopsisValue.candidate.id,
      source: {
        source: SOURCE,
        external_id: synopsisValue.binding.externalId,
        field_group: 'summary',
      },
      rights: {
        license: 'CC-BY-SA-3.0',
        obligations: expect.arrayContaining(['cc:Attribution', 'cc:ShareAlike']),
      },
      language: 'und',
      digest: synopsisValue.digest,
      availability: 'available',
    });
    const metadata = record(document.source, 'public document source');
    expect(sourceReferences(metadata.references, synopsisValue.recordUrl)).toBe(true);
    const rights = record(document.rights, 'public document rights');
    expect(string(rights.attribution, 'public document attribution')).toContain(synopsisValue.recordUrl);
    expect(record(document.body, 'public document body')).toBeDefined();
  }
  expect(statementIds[1]).toEqual(statementIds[0]);
}

describe.skipIf(!retainedStackAvailable)('retained doctor catalogue readback', () => {
  test('native Home, released relations and accepted Bangumi synopses read independently', async () => {
    const origin = resolveKernelOrigin();
    const expectedHome = resolveTemplate(platformProfile, { route: '/' });

    for (const persona of ['anonymous', 'member'] as const) {
      const active = await nativeRequest(origin, 'GET', '/v1/definitions/active', persona);
      const activeRelease = status(active, 200, `${persona} active release read`);
      expect(activeRelease.digest).toBe(bundledDigest);

      const page = await nativeRequest(origin, 'POST', '/v1/pages:read', persona, { target: { route: '/' } });
      const pageBody = status(page, 200, `${persona} shipped Home page read`);
      expect(pageBody.profile).toBe(profileDigest(platformProfile));
      expect(pageBody.template).toEqual({ scope: 'route', key: '/' });
      expect(pageBody.document).toEqual(expectedHome.document);

      const reads = record(pageBody.reads, `${persona} Home native reads`);
      expect(Object.keys(reads)).toHaveLength(4);
      for (const read of Object.values(reads)) expect(record(read, 'Home native read').status).toBe(200);

      const lists = nestedTypeLists(pageBody.document);
      expect(lists).toHaveLength(4);
      for (const list of lists) {
        const props = record(list.props, 'Home TypeList props');
        const types = array(props.types, 'Home TypeList types').map((type) => string(type, 'Home TypeList type'));
        expect(types.length).toBeGreaterThan(0);
        expect(types.length).toBeLessThanOrEqual(24);
        expect(new Set(types).size).toBe(types.length);
        expect(() => admitFilter(parseFilter({ type: { in: types } }), bundledRelease)).not.toThrow();
        if (props.filter !== undefined)
          expect(() => admitFilter(parseFilter(props.filter), bundledRelease)).not.toThrow();
      }
    }

    const bindings = await readBindings();
    const anime = await discoverSynopsis(origin, bindings.anime, 'schema:TVSeries', false);
    const book = await discoverSynopsis(origin, bindings.books, 'schema:Book', true);
    expect(book.target.candidate.source?.externalId).toBe(book.target.binding.externalId);

    const personId = await discoverPersonOccupation(origin, bindings.people);
    await readSubject(origin, personId, 'schema:Person', 'anonymous');
    const unknownProperty = await nativeRequest(
      origin,
      'GET',
      queryPath(`/v1/subjects/${book.target.binding.subjectId}/links`, {
        property: 'rezics:notReleased',
        context: GLOBAL_CONTEXT,
        limit: String(RELATION_LIMIT),
      }),
      'anonymous',
    );
    const unknownPropertyBody = status(unknownProperty, 400, 'unknown relation descriptor refusal');
    expect(unknownPropertyBody.code).toBe('invalid_request');
    const unknownType = await nativeRequest(
      origin,
      'GET',
      queryPath(`/v1/subjects/${personId}/relations`, {
        property: 'wdt:P106',
        type: 'rezics:notReleased',
        context: GLOBAL_CONTEXT,
        limit: String(RELATION_LIMIT),
      }),
      'member',
    );
    const unknownTypeBody = status(unknownType, 400, 'unknown released Type refusal');
    expect(unknownTypeBody.code).toBe('invalid_request');

    if (anime.target.candidate.rank === null)
      await assertPrivateSynopsis(origin, anime.target, 'schema:TVSeries');
    await assertPrivateSynopsis(origin, anime.unadopted, 'schema:TVSeries');
    if (book.target.candidate.rank === null) await assertPrivateSynopsis(origin, book.target, 'schema:Book');
    await assertPrivateSynopsis(origin, book.unadopted, 'schema:Book');

    await publishSynopsis(origin, anime.target, 'schema:TVSeries');
    await publishSynopsis(origin, book.target, 'schema:Book');

    await assertPublicSynopsis(origin, anime.target, 'schema:TVSeries');
    await assertPublicSynopsis(origin, book.target, 'schema:Book');
    await assertPrivateSynopsis(origin, anime.unadopted, 'schema:TVSeries');
    await assertPrivateSynopsis(origin, book.unadopted, 'schema:Book');
  }, 120_000);
});
