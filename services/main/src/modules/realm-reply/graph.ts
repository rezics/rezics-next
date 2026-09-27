import type { GraphTerminalProof, RegisteredAdmission } from '../access/admission.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { RealmReplyStale, RealmReplyUnavailable,
  type PlacementPreparation } from './content-store.ts';
import { receiptFamilies } from './receipt-family.ts';
import { unerased } from '../work/public-patterns.ts';

const PROFILE = 'https://rezics.com/definition/realm-reply-placement-v1';
const NONE = 'urn:rezics:none';
const CONTENT_REVISION = 'urn:rezics:content:revision:';

export function replySlotIri(realm: string, reply: string): string {
  return `urn:rezics:realm-reply-slot:${hash(`${realm}\0${reply}`)}`;
}
export function replyReceiptIri(admission: Pick<RegisteredAdmission, 'id' | 'action'>): string {
  const family = receiptFamilies[admission.action as keyof typeof receiptFamilies];
  if (!family) throw new RealmReplyUnavailable('unknown Realm reply receipt family');
  return `urn:rezics:receipt:${hash(`${admission.id}\0${family}`)}`;
}

export interface ReplyGraphReceipt extends GraphTerminalProof {
  placement?: string;
  revisionId?: string;
  realm?: string;
  reply?: string;
  predecessor?: string | null;
}

export async function readReplyGraphReceipt(env: WorkActivationEnvironment,
  admission: Pick<RegisteredAdmission, 'id' | 'action'>): Promise<ReplyGraphReceipt | null> {
  const receipt = replyReceiptIri(admission);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?placement ?revision ?realm ?reply ?predecessor WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ;
        rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:placement ?placement ;
        rv:contentRevision ?revision ; rv:realm ?realm ; rv:reply ?reply .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?predecessor } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RealmReplyUnavailable('reply receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')) {
    throw new RealmReplyUnavailable('reply receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!, dataEpoch: value('dataEpoch')!,
    sequence: value('sequence')!, ...(value('placement') ? {
      placement: value('placement'), revisionId: value('revision')?.replace(CONTENT_REVISION, ''), realm: value('realm'),
      reply: value('reply'), predecessor: value('predecessor') ?? null } : {}) };
}

function checked(receipt: ReplyGraphReceipt, admission: RegisteredAdmission): ReplyGraphReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== admission.requestDigest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new RealmReplyUnavailable('reply graph receipt differs from Access admission');
  }
  return receipt;
}

/** A Content-owned reply/review decision receives a graph terminal receipt for
 * the existing Access sealer. The graph receipt does not duplicate that fact. */
export async function acknowledgeContentDecision(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<ReplyGraphReceipt> {
  const prior = await readReplyGraphReceipt(env, admission);
  if (prior) return checked(prior, admission);
  const receipt = replyReceiptIri(admission);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous command by its receipt */ }
  const terminal = await readReplyGraphReceipt(env, admission);
  if (!terminal) throw new RealmReplyUnavailable('Content decision receipt outcome is unknown');
  return checked(terminal, admission);
}

/** Terminal cancellation lets Content release a prepared pin and Access seal a
 * claimed admission when the graph CAS cannot accept this revision. */
export async function cancelPlacement(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<ReplyGraphReceipt> {
  const prior = await readReplyGraphReceipt(env, admission);
  if (prior) return checked(prior, admission);
  const receipt = replyReceiptIri(admission);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous command by its receipt */ }
  const terminal = await readReplyGraphReceipt(env, admission);
  if (!terminal) throw new RealmReplyUnavailable('placement cancellation outcome is unknown');
  return checked(terminal, admission);
}

export interface PlacementHead {
  placement: string; revisionId: string; reviewDecisionId: string; reply: string;
  realm: string; rootTarget: string; author: string; preparationId: string;
}

/** One bounded Realm/root probe. The caller filters exact current Content
 * approvals before exposing a count; 65th row signals an incomplete page. */
