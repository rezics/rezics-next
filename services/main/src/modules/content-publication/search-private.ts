import type { ContentCore } from '../../../../content/src/core.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { requireSelectedPlatformCapability, type AccessExposure } from '../access/exposure.ts';
import { resolvedSemanticCapabilities } from '../semantic/admitted.ts';
import { PrivateSearchReceiptSession } from '../contribution/private-delivery-fence.ts';
import type { PrivateSearchSettlement } from '../contribution/private-search-settlement.ts';
import { PRIVATE_SEARCH_GRAPH } from '../contribution/private-projection.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment }
  from '../work/activate.ts';
import { ContentSearchReadAccess } from '../search-disclosure/content-read-lease.ts';
import { projectPrivateContentDraft }
  from './search-private-projection.ts';

const resourceId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const variantId = /^urn:rezics:variant:[0-9a-f-]{36}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
export const CONTENT_PRIVATE_SEARCH_COST = { contentReads: 4, fusekiReads: 12,
  graphCommands: 1, textCandidateLimit: 2,
  resultBytes: 1_048_576, phraseCodepoints: 80 } as const;

export class InvalidPrivateContentPhrase extends Error {}
export class PrivateContentSearchUnavailable extends Error {}

export interface PrivateContentPhraseInput { resource: string; variant: string; phrase: string }

function phraseOf(input: PrivateContentPhraseInput): string {
  const phrase = input.phrase.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!resourceId.test(input.resource) || !variantId.test(input.variant)
    || phrase.length < 2 || phrase.length > 80 || /[\u0000-\u001f\u007f]/u.test(phrase)) {
    throw new InvalidPrivateContentPhrase('invalid private Content phrase');
  }
  return phrase;
}

interface Position { instance: string; writeEpoch: string; generation: string; graphSequence: string }

async function position(env: WorkActivationEnvironment): Promise<Position> {
  const health = await env.fuseki.commandHealth();
  if (!health.privateSearchWriteEpoch || !decimal.test(health.privateSearchWriteEpoch)
    || health.privateSearchWriteActive !== false
    || BigInt(health.privateSearchWriteEpoch) % 2n !== 0n) {
    throw new PrivateContentSearchUnavailable('private Content index is unavailable');
  }
  const graph = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence ?generation WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence ;
      rv:textIndexGeneration ?generation .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
    }
  }`, 65_536);
  const rows = graph.results?.bindings ?? [];
  if (rows.length !== 1 || !decimal.test(rows[0]?.sequence?.value ?? '')
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(rows[0]?.generation?.value ?? '')) {
    throw new PrivateContentSearchUnavailable('private Content graph index position is unavailable');
  }
  return { instance: health.instanceId, writeEpoch: health.privateSearchWriteEpoch,
    generation: rows[0]!.generation!.value, graphSequence: rows[0]!.sequence!.value };
}

async function candidate(env: WorkActivationEnvironment, content: ContentCore,
  input: PrivateContentPhraseInput, phrase: string) {
  const head = await content.readDraftHead(input.resource, input.variant);
  if (!head) throw new PrivateContentSearchUnavailable('Content draft is unavailable');
  let projected;
  try {
    projected = await projectPrivateContentDraft(env, content, input.resource, input.variant,
      head.revisionId, head.position.dataEpoch);
  } catch (cause) {
    throw new PrivateContentSearchUnavailable('Content private projection is unavailable', { cause });
  }
  const initial = await position(env);
  const lucene = `"${phrase.replace(/[\\"]/g, '\\$&')}"`;
  // The wildcard distinguishes a genuine miss from a missing posting. Both
  // calls bind one exact, admitted subject before the Lucene lookup.
  const indexed = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#> SELECT ?literal ?graph ?predicate WHERE {
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
        (${iri(projected.unit)} ?score ?literal ?graph ?predicate)
          text:query (rv:privateSearchBody ${lit('privateBody:*')} 2) .
      }
    }`, 262_144);
  const posting = indexed.results?.bindings ?? [];
  if (posting.length !== 1 || posting[0]?.literal?.value !== projected.body
    || posting[0].literal['xml:lang'] !== projected.language
    || posting[0]?.graph?.value !== PRIVATE_SEARCH_GRAPH
    || posting[0]?.predicate?.value !== `${RV}privateSearchBody`) {
    throw new PrivateContentSearchUnavailable('Content private posting is unavailable');
  }
  const matched = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX text: <http://jena.apache.org/text#> SELECT ?literal ?graph ?predicate WHERE {
      GRAPH ${iri(PRIVATE_SEARCH_GRAPH)} {
        (${iri(projected.unit)} ?score ?literal ?graph ?predicate)
          text:query (rv:privateSearchBody ${lit(lucene)} 2) .
      }
    }`, 262_144);
  const hits = matched.results?.bindings ?? [];
  if (hits.length > 1 || hits.some(row => row.literal?.value !== projected.body
    || row.graph?.value !== PRIVATE_SEARCH_GRAPH
    || row.predicate?.value !== `${RV}privateSearchBody`)) {
    throw new PrivateContentSearchUnavailable('Content private phrase is ambiguous');
  }
  const final = await position(env);
  if (initial.instance !== final.instance || initial.writeEpoch !== final.writeEpoch
    || initial.generation !== final.generation || initial.graphSequence !== final.graphSequence) {
    throw new PrivateContentSearchUnavailable('Content private index moved during query');
  }
  const response = { profile: 'private-content-phrase-v1' as const,
    resultGrain: 'content-variant' as const, resource: input.resource, variant: input.variant,
    complete: true as const, total: hits.length,
    results: hits.length === 1 ? [{ matchUnit: projected.unit,
      resource: input.resource, variant: input.variant, revision: head.revisionId,
      field: 'body' as const, language: projected.language }] : [],
    sourcePosition: head.position, indexGeneration: initial.generation };
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > CONTENT_PRIVATE_SEARCH_COST.resultBytes) {
    throw new PrivateContentSearchUnavailable('Content private result exceeds budget');
  }
  return { response, position: final, revision: head.revisionId, ownerEpoch: head.position.dataEpoch };
}

