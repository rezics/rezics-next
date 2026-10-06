import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from './admission.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { publicWork, unerased } from '../work/public-patterns.ts';
import { publicPost } from '../post/patterns.ts';
import { baselineMemberProof } from './baseline.ts';
import { platformAdministratorProof } from './platform-administrator.ts';
import { SEMANTIC_TERMS } from '../semantic/schema.ts';
import { inAccessTransaction, requireRecoveryOpen } from './policy-transaction.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const SEMANTIC_DISCLOSURE_LIMIT = 65;
export interface SemanticDisclosureClient {
  pool: Pool;
  graph?: Pick<FusekiClient, 'query'>;
}
export interface SemanticDisclosure {
  public: ReadonlySet<string>;
  granted: ReadonlySet<string>;
}

/** A semantic editor may restrict or unrestrict that same resource. Reuse the existing edit
 * mandate/grant as the policy revision's durable publication basis. */
export async function semanticPolicyAuthority(client: PoolClient, principalId: string,
  actor: string, scope: string) {
  const resource = scope.startsWith('semantic:read:') ? scope.slice('semantic:read:'.length) : '';
  if (!nativeId.test(resource)) return null;
  const row = (await client.query<{ mandate: string; mandate_generation: string;
    grant: string; grant_generation: string }>(`SELECT represented.id AS mandate,
      represented.generation AS mandate_generation, granted.id AS grant,
      granted.generation AS grant_generation
    FROM access.scope_gate gate JOIN access.authority_subject subject ON subject.id = $2 AND subject.active
    JOIN LATERAL (SELECT id, generation FROM access.representation
      WHERE principal_id = $1 AND subject_id = subject.id AND action = 'semantic.change'
        AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) represented ON true
    JOIN LATERAL (SELECT id, generation FROM access.permission_grant
      WHERE recipient_subject = subject.id AND scope_id = gate.id AND action = 'semantic.change'
        AND active AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) granted ON true
    WHERE gate.id = $3 AND gate.open FOR SHARE OF gate, subject`,
  [principalId, actor, `semantic:edit:${resource}`])).rows[0];
  return row ? { mandate: { id: row.mandate, generation: row.mandate_generation },
    grant: { id: row.grant, generation: row.grant_generation } } : null;
}

/** Without a baseline graph "not public" would be a guess that hides every public resource. */
export function requireDisclosureGraph(graph: Pick<FusekiClient, 'query'> | undefined) {
  if (!graph) throw new Error('public disclosure needs a baseline graph: call configureBaseline(fuseki) at composition');
  return graph;
}

function checkedRefs(refs: readonly string[]) {
  if (refs.length > SEMANTIC_DISCLOSURE_LIMIT || refs.some(ref => !nativeId.test(ref))) {
    throw new RangeError('semantic disclosure batch exceeds its profile');
  }
  return [...new Set(refs)];
}

/** Access owns public semantic disclosure. At most 65 exact resources, one
 * bounded Jena query (65 rows / 32 KiB) and one indexed policy/gate lookup.
 * EXISTS keeps multiple Work links from multiplying the result population.
 * Only the current committed active head qualifies, never staging or history. */
export async function publicSemantics(client: SemanticDisclosureClient, refs: readonly string[],
  revision?: string): Promise<ReadonlySet<string>> {
  const unique = checkedRefs(refs);
  if (!unique.length) return new Set();
  const graph = requireDisclosureGraph(client.graph);
  if (revision !== undefined && !nativeId.test(revision)) return new Set();
  return inAccessTransaction(client.pool, 'read committed', async access => {
    await requireRecoveryOpen(access, true);
    return publicInTransaction(access, graph, unique, revision);
  });
}

/** The same disclosure proof inside an already fenced Access transaction,
 * including baseline reply roots. No nested checkout or independent policy. */
