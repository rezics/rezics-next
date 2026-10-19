import { DATASET, GRAPHS, RV, iri, type WorkActivationEnvironment } from './activate.ts';
import {
  authorCreditDigest,
  readAuthorCredit,
  readAuthorCreditReceipt,
  AuthorCreditUnavailable,
  type AuthorCreditReceipt,
  type AuthorCreditValue,
} from './author-credit.ts';
import { nativeCreditDigest } from '../profiles/credits.ts';
import { isNativeCreditRole } from './credit-roles.ts';
import { workEditReceiptIri } from './edit.ts';
import { unerased } from './public-patterns.ts';

const NATIVE =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface CreditOwnerWitness {
  profile: 'work-author-credit-v1' | 'native-agent-credit-v1';
  value: AuthorCreditValue;
  receipt: AuthorCreditReceipt;
}

/** Resolve the original command, not a receipt supplied by the caller. Current
 * and revision fields must agree. Legacy Agent records without a confirmer or
 * command receipt cannot attest an authored attribution. No names are read. */
export async function readCreditOwnerWitness(
  env: WorkActivationEnvironment,
  credit: string,
): Promise<CreditOwnerWitness | null> {
  if (!NATIVE.test(credit)) return null;
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?revision ?kind WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(credit)} a ?kind ; rv:creditRevision ?revision .
      VALUES ?kind { rv:AuthorCredit rv:NativeAgentCredit }
      FILTER NOT EXISTS { ${iri(credit)} rv:retiredBy ?retirement }
    } } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  const head = rows[0]?.revision?.value,
    kind = rows[0]?.kind?.value;
  if (rows.length !== 1 || !head || !NATIVE.test(head)) {
    throw new AuthorCreditUnavailable('credit owner head is ambiguous');
  }
  let value: AuthorCreditValue, dataEpoch: string, sequence: string;
  if (kind === `${RV}AuthorCredit`) {
    const native = await readAuthorCredit(env, credit, head);
    if (!native) throw new AuthorCreditUnavailable('credit revision is unavailable');
    value = native;
    dataEpoch = native.dataEpoch;
    sequence = native.sequence;
  } else if (kind === `${RV}NativeAgentCredit`) {
    const profile = 'https://rezics.com/definition/native-agent-credit-v1';
    const agents =
      (
        await env.fuseki.query(
          `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      SELECT ?work ?head ?agent ?role ?actor ?epoch ?sequence WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:NativeAgentCredit ;
          rv:creditRevision ${iri(head)} ; rv:work ?work ; rv:agent ?agent ; schema:roleName ?role .
          FILTER NOT EXISTS { ${iri(credit)} rv:externalKey ?key }
        }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:NativeAgentCreditRevision, rv:RevisionAnchor ;
          rv:component ${iri(credit)} ; rv:work ?work ; rv:workRevision ?head ;
          rv:agent ?agent ; schema:roleName ?role ; rv:confirmedBy ?actor ;
          rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ;
          rv:dataEpoch ?epoch ; rv:sequence ?sequence .
          FILTER NOT EXISTS { ${iri(head)} a rv:ErasedRevision }
          FILTER NOT EXISTS { ${iri(head)} rv:externalKey ?key }
        }
      } LIMIT 2`,
          8192,
        )
      ).results?.bindings ?? [];
    const row = agents[0];
    if (
      agents.length !== 1 ||
      !row ||
      !['work', 'head', 'agent', 'role', 'actor', 'epoch', 'sequence'].every(
        (key) => row[key]?.value !== undefined,
      ) ||
      !isNativeCreditRole(row.role!.value)
    ) {
      throw new AuthorCreditUnavailable('exact native Agent credit is unavailable');
    }
    value = {
      credit,
      revision: head,
      work: row.work!.value,
      expectedHead: row.head!.value,
      actingSubject: row.actor!.value,
      agent: row.agent!.value,
      role: row.role!.value,
      sourceKey: '',
      sourceRoleKey: null,
      nativeOrdinal: 0,
    };
    dataEpoch = row.epoch!.value;
    sequence = row.sequence!.value;
  } else throw new AuthorCreditUnavailable('credit profile is unavailable');

  // Credit creation and retirement both name the credit. Only the unique
  // original successful creation/adoption is an attribution witness.
  const origins =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT DISTINCT ?receipt ?admission (EXISTS {
      GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:nativeCredit ${iri(credit)} }
    } AS ?nativeCommand) WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt (rv:authorCredit|rv:nativeCredit) ${iri(credit)} ; rv:creditRevision ${iri(head)} ;
        rv:admissionId ?admission ; rv:outcome rv:Succeeded .
      FILTER NOT EXISTS { ?receipt rv:retirementReason ?reason }
    } } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  const origin = origins[0],
    admission = origin?.admission?.value;
  if (
    origins.length !== 1 ||
    !admission ||
    !UUID.test(admission) ||
    origin?.receipt?.value !== workEditReceiptIri(admission) ||
    !['true', 'false'].includes(origin.nativeCommand?.value ?? '')
  ) {
    throw new AuthorCreditUnavailable('original credit command receipt is unavailable');
  }
  const receipt = await readAuthorCreditReceipt(env, admission);
  if (
    !receipt ||
    receipt.receipt !== origin.receipt.value ||
    receipt.admissionId !== admission ||
    receipt.credit !== credit ||
    receipt.revision !== head ||
    receipt.work !== value.work ||
    receipt.expectedHead !== value.expectedHead ||
    receipt.scope !== `work:edit:${value.work}` ||
    !NATIVE.test(receipt.sourceIntent) ||
    receipt.dataEpoch !== dataEpoch ||
    receipt.sequence !== sequence ||
    !dataEpoch ||
    !/^(0|[1-9][0-9]*)$/.test(sequence)
  ) {
    throw new AuthorCreditUnavailable('credit command receipt differs from stored revision');
  }
  if (origin.nativeCommand!.value === 'true') {
    const digest = nativeCreditDigest({
      work: value.work,
      credit,
      role: value.role!,
      expectedWorkHead: value.expectedHead,
      actingSubject: value.actingSubject,
      ...(value.agent
        ? { agent: value.agent }
        : {
            ordinal: value.nativeOrdinal,
            participant: {
              kind: 'external-reference',
              provider: value.provider!,
              namespace: value.namespace!,
              key: value.sourceKey,
            },
          }),
    });
    if (
      head !== `https://rezics.com/id/${admission}` ||
      receipt.sourceIntent !== credit ||
      value.sourceRoleKey !== null ||
      receipt.requestDigest !== digest
    ) {
      throw new AuthorCreditUnavailable('native credit command differs from stored attribution');
    }
  } else {
    if (value.agent)
      throw new AuthorCreditUnavailable('Agent source attribution has no installed owner');
    const digests = [authorCreditDigest(value, receipt.sourceIntent)];
    // Historical Open Library author commands omitted the later explicit
    // provider/namespace/role members. No other provider inherits that default.
    if (
      value.provider === 'open-library' &&
      value.namespace === 'author' &&
      value.role === 'author'
    ) {
      digests.push(
        authorCreditDigest(
          { ...value, provider: undefined, namespace: undefined, role: undefined },
          receipt.sourceIntent,
        ),
      );
    }
    if (!digests.includes(receipt.requestDigest)) {
      throw new AuthorCreditUnavailable('source credit command differs from stored attribution');
    }
  }
  return {
    profile: value.agent ? 'native-agent-credit-v1' : 'work-author-credit-v1',
    value,
    receipt,
  };
}

