import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment }
  from '../work/activate.ts';
import { readExactContributionDraft } from './history.ts';
import { PrivateSearchReceiptSession } from './private-delivery-fence.ts';
import { PRIVATE_SEARCH_GRAPH, privateDraftUnit } from './private-projection.ts';

export class InvalidPrivateQuery extends Error {}
export class PrivateSearchUnavailable extends Error {}
export class PrivateSearchBudgetExceeded extends Error {}

export const PRIVATE_SEARCH_REQUEST_MS = 1_500;
export const PRIVATE_SEARCH_FUSEKI_CALLS = 10;
export const PRIVATE_SEARCH_FINAL_FUSEKI_CALLS = 2;
export const PRIVATE_SEARCH_FUSEKI_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function privatePhrase(input: PrivateContributionPhraseInput): string {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!nativeId.test(input.contribution) || phrase.length < 2 || phrase.length > 80
    || /[\u0000-\u001f\u007f]/u.test(phrase)) {
    throw new InvalidPrivateQuery('invalid private phrase');
  }
  return phrase;
}

export interface PrivateContributionPhraseInput {
  contribution: string;
  phrase: string;
}

interface PrivatePosition {
  instanceId: string;
  writeEpoch: string;
  head: string;
  sequence: string;
  generation: string;
}

function samePosition(left: PrivatePosition, right: PrivatePosition): boolean {
  return left.instanceId === right.instanceId && left.writeEpoch === right.writeEpoch
    && left.head === right.head && left.sequence === right.sequence
    && left.generation === right.generation;
}

async function position(env: WorkActivationEnvironment, contribution: string): Promise<PrivatePosition> {
  const health = await env.fuseki.commandHealth();
  if (health.moduleVersion !== '0.5.17' || !health.privateSearchWriteEpoch
    || !/^(0|[1-9][0-9]*)$/.test(health.privateSearchWriteEpoch)
    || health.privateSearchWriteActive !== false
    || health.publicSearchDeltaAvailable !== true
    || BigInt(health.privateSearchWriteEpoch) % 2n !== 0n) {
    throw new PrivateSearchUnavailable('private index writer state is unavailable');
  }
  const graph = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?head ?sequence ?generation WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ;
          rv:sequence ?sequence ; rv:textIndexGeneration ?generation .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(contribution)} a rv:TextContribution ; rv:draftHead ?head ; rv:work ?work .
        ?work a schema:CreativeWork .
      }
    }`, 65_536);
  const rows = graph.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.head || !rows[0]?.sequence || !rows[0]?.generation
    || !nativeId.test(rows[0].head.value) || !/^(0|[1-9][0-9]*)$/.test(rows[0].sequence.value)
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(rows[0].generation.value)) {
    throw new PrivateSearchUnavailable('current private draft position is unavailable');
  }
  return { instanceId: health.instanceId, writeEpoch: health.privateSearchWriteEpoch,
    head: rows[0].head.value, sequence: rows[0].sequence.value,
    generation: rows[0].generation.value };
}

/** One concrete body field. The public route must call this only behind Access
 * admission; the internal orchestration below owns that sequence. */
async function queryPrivateContributionPhraseCandidate(env: WorkActivationEnvironment,
  input: PrivateContributionPhraseInput) {
  const phrase = privatePhrase(input);
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  const initial = await position(env, input.contribution);
  let exact;
  try {
    exact = await readExactContributionDraft(env, input.contribution, initial.head,
      async () => true);
  } catch (cause) {
    throw new PrivateSearchUnavailable('exact private source is unavailable', { cause });
  }
  const unit = privateDraftUnit(initial.head);
  const projection = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?body WHERE {
    GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
      ${iri(unit)} a rv:MatchUnit ; rv:contribution ${iri(input.contribution)} ;
        rv:work ${iri(exact.work)} ; rv:revision ${iri(initial.head)} ;
        rv:field rv:Body ; rv:disclosure rv:Private ;
        rv:language ${lit(exact.language)} ; rv:privateSearchBody ?body .
    }
  }`, 262_144);
  const projected = projection.results?.bindings ?? [];
  if (projected.length !== 1 || projected[0]?.body?.value !== exact.body
    || projected[0].body['xml:lang'] !== exact.language) {
    throw new PrivateSearchUnavailable('private projection differs from exact source');
  }
  // The independent wildcard probe distinguishes a genuine phrase miss from a
  // missing Lucene posting. Both text calls bind the one admitted unit in ARQ.
  const indexed = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?literal ?graph ?predicate WHERE { GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
      (${iri(unit)} ?score ?literal ?graph ?predicate)
        text:query (rv:privateSearchBody ${lit('privateBody:*')} 2) .
    } }`, 262_144);
  const postings = indexed.results?.bindings ?? [];
  if (postings.length !== 1 || postings[0]?.literal?.value !== exact.body
    || postings[0].literal['xml:lang'] !== exact.language
    || postings[0].graph?.value !== PRIVATE_SEARCH_GRAPH
    || postings[0].predicate?.value !== `${RV}privateSearchBody`) {
    throw new PrivateSearchUnavailable('private Lucene posting is unavailable');
  }
  const matched = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#>
    SELECT ?literal ?graph ?predicate WHERE { GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
      (${iri(unit)} ?score ?literal ?graph ?predicate)
        text:query (rv:privateSearchBody ${lit(lucene)} 2) .
    } }`, 262_144);
  const hits = matched.results?.bindings ?? [];
  if (hits.length > 1 || hits.some(row => row.literal?.value !== exact.body
    || row.graph?.value !== PRIVATE_SEARCH_GRAPH
    || row.predicate?.value !== `${RV}privateSearchBody`)) {
    throw new PrivateSearchUnavailable('private phrase match is ambiguous');
  }
  const final = await position(env, input.contribution);
  if (!samePosition(initial, final)) {
    throw new PrivateSearchUnavailable('private position moved during phrase read');
  }
  const response = { profile: 'private-contribution-phrase-v1' as const,
    contribution: input.contribution, complete: true as const,
    total: hits.length, results: hits.length === 1
      ? [{ matchUnit: unit, contribution: input.contribution,
        revision: initial.head, field: 'body' as const, language: exact.language }] : [],
    sourcePosition: { datasetId: 'product' as const, dataEpoch: env.lineage.dataEpoch,
      sequence: initial.sequence }, indexGeneration: initial.generation };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > MAX_RESULT_BYTES) {
    throw new PrivateSearchBudgetExceeded('private result exceeds response bound');
  }
  return { response, position: final };
}