export async function readRootPlacementHeads(env: WorkActivationEnvironment,
  realm: string, rootTarget: string): Promise<{ heads: PlacementHead[]; complete: boolean }> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?reply ?placement ?revision ?review ?author ?preparation WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?slot a rv:RealmReplySlot ; rv:realm ${iri(realm)} ;
        rv:rootTarget ${iri(rootTarget)} ; rv:reply ?reply ;
        rv:replyPlacementHead ?placement . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?placement a rv:RealmReplyPlacement ; rv:realm ${iri(realm)} ;
        rv:reply ?reply ; rv:rootTarget ${iri(rootTarget)} ;
        rv:rootRevision ?rootRevision ;
        rv:contentRevision ?revision ; rv:reviewDecision ?review ;
        rv:author ?author ; rv:contentPreparation ?preparation ; rv:placementOutcome rv:Accepted . }
    BIND(IRI(?rootRevision) AS ?rootAnchor)
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootAnchor a rv:ErasedRevision } }
    ${unerased(iri(rootTarget))}
  } ORDER BY ?reply LIMIT 65`);
  const rows = result.results?.bindings;
  if (!rows) throw new RealmReplyUnavailable('Realm root placement query is incomplete');
  const heads = rows.slice(0, 64).map(row => {
    const revision = row.revision?.value ?? '';
    const review = row.review?.value ?? '';
    if (!revision.startsWith(CONTENT_REVISION) || !review.startsWith('urn:rezics:realm-review:')
      || !row.reply?.value || !row.placement?.value || !row.author?.value || !row.preparation?.value) {
      throw new RealmReplyUnavailable('Realm root placement row is malformed');
    }
    return { realm, rootTarget, reply: row.reply.value, placement: row.placement.value,
      revisionId: revision.slice(CONTENT_REVISION.length),
      reviewDecisionId: review.slice('urn:rezics:realm-review:'.length),
      author: row.author.value, preparationId: row.preparation.value };
  });
  return { heads, complete: rows.length <= 64 };
}

export async function readPlacementHead(env: WorkActivationEnvironment,
  realm: string, reply: string): Promise<PlacementHead | null> {
  const slot = replySlotIri(realm, reply);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?placement ?revision ?review ?root ?author ?preparation WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:replyPlacementHead ?placement . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?placement a rv:RealmReplyPlacement ; rv:realm ${iri(realm)} ;
        rv:reply ${iri(reply)} ; rv:rootTarget ?root ; rv:author ?author ;
        rv:rootRevision ?rootRevision ;
        rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:contentPreparation ?preparation ;
        rv:placementOutcome rv:Accepted . }
    BIND(IRI(?rootRevision) AS ?rootAnchor)
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootAnchor a rv:ErasedRevision } }
    ${unerased('?root')}
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new RealmReplyUnavailable('reply slot has multiple heads');
  const row = rows[0]!;
  const review = row.review?.value ?? '';
  if (!review.startsWith('urn:rezics:realm-review:')) {
    throw new RealmReplyUnavailable('placement review identity is invalid');
  }
  if (!row.revision?.value.startsWith(CONTENT_REVISION) || !row.preparation?.value) {
    throw new RealmReplyUnavailable('placement Content revision is invalid');
  }
  return { placement: row.placement!.value, revisionId: row.revision.value.slice(CONTENT_REVISION.length),
    reviewDecisionId: review.slice('urn:rezics:realm-review:'.length), reply, realm,
    rootTarget: row.root!.value, author: row.author!.value, preparationId: row.preparation.value };
}

/** Exact, one-slot graph CAS. A different Realm has a different slot and count. */
export async function placeReply(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, preparation: PlacementPreparation,
  expectedHead: string | null): Promise<ReplyGraphReceipt> {
  const prior = await readReplyGraphReceipt(env, admission);
  if (prior) return checked(prior, admission);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new RealmReplyStale('placement admission expired before graph dispatch');
  }
  const slot = replySlotIri(preparation.realm, preparation.reply);
  const current = await readPlacementHead(env, preparation.realm, preparation.reply);
  if ((current?.placement ?? null) !== expectedHead) {
    throw new RealmReplyStale('Realm reply placement head moved');
  }
  const placement = ID + Bun.randomUUIDv7();
  const receipt = replyReceiptIri(admission);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(placement)}`;
  const optionalParent = preparation.parentReply && preparation.parentRevision
    ? `rv:parentReply ${iri(preparation.parentReply)} ;
       rv:parentRevision ${lit(preparation.parentRevision)} ;` : '';
  const optionalContext = preparation.contextRevision
    ? `rv:contextRevision ${iri(preparation.contextRevision)} ;` : '';
  const predecessor = expectedHead ? `rv:previousPlacement ${iri(expectedHead)} ;` : '';
  const receiptPredecessor = expectedHead ? `rv:expectedHead ${iri(expectedHead)} ;` : '';
  const parentGuard = preparation.parentReply && preparation.parentRevision ? `
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(replySlotIri(preparation.realm, preparation.parentReply))} rv:replyPlacementHead ?parentHead . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?parentHead rv:placementOutcome rv:Accepted ;
        rv:contentRevision ${iri(CONTENT_REVISION + preparation.parentRevision)} . }` : '';
  const validations = await profileValidations(env.fuseki, 'realm-reply-placement-v1', [{
    shape: `${PROFILE}/slot-shape`, focus: [slot], graphs: [GRAPHS.current],
  }, {
    shape: `${PROFILE}/placement-shape`, focus: [placement],
    graphs: [GRAPHS.current, GRAPHS.revisions],
  }], { slot, placement, realm: preparation.realm, reply: preparation.reply,
    root: preparation.rootTarget, revision: CONTENT_REVISION + preparation.revisionId,
    review: preparation.reviewDecisionId, author: preparation.author,
    actor: admission.actingSubject, receipt, scope: admission.scope,
    epoch: admission.authorityEpoch });
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
      validations, deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      DELETE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:replyPlacementHead ?prior }
      }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(slot)} a rv:RealmReplySlot ; rv:realm ${iri(preparation.realm)} ;
            rv:reply ${iri(preparation.reply)} ; rv:rootTarget ${iri(preparation.rootTarget)} ;
            rv:replyPlacementHead ${iri(placement)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(placement)} a rv:RealmReplyPlacement ;
            rv:component ${iri(slot)} ;
            rv:realm ${iri(preparation.realm)} ; rv:reply ${iri(preparation.reply)} ;
            rv:rootTarget ${iri(preparation.rootTarget)} ;
            rv:rootRevision ${lit(preparation.rootRevision)} ;
            rv:author ${iri(preparation.author)} ;
            ${optionalParent}${optionalContext}
            rv:contentRevision ${iri(CONTENT_REVISION + preparation.revisionId)} ;
            rv:contentDigest ${lit(preparation.revisionDigest)} ;
            rv:byteDigest ${lit(preparation.revisionDigest)} ;
            rv:contentPreparation ${lit(preparation.operationId)} ;
            rv:ownerDataEpoch ${lit(preparation.ownerDataEpoch)} ;
            rv:ownerSequence ${preparation.ownerSequence} ;
            rv:reviewDecision ${iri(`urn:rezics:realm-review:${preparation.reviewDecisionId}`)} ;
            rv:reviewDigest ${lit(preparation.reviewDigest)} ;
            rv:placementOutcome rv:Accepted ; ${predecessor}
            rv:decidedBy ${iri(admission.actingSubject)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:sequence ?next .
        }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:placement ${iri(placement)} ;
          rv:contentRevision ${iri(CONTENT_REVISION + preparation.revisionId)} ;
          rv:byteDigest ${lit(preparation.revisionDigest)} ;
          rv:contentPreparation ${lit(preparation.operationId)} ;
          rv:ownerDataEpoch ${lit(preparation.ownerDataEpoch)} ;
          rv:ownerSequence ${preparation.ownerSequence} ;
          rv:realm ${iri(preparation.realm)} ; rv:reply ${iri(preparation.reply)} ;
          ${receiptPredecessor}rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:RealmReplyPlacedEvent ; rv:ordinal 0 ;
          rv:action "reply.place" ; rv:receipt ${iri(receipt)} ;
          rv:realm ${iri(preparation.realm)} ; rv:reply ${iri(preparation.reply)} . }
      }
      WHERE {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(preparation.realm)} a rv:Realm ; rv:realmState rv:Active .
          ${iri(preparation.rootTarget)} a schema:CreativeWork .
          OPTIONAL { ${iri(slot)} rv:replyPlacementHead ?prior }
        }
        ${preparation.directPolicyRevision ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(preparation.realm)} ${preparation.directPolicyRevision.startsWith('urn:rezics:realm-policy:')
            ? 'rv:realmPolicyHead' : 'rv:publicProfileHead'} ${iri(preparation.directPolicyRevision)} }` : ''}
        ${parentGuard}
        FILTER(COALESCE(?prior, ${iri(NONE)}) = ${iri(expectedHead ?? NONE)})
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next)
      }` }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile') {
      throw new CommandRejected(result);
    }
  } catch (error) { updateError = error; }
  const terminal = await readReplyGraphReceipt(env, admission);
  if (!terminal && preparation.directPolicyRevision) {
    const currentPolicy = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(preparation.realm)}
        ${preparation.directPolicyRevision.startsWith('urn:rezics:realm-policy:')
          ? 'rv:realmPolicyHead' : 'rv:publicProfileHead'} ${iri(preparation.directPolicyRevision)} } }`);
    if (currentPolicy.boolean !== true) throw new RealmReplyStale('Realm reply policy changed');
  }
  if (!terminal) throw new RealmReplyUnavailable(updateError
    ? 'placement graph command outcome is unknown'
    : 'placement graph guard did not match');
  checked(terminal, admission);
  if (terminal.outcome === 'cancelled') return terminal;
  if (terminal.realm !== preparation.realm
    || terminal.reply !== preparation.reply || terminal.revisionId !== preparation.revisionId
    || terminal.predecessor !== expectedHead) {
    throw new RealmReplyUnavailable('placement receipt targets another intent');
  }
  return terminal;
}