/** A read fence, not a graph transaction. Publication, rights and retained
 * support settlement remain with their owners. Protected/erased/retired credits
 * and a different graph lineage cannot provide a live native witness. */
export async function readCreditOwnerHead(
  env: WorkActivationEnvironment,
  witness: CreditOwnerWitness,
): Promise<{ workHead: string; creditHead: string } | null> {
  const { credit, work } = witness.value;
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?workHead ?creditHead ?epoch ?routing WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a schema:CreativeWork ; rv:head ?workHead .
        ${iri(credit)} rv:work ${iri(work)} ; rv:creditRevision ?creditHead .
        FILTER NOT EXISTS { ${iri(credit)} rv:retiredBy ?retirement }
        FILTER NOT EXISTS { ${iri(credit)} rv:protectionHead ?creditProtection }
      }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?creditHead a rv:ErasedRevision } }
      ${unerased(iri(work))}
    } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  const row = rows[0];
  if (!rows.length) return null;
  if (
    rows.length !== 1 ||
    !row?.workHead ||
    !NATIVE.test(row.workHead.value) ||
    !row.creditHead ||
    !NATIVE.test(row.creditHead.value) ||
    row.epoch?.value !== env.lineage.dataEpoch ||
    row.routing?.value !== env.lineage.routingEpoch
  ) {
    throw new AuthorCreditUnavailable('credit owner head or graph lineage is unavailable');
  }
  return { workHead: row.workHead.value, creditHead: row.creditHead.value };
}