/** Account verifies the caller before this method; Access commits the read
 * before any Content byte or text posting is accessed. */
export async function prepareAdmittedPrivateContentPhrase(env: WorkActivationEnvironment,
  content: ContentCore, access: ContentSearchReadAccess,
  settlement: Pick<PrivateSearchSettlement, 'settle'>,
  principal: VerifiedPrincipal, actingSubject: string,
  input: PrivateContentPhraseInput, platformAccess?: Pick<AccessExposure, 'require'>): Promise<PrivateSearchReceiptSession> {
  const phrase = phraseOf(input);
  const checkSelectedCapability = async () => {
    for (const exposure of await resolvedSemanticCapabilities(env, [input.resource]))
      await requireSelectedPlatformCapability(platformAccess, principal,
        { exposure, operationId: 'wsV1Private-content-queries' });
  };
  await checkSelectedCapability();
  const lease = await access.admit(principal, actingSubject, input.resource, input.variant);
  let prepared: Awaited<ReturnType<typeof candidate>>;
  try { prepared = await candidate(env, content, input, phrase); }
  catch (error) {
    await access.finish(lease.id, 'aborted');
    throw error;
  }
  const delivery = {
    armContributionSearchSend: (id: string, token: string) =>
      access.arm(id, token, principal, actingSubject, input.resource, input.variant),
    finishContributionSearchRead: (id: string, outcome: 'delivered' | 'aborted', token?: string) =>
      access.finish(id, outcome, token),
  };
  return new PrivateSearchReceiptSession(delivery, lease.id, prepared.response, async () => {
    await access.begin(lease.id, principal, actingSubject, input.resource, input.variant);
  }, { settlement,
    messageTypes: { result: 'private-content-result-v1', receipt: 'private-content-receipt-v1' },
    afterArm: async () => {
      await checkSelectedCapability();
      const [current, graph] = await Promise.all([
        content.readDraftHead(input.resource, input.variant), position(env),
      ]);
      if (!current || current.revisionId !== prepared.revision
        || current.position.dataEpoch !== prepared.ownerEpoch
        || graph.instance !== prepared.position.instance
        || graph.writeEpoch !== prepared.position.writeEpoch
        || graph.generation !== prepared.position.generation
        || graph.graphSequence !== prepared.position.graphSequence) {
        throw new PrivateContentSearchUnavailable('Content private source moved before delivery');
      }
    } });
}
