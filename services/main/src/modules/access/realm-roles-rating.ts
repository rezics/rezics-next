import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { GRAPHS, iri, RV } from '../work/activate.ts';
import { ratingQuestionPresentationAction } from './rating-question-presentation.ts';

export function ratingConfigurationAction(action: string): boolean {
  return ['rating.context.create', 'rating.context.policy.set'].includes(action)
    || ratingQuestionPresentationAction(action);
}

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const REALM_RATING_AUTHORITY_COST = {
  graphRows: 2,
  graphBytes: 2048,
  proofRows: 1,
} as const;
export interface RealmRatingProof {
  realm: string;
  realm_epoch: string;
  representation_id: string;
  representation_generation: string;
  grant_id: string;
  grant_generation: string;
  subject_generation: string;
  principal_epoch: string;
}

/** One exact Realm/context lookup. Global contexts cannot inherit Realm roles. */
async function targetRealm(
  graph: Pick<FusekiClient, 'query'> | undefined,
  action: string,
  scope: string,
): Promise<string | null> {
  const prefix =
    action === 'rating.context.create'
      ? 'rating:context:'
      : action === 'rating.context.policy.set'
        ? 'rating:policy:'
        : ratingQuestionPresentationAction(action) ? 'rating:presentation:' : null;
  if (!graph || !prefix || !scope.startsWith(prefix)) return null;
  const target = scope.slice(prefix.length);
  if (!native.test(target)) return null;
  const rows =
    (
      await graph.query(
        `PREFIX rv: <${RV}> SELECT ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${
        action === 'rating.context.create'
          ? `BIND(${iri(target)} AS ?realm)`
          : `${iri(target)} a ?ratingContextKind ; rv:contextState rv:Active ; rv:realm ?realm .
          VALUES ?ratingContextKind { rv:RatingContext ${ratingQuestionPresentationAction(action) ? 'rv:TargetRatingContext rv:ReleaseRatingContext' : ''} }
          ?realm rv:ratingContext ${iri(target)} .`
      }
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
    }
  } LIMIT ${REALM_RATING_AUTHORITY_COST.graphRows}`,
        REALM_RATING_AUTHORITY_COST.graphBytes,
      )
    ).results?.bindings ?? [];
  return rows.length === 1 && native.test(rows[0]?.realm?.value ?? '')
    ? rows[0]!.realm!.value
    : null;
}

/** Indexed, single selected controller/grant. The bounded graph lookup and
 * Access locks cover current Realm ownership, membership bans and revision. */
export async function realmRatingProof(
  client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined,
  principalId: string,
  actor: string,
  action: string,
  scope: string,
  selected?: RealmRatingProof,
): Promise<RealmRatingProof | null> {
  const realm = await targetRealm(graph, action, scope);
  if (!realm || (selected && selected.realm !== realm)) return null;
  const gate = (
    await client.query<{ authority_epoch: string }>(
      `SELECT authority_epoch::text
    FROM access.scope_gate WHERE id = $1 AND open AND dispatch_open FOR SHARE`,
      [`governance:realm:${realm}`],
    )
  ).rows[0];
  if (!gate || (selected && gate.authority_epoch !== selected.realm_epoch)) return null;
  const proof = (
    await client.query<RealmRatingProof>(
      `SELECT $3::text AS realm,$4::text AS realm_epoch,
    r.id AS representation_id,r.generation::text AS representation_generation,
    g.id AS grant_id,g.generation::text AS grant_generation,
    s.generation::text AS subject_generation,p.enforcement_epoch::text AS principal_epoch
    FROM access.principal p JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $2
      AND r.action IN ('agent.control','rating.configure') AND r.active AND r.valid_until > clock_timestamp()
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active AND s.kind = 'agent'
    JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $5
      AND g.action = 'rating.configure' AND g.active AND g.valid_until > clock_timestamp()
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
        WHERE m.id = g.membership_id AND m.member_subject = s.id AND m.state = 'joined'
          AND m.generation = g.membership_generation))
    WHERE p.id = $1 AND p.active
      AND ($6::uuid IS NULL OR r.id = $6 AND r.generation = $7 AND g.id = $8
        AND g.generation = $9 AND s.generation = $10 AND p.enforcement_epoch = $11)
      AND NOT EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind = 'realm'
        AND b.owner_subject = $3 AND b.member_subject = $2 AND b.active
        AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()))
      AND NOT EXISTS (SELECT 1 FROM access.private_membership_ban b WHERE b.kind = 'realm'
        AND b.owner_subject = $3 AND b.principal_id = $1 AND b.active)
    ORDER BY r.id,g.id LIMIT 1 FOR SHARE OF p,r,s,g`,
      [
        principalId,
        actor,
        realm,
        gate.authority_epoch,
        `governance:realm:${realm}`,
        selected?.representation_id ?? null,
        selected?.representation_generation ?? null,
        selected?.grant_id ?? null,
        selected?.grant_generation ?? null,
        selected?.subject_generation ?? null,
        selected?.principal_epoch ?? null,
      ],
    )
  ).rows[0];
  return proof ?? null;
}

export async function savedRealmRatingProof(
  client: PoolClient,
  admissionId: string,
): Promise<RealmRatingProof | null> {
  return (
    (
      await client.query<RealmRatingProof>(
        `SELECT realm,realm_epoch::text,representation_id,
    representation_generation::text,grant_id,grant_generation::text,subject_generation::text,principal_epoch::text
    FROM access.realm_rating_admission WHERE admission_id = $1`,
        [admissionId],
      )
    ).rows[0] ?? null
  );
}

export async function saveRealmRatingProof(
  client: PoolClient,
  admissionId: string,
  proof: RealmRatingProof,
) {
  await client.query(
    `INSERT INTO access.realm_rating_admission (admission_id,realm,realm_epoch,
    representation_id,representation_generation,grant_id,grant_generation,subject_generation,principal_epoch)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      admissionId,
      proof.realm,
      proof.realm_epoch,
      proof.representation_id,
      proof.representation_generation,
      proof.grant_id,
      proof.grant_generation,
      proof.subject_generation,
      proof.principal_epoch,
    ],
  );
}