export async function publicInTransaction(access: PoolClient, graph: Pick<FusekiClient, 'query'>,
  refs: readonly string[], revision?: string): Promise<ReadonlySet<string>> {
  checkedRefs(refs);
  const rows = (await graph.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?resource WHERE {
      VALUES ?resource { ${refs.map(iri).join(' ')} }
      {
        GRAPH ${iri(GRAPHS.current)} { ?resource rv:semanticHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:SemanticRevision . }
        FILTER EXISTS {
          GRAPH ${iri(GRAPHS.current)} { ?resource <${SEMANTIC_TERMS.semanticWork}> ?work . }
          ${publicWork('?work', '?main')}
        }
      } UNION {
        # Relation definitions are public vocabulary; other resources still need a public Work.
        GRAPH ${iri(GRAPHS.current)} { ?resource a rv:SemanticDefinition ;
          rv:definitionKind rv:RelationDefinition ; rv:definitionHead ?head . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ;
          rv:definitionKind rv:RelationDefinition . }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ;
        rv:component ?resource ; rv:lifecycle rv:Active ; rv:sequence ?sequence . }
      ${revision ? `FILTER(?head = ${iri(revision)})` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?resource rv:protectionHead ?protection } }
      # A Work's own description never discloses the Work: Work disclosure has its own owner.
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?resource a schema:CreativeWork } }
    } LIMIT ${refs.length + 1}`, 32_768)).results?.bindings ?? [];
  const candidates = rows.map(row => row.resource?.value);
  if (candidates.length > refs.length || candidates.some(ref => !ref || !refs.includes(ref))
    || new Set(candidates).size !== candidates.length) throw new Error('semantic disclosure result is ambiguous');
  // A missing gate is unrestricted; only an explicit strong closure denies.
  const allowed = await access.query<{ resource: string }>(`SELECT wanted.resource
    FROM unnest($1::text[]) AS wanted(resource)
    WHERE NOT EXISTS (SELECT 1 FROM access.scope_gate
      WHERE id = 'semantic:read:' || wanted.resource AND NOT open)
      AND NOT EXISTS (SELECT 1 FROM access.policy
        WHERE scope_id = 'semantic:read:' || wanted.resource AND ended_at IS NULL)`, [candidates]);
  return new Set(allowed.rows.map(row => row.resource));
}

/** Public and explicit-grant outcomes stay separate so summaries cannot label a
 * granted restriction public. The private path uses one indexed batch query;
 * relation vocabulary is the sole type exception to the public Work link;
 * containers, Contexts and other semantic types supply no read authority. */
export async function readSemanticDisclosure(client: SemanticDisclosureClient,
  principal: VerifiedPrincipal | null, actor: string | null, refs: readonly string[]): Promise<SemanticDisclosure> {
  const unique = checkedRefs(refs);
  if (!unique.length) return { public: new Set(), granted: new Set() };
  const graph = requireDisclosureGraph(client.graph);
  return inAccessTransaction(client.pool, 'read committed', async access => {
    await requireRecoveryOpen(access, true);
    const publicRefs = await publicInTransaction(access, graph, unique);
    if (!principal || !actor || !nativeId.test(actor)) return { public: publicRefs, granted: new Set() };
    const rows = await access.query<{ resource: string }>(`SELECT wanted.resource
      FROM unnest($3::text[]) AS wanted(resource)
      JOIN access.scope_gate gate ON gate.id = 'semantic:read:' || wanted.resource AND gate.open
      JOIN access.principal principal ON principal.account_issuer = $1
        AND principal.account_subject = $2 AND principal.active
      JOIN access.authority_subject subject ON subject.id = $4 AND subject.active
      JOIN LATERAL (SELECT id FROM access.representation WHERE principal_id = principal.id
        AND subject_id = subject.id AND action = 'semantic.read' AND active
        AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) represented ON true
      JOIN LATERAL (SELECT id FROM access.permission_grant WHERE recipient_subject = subject.id
        AND scope_id = gate.id AND action = 'semantic.read' AND active
        AND valid_until > clock_timestamp() ORDER BY id LIMIT 1 FOR SHARE) granted ON true
      FOR SHARE OF gate, principal, subject`, [principal.issuer, principal.subject, unique, actor]);
    return { public: publicRefs, granted: new Set(rows.rows.map(row => row.resource)) };
  });
}

export const REFERENCE_DISCLOSURE_COST = {
  resources: SEMANTIC_DISCLOSURE_LIMIT,
  graphReads: 5,
  receiptRowsPerResource: 2,
  receiptBytesPerResource: 4096,
} as const;
type ReceiptProof = { resource: string; admission: string; receipt: string; digest: string };

/** Keep the scalar creator proofs' two-row ambiguity probe for each exact
 * target. A single page query cannot let one damaged target truncate its peers. */
async function referenceReceipts(
  graph: Pick<FusekiClient, 'query'>,
  refs: readonly string[],
  pattern: (resource: string) => string,
  strictAdmission = false,
): Promise<ReceiptProof[]> {
  if (!refs.length) return [];
  const rows =
    (
      await graph.query(
        `PREFIX rv: <${RV}>
    SELECT ?resource ?admission ?receipt ?digest WHERE {
      ${refs
        .map(
          (ref) => `{ SELECT ?resource ?admission ?receipt ?digest WHERE {
        BIND(${iri(ref)} AS ?resource) ${pattern(iri(ref))} } LIMIT 2 }`,
        )
        .join(' UNION ')}
    }`,
    (refs.length + 1) * REFERENCE_DISCLOSURE_COST.receiptBytesPerResource,
      )
    ).results?.bindings ?? [];
  if (
    rows.length > refs.length * 2 ||
    rows.some((row) => !refs.includes(row.resource?.value ?? ''))
  ) {
    throw new Error('reference receipt batch is incomplete');
  }
  return refs.flatMap((resource) => {
    const candidates = rows.filter((row) => row.resource?.value === resource);
    const row = candidates[0];
    const admission = strictAdmission
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      : /^[0-9a-f-]{36}$/;
    return candidates.length === 1 &&
      row?.admission &&
      admission.test(row.admission.value) &&
      row.receipt &&
      /^urn:rezics:receipt:[0-9a-f]{64}$/.test(row.receipt.value) &&
      row.digest &&
      /^[0-9a-f]{64}$/.test(row.digest.value)
      ? [
          {
            resource,
            admission: row.admission.value,
            receipt: row.receipt.value,
            digest: row.digest.value,
          },
        ]
      : [];
  });
}

function definitionReceiptPattern(resource: string) {
  return `GRAPH ${iri(GRAPHS.current)} { ${resource} a rv:SemanticDefinition ; rv:definitionHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:DefinitionRevision ; rv:component ${resource} ; rv:lifecycle rv:Active . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${resource} rv:protectionHead ?protection } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision } }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:component ${resource} ; rv:revision ?first ;
      rv:admittedScope "semantic:create:root" ; rv:admissionId ?admission ;
      rv:requestDigest ?digest ; rv:outcome rv:Succeeded . }
    GRAPH ${iri(GRAPHS.revisions)} { ?first a rv:DefinitionRevision ; rv:component ${resource} . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?first rv:predecessor ?predecessor } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:expectedHead ?expected } }`;
}

function zoneReceiptPattern(resource: string, actor: string) {
  return `GRAPH ${iri(GRAPHS.current)} {
      { BIND(${resource} AS ?zone) ?zone a rv:Zone ; rv:space ?space }
      UNION { BIND(${resource} AS ?space) ?space rv:zoneCapability ?zone }
      ?space a rv:Space ; rv:owner ${iri(actor)} ; rv:zoneCapability ?zone .
      ?zone a rv:Zone ; rv:space ?space .
      FILTER NOT EXISTS { ?space rv:protectionHead ?spaceProtection }
      FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection }
    }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:admittedScope "space:create:root" ; rv:space ?space ; rv:zone ?zone ;
      rv:owner ${iri(actor)} ; rv:admissionId ?admission ; rv:requestDigest ?digest . }`;
}

type AuthorReference = {
  resource: string;
  main_version: string;
  action: string;
  scope_id: string;
  creation_admission: string;
  graph_receipt: string;
  request_digest: string;
};

/** The same public, explicit-grant, administrator, Zone creator, Collection
 * curator and Work member/author decisions as referenceReader. At most 65
 * exact references, five graph requests and a fixed number of indexed Access
 * batches. All gates and authority proofs share one recovery-fenced transaction;
 * nothing is cached beyond this page. A closed semantic scope does not close
 * the independent Work read scope, and a missing gate only denies grants. */
export async function readReferenceDisclosure(
  client: SemanticDisclosureClient,
  principal: VerifiedPrincipal | null,
  actor: string | null,
  refs: readonly string[],
): Promise<ReadonlySet<string>> {
  if (refs.length > SEMANTIC_DISCLOSURE_LIMIT)
    throw new RangeError('semantic disclosure batch exceeds its profile');
  // The scalar semantic/Work readers deny non-native references without a read.
  const unique = [...new Set(refs.filter((ref) => nativeId.test(ref)))];
  if (!unique.length) return new Set();
  const graph = requireDisclosureGraph(client.graph);
  return inAccessTransaction(client.pool, 'read committed', async (access) => {
    await requireRecoveryOpen(access, true);
    const allowed = new Set(await publicInTransaction(access, graph, unique));
    if (!principal || !actor || !nativeId.test(actor)) return allowed;
    const remaining = unique.filter((ref) => !allowed.has(ref));
    if (!remaining.length) return allowed;
    const identity = (
      await access.query<{ id: string }>(
        `SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
        [principal.issuer, principal.subject],
      )
    ).rows[0];
    if (!identity) return allowed;
    const scopes = remaining.flatMap((ref) => [`semantic:read:${ref}`, `work:read:${ref}`]);
    const gates = (
      await access.query<{ id: string; open: boolean }>(
        `SELECT id, open
      FROM access.scope_gate WHERE id = ANY($1::text[]) FOR SHARE`,
        [scopes],
      )
    ).rows;
    const closed = new Set(gates.filter((gate) => !gate.open).map((gate) => gate.id));
    // Ended policies also exclude baseline authority, just as the scalar reader does.
    const policies = new Set(
      (
        await access.query<{ scope_id: string }>(
          `SELECT scope_id
      FROM access.policy WHERE scope_id = ANY($1::text[])`,
          [scopes],
        )
      ).rows.map((row) => row.scope_id),
    );
    const grants = (
      await access.query<{ resource: string }>(
        `SELECT wanted.resource
      FROM unnest($3::text[]) AS wanted(resource)
      CROSS JOIN (VALUES ('semantic:read:', 'semantic.read'), ('work:read:', 'work.read')) AS kind(prefix, action)
      JOIN access.scope_gate gate ON gate.id = kind.prefix || wanted.resource AND gate.open
      JOIN access.authority_subject subject ON subject.id = $2 AND subject.active
      JOIN LATERAL (SELECT id FROM access.representation WHERE principal_id = $1
        AND subject_id = $2 AND action = kind.action AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE) represented ON true
      JOIN LATERAL (SELECT id FROM access.permission_grant WHERE recipient_subject = $2
        AND scope_id = gate.id AND action = kind.action AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE) granted ON true
      FOR SHARE OF gate, subject`,
        [identity.id, actor, remaining],
      )
    ).rows;
    for (const row of grants) allowed.add(row.resource);
    const eligible = (prefix: string) =>
      remaining.filter(
        (ref) =>
          !allowed.has(ref) && !closed.has(`${prefix}${ref}`) && !policies.has(`${prefix}${ref}`),
      );
    const semantic = eligible('semantic:read:'),
      works = eligible('work:read:');
    if (!semantic.length && !works.length) return allowed;
    const administrator = semantic.length
      ? !!(await platformAdministratorProof(access, identity.id, actor,true,{ action: 'semantic.read',scope: 'semantic:read:*' }))
      : false;
    const member =
      principal.emailVerified === true && !!(await baselineMemberProof(access, identity.id, actor));
    const definitions = administrator
      ? await referenceReceipts(graph, semantic, definitionReceiptPattern, true)
      : [];
    if (definitions.length) {
      const rows = (
        await access.query<{ resource: string }>(
          `SELECT proof.resource
        FROM jsonb_to_recordset($1::jsonb) AS proof(resource text, admission uuid, receipt text, digest text)
        JOIN access.admission a ON a.id = proof.admission AND a.principal_id = $2 AND a.acting_subject = $3
          AND a.action = 'semantic.change' AND a.scope_id = 'semantic:create:root'
          AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
          AND a.graph_receipt = proof.receipt AND a.request_digest = proof.digest FOR SHARE OF a`,
          [JSON.stringify(definitions), identity.id, actor],
        )
      ).rows;
      for (const row of rows) allowed.add(row.resource);
    }
    const zones = await referenceReceipts(
      graph,
      semantic.filter((ref) => !allowed.has(ref)),
      (resource) => zoneReceiptPattern(resource, actor),
    );
    if (zones.length) {
      const rows = (
        await access.query<{ resource: string }>(
          `SELECT proof.resource
        FROM jsonb_to_recordset($1::jsonb) AS proof(resource text, admission uuid, receipt text, digest text)
        JOIN access.admission a ON a.id = proof.admission AND a.principal_id = $2 AND a.acting_subject = $3
          AND a.action = 'space.create' AND a.scope_id = 'space:create:root'
          AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
          AND a.graph_receipt = proof.receipt AND a.request_digest = proof.digest
        JOIN LATERAL (SELECT r.id FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id
          WHERE r.principal_id = a.principal_id AND r.subject_id = a.acting_subject
            AND r.action = 'agent.control' AND r.active AND r.valid_until > clock_timestamp()
            AND s.kind = 'agent' AND s.active ORDER BY r.id LIMIT 1 FOR SHARE OF r,s) controlled ON true
        FOR SHARE OF a`,
          [JSON.stringify(zones), identity.id, actor],
        )
      ).rows;
      for (const row of rows) allowed.add(row.resource);
    }
    const patterns = [
      ...(administrator
        ? semantic
            .filter((ref) => !allowed.has(ref))
            .map(
              (ref) => `{
        BIND(${iri(ref)} AS ?resource) FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?resource a rv:Zone ; rv:space ?space . ?space a rv:Space ; rv:owner ${iri(actor)} . } } }`,
            )
        : []),
      ...(member
        ? semantic
            .filter((ref) => !allowed.has(ref))
            .map(
              (ref) => `{
        BIND(${iri(ref)} AS ?resource) FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ?resource a ?kind ; rv:curator ${iri(actor)} ; rv:collectionState rv:Active .
          VALUES ?kind { rv:Collection rv:DynamicCollection } } } }`,
            )
        : []),
      ...(member
        ? works
            .filter((ref) => !allowed.has(ref))
            .map(
              (ref) => `{
        BIND(${iri(ref)} AS ?resource) FILTER EXISTS {
          { ${publicWork('?resource', '?main')} } UNION { ${publicPost('?resource')} } } }`,
            )
        : []),
    ];
    if (patterns.length) {
      const rows =
        (
          await graph.query(
            `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT DISTINCT ?resource WHERE { ${patterns.join(' UNION ')} } LIMIT ${remaining.length + 1}`,
            32_768,
          )
        ).results?.bindings ?? [];
      if (
        rows.length > remaining.length ||
        rows.some((row) => !remaining.includes(row.resource?.value ?? ''))
      ) {
        throw new Error('reference baseline batch is ambiguous');
      }
      for (const row of rows) allowed.add(row.resource!.value);
    }
    const authored = member ? works.filter((ref) => !allowed.has(ref)) : [];
    if (authored.length) {
      const proofs = (
        await access.query<AuthorReference>(
          `SELECT s.work AS resource,s.main_version,
        s.creation_admission,a.graph_receipt,a.request_digest,a.action,a.scope_id
        FROM access.work_maintainer_set s JOIN access.work_maintainer m ON m.work = s.work AND m.agent = $3
        JOIN access.admission a ON a.id = s.creation_admission
        WHERE s.work = ANY($1::text[]) AND a.principal_id = $2 AND a.acting_subject = $3
          AND ((a.action = 'work.create' AND a.scope_id = 'work:create:root')
            OR (a.action = 'work.edit' AND a.scope_id LIKE 'work:edit:https://rezics.com/id/%'))
          AND a.state = 'sealed' AND a.graph_outcome = 'succeeded' FOR SHARE OF s`,
          [authored, identity.id, actor],
        )
      ).rows;
      if (proofs.length) {
        const rows =
          (
            await graph.query(
              `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
          SELECT ?resource WHERE { ${proofs
            .map(
              (proof) => `{
            BIND(${iri(proof.resource)} AS ?resource) FILTER EXISTS {
              { GRAPH ${iri(GRAPHS.current)} { ?resource a rv:Post ; rv:head ?head . } }
              ${
                proof.action === 'work.create'
                  ? `UNION { GRAPH ${iri(GRAPHS.current)} {
                ?resource a schema:CreativeWork ; rv:head ?head ; rv:mainVersion ${iri(proof.main_version)} . } }`
                  : ''
              }
              ${unerased('?resource')}
              GRAPH ${iri(GRAPHS.receipts)} { ${iri(proof.graph_receipt)}
                ${
                  proof.action === 'work.create'
                    ? `rv:work ?resource ; rv:mainVersion ${iri(proof.main_version)} ;`
                    : '(rv:post|rv:chapterWork) ?resource ;'
                }
                rv:admissionId ${lit(proof.creation_admission)} ; rv:requestDigest ${lit(proof.request_digest)} ;
                rv:admittedScope ${lit(proof.scope_id)} ; rv:outcome rv:Succeeded . } } }`,
            )
            .join(' UNION ')}
          } LIMIT ${authored.length + 1}`,
              32_768,
            )
          ).results?.bindings ?? [];
        if (
          rows.length > authored.length ||
          rows.some((row) => !authored.includes(row.resource?.value ?? ''))
        ) {
          throw new Error('reference author batch is ambiguous');
        }
        for (const row of rows) allowed.add(row.resource!.value);
      }
    }
    return allowed;
  });
}