/** Diagnostic adapter used by native owner tests; it has no public route. */
export async function queryPrivateContributionPhrase(env: WorkActivationEnvironment,
  input: PrivateContributionPhraseInput) {
  return (await queryPrivateContributionPhraseCandidate(env, input)).response;
}

/** Binds the pre-match Access admission to the exact native candidate. The
 * session rechecks native position after begin and before its durable send arm. */
export async function prepareAdmittedPrivateContributionPhrase(env: WorkActivationEnvironment,
  access: AccessAdmissionRegistry, principal: VerifiedPrincipal, actingSubject: string,
  input: PrivateContributionPhraseInput): Promise<PrivateSearchReceiptSession> {
  privatePhrase(input);
  const lease = await access.admitContributionSearchRead(principal, actingSubject,
    input.contribution);
  let candidate: Awaited<ReturnType<typeof queryPrivateContributionPhraseCandidate>>;
  try {
    candidate = await withPrivateSearchBudget(
      () => queryPrivateContributionPhraseCandidate(env, input));
  } catch (error) {
    await access.finishContributionSearchRead(lease.id, 'aborted');
    throw error;
  }
  return new PrivateSearchReceiptSession(access, lease.id, candidate.response, async () => {
    await access.beginContributionSearchDelivery(lease.id, principal, actingSubject,
      input.contribution);
    await withPrivateSearchBudget(async () => {
      const final = await position(env, input.contribution);
      if (!samePosition(candidate.position, final)) {
        throw new PrivateSearchUnavailable('private position moved before delivery');
      }
    }, PRIVATE_SEARCH_FINAL_FUSEKI_CALLS);
  });
}

export async function withPrivateSearchBudget<T>(read: () => Promise<T>,
  calls = PRIVATE_SEARCH_FUSEKI_CALLS): Promise<T> {
  if (!Number.isInteger(calls) || calls < 1 || calls > PRIVATE_SEARCH_FUSEKI_CALLS) {
    throw new PrivateSearchBudgetExceeded('invalid private Fuseki call budget');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRIVATE_SEARCH_REQUEST_MS);
  try {
    return await fusekiReadBudget.run({ signal: controller.signal,
      callsLeft: calls, bytesLeft: PRIVATE_SEARCH_FUSEKI_BYTES },
    async () => {
      const result = await read();
      if (controller.signal.aborted) throw new PrivateSearchBudgetExceeded('private query timed out');
      return result;
    });
  } finally { clearTimeout(timer); }
}
