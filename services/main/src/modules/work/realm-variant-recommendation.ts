import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdmissionDenied, AdmissionUnavailable, type VerifiedPrincipal } from '../access/admission.ts';
import { readExactContributionDraft } from '../contribution/history.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from './activate.ts';
import { InvalidNativeVariant, NativeVariantUnavailable, readNativeMainWork }
  from './native-variants.ts';
import { realmSelectionSlotIri } from './select-realm.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;

export class StaleRealmVariantRecommendation extends Error {}
export class RealmVariantRecommendationConflict extends Error {}

export interface RealmVariantRecommendation {
  contribution: string;
  revision: string;
}

export interface SetRealmVariantRecommendationInput {
  realm: string;
  mainVersion: string;
  contribution: string | null;
  expectedRevision: string | null;
  actingSubject: string;
  idempotencyKey: string;
}

function digest(input: SetRealmVariantRecommendationInput): string {
  if (![input.realm, input.mainVersion, input.actingSubject].every(value => nativeId.test(value))
    || (input.contribution !== null && !nativeId.test(input.contribution))
    || (input.expectedRevision !== null && !uuid.test(input.expectedRevision))
    || !keyPattern.test(input.idempotencyKey)) {
    throw new InvalidNativeVariant('invalid Realm variant recommendation');
  }
  return createHash('sha256').update(JSON.stringify({ family: 'realm-native-variant-recommendation-v1',
    realm: input.realm, mainVersion: input.mainVersion, contribution: input.contribution,
    expectedRevision: input.expectedRevision, actingSubject: input.actingSubject })).digest('hex');
}

/** The graph decision remains authoritative; this record never creates an adoption. */
export async function readRealmVariantDecision(env: WorkActivationEnvironment,
  realm: string, mainVersion: string): Promise<{ work: string;
    kind: 'none' | 'adopted' | 'rejected'; selection: string | null }> {
  if (!nativeId.test(realm) || !nativeId.test(mainVersion)) {
    throw new InvalidNativeVariant('invalid Realm or Main Version identity');
  }
  const work = await readNativeMainWork(env, mainVersion);
  const slot = realmSelectionSlotIri(realm, mainVersion);
  const headQuery = `PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
      ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ${iri(work)} .
      OPTIONAL { ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(realm)} ;
        rv:mainVersion ${iri(mainVersion)} ; rv:selectionHead ?head }
    }
  } LIMIT 3`;
  const result = await env.fuseki.query(headQuery);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new NativeVariantUnavailable('Realm is unavailable or decision is ambiguous');
  const head = rows[0]?.head?.value ?? null;
  if (head !== null && !nativeId.test(head)) {
    throw new NativeVariantUnavailable('Realm decision head is invalid');
  }
  let kind: string | null = null;
  if (head !== null) {
    const decision = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?kind WHERE {
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(head)} a ?kind ; rv:work ${iri(work)} ;
          rv:mainVersion ${iri(mainVersion)} .
        VALUES ?kind { rv:PublicationSelection rv:RealmPublicationRejection }
      }
    } LIMIT 3`);
    const kinds = decision.results?.bindings ?? [];
    if (kinds.length !== 1 || !kinds[0]?.kind?.value) {
      throw new NativeVariantUnavailable('Realm decision is incomplete or ambiguous');
    }
    kind = kinds[0].kind.value;
  }
  const rechecked = await env.fuseki.query(headQuery);
  if (JSON.stringify(rechecked.results?.bindings ?? []) !== JSON.stringify(rows)) {
    throw new NativeVariantUnavailable('Realm decision changed during read');
  }
  return { work, kind: kind === `${RV}PublicationSelection` ? 'adopted'
    : kind === `${RV}RealmPublicationRejection` ? 'rejected' : 'none', selection: head };
}

export async function readRealmAdoptedVariant(env: WorkActivationEnvironment,
  realm: string, mainVersion: string, work: string, selection: string): Promise<{
    contribution: string; publicationDecision: string; selectedDraft: string;
    language: string; author: string; body: string }> {
  const query = `PREFIX rv: <${RV}> SELECT
    ?contribution ?decision ?draft ?language ?author ?body WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
      ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ${iri(work)} .
      ${iri(realmSelectionSlotIri(realm, mainVersion))} rv:selectionHead ${iri(selection)} .
      ?contribution a rv:TextContribution ; rv:work ${iri(work)} ; rv:author ?author .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(selection)} a rv:PublicationSelection ; rv:work ${iri(work)} ;
        rv:mainVersion ${iri(mainVersion)} ; rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:matchUnit ?unit .
    }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit a rv:MatchUnit ; rv:selection ${iri(selection)} ;
        rv:context ${iri(realm)} ; rv:mainVersion ${iri(mainVersion)} ;
        rv:disclosure rv:Public ; rv:language ?language ; rv:searchBody ?body .
    }
  }`;
  const result = await env.fuseki.query(query);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.contribution || !row.decision || !row.draft
    || !row.language || !row.author || !row.body) {
    throw new NativeVariantUnavailable('Realm adoption is unavailable');
  }
  const contribution = row.contribution.value;
  const selectedDraft = row.draft.value;
  const author = row.author.value;
  const language = row.language.value;
  const body = row.body.value;
  const exact = await readExactContributionDraft(env, contribution, selectedDraft, async () => true);
  if (exact.work !== work || exact.author !== author || exact.language !== language
    || exact.body !== body) throw new NativeVariantUnavailable('Realm adoption differs from exact draft');
  const rechecked = await env.fuseki.query(query);
  if (JSON.stringify(rechecked.results?.bindings ?? []) !== JSON.stringify(rows)) {
    throw new NativeVariantUnavailable('Realm adoption changed during read');
  }
  return { contribution, publicationDecision: row.decision.value,
    selectedDraft, language, author, body };
}

/** Access owns a sparse, manager-authorized hint with local CAS and idempotent receipts. */
export class RealmVariantRecommendationStore {
  constructor(private readonly pool: Pool) {}

  async read(realm: string, mainVersion: string): Promise<RealmVariantRecommendation | null> {
    if (!nativeId.test(realm) || !nativeId.test(mainVersion)) {
      throw new InvalidNativeVariant('invalid Realm recommendation identity');
    }
    const result = await this.pool.query<{ contribution: string; revision: string }>(
      `SELECT contribution, revision FROM access.realm_native_variant_recommendation
       WHERE realm = $1 AND main_version = $2`, [realm, mainVersion]);
    return result.rows[0] ?? null;
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    input: SetRealmVariantRecommendationInput): Promise<string> {
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
    const gate = await client.query<{ open: boolean }>(
      'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [`publication:adopt:${input.realm}`]);
    if (gate.rows[0]?.open !== true) throw new AdmissionDenied('Realm manager scope is closed');
    const identity = await client.query<{ id: string }>(
      `SELECT id FROM access.principal WHERE account_issuer = $1
        AND account_subject = $2 AND active FOR SHARE`, [principal.issuer, principal.subject]);
    const principalId = identity.rows[0]?.id;
    if (!principalId) throw new AdmissionDenied('Realm manager principal is inactive');
    const subject = await client.query(
      'SELECT id FROM access.authority_subject WHERE id = $1 AND active FOR SHARE',
      [input.actingSubject]);
    const represented = await client.query(
      `SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2
        AND action = 'publication.adopt' AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE`, [principalId, input.actingSubject]);
    const granted = await client.query(
      `SELECT id FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
        AND action = 'publication.adopt' AND active AND valid_until > clock_timestamp()
        ORDER BY id LIMIT 1 FOR SHARE`, [input.actingSubject, `publication:adopt:${input.realm}`]);
    if (subject.rowCount !== 1 || represented.rowCount !== 1 || granted.rowCount !== 1) {
      throw new AdmissionDenied('Realm manager authority is absent');
    }
    return principalId;
  }

  async set(principal: VerifiedPrincipal, input: SetRealmVariantRecommendationInput,
    eligible: () => Promise<boolean>): Promise<{ recommendation: RealmVariantRecommendation | null;
      replayed: boolean }> {
    const requestDigest = digest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const principalId = await this.authorize(client, principal, input);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([principalId, input.idempotencyKey])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([input.realm, input.mainVersion])]);
      const prior = await client.query<{ request_digest: string; realm: string;
        main_version: string; contribution: string | null; revision: string | null }>(
        `SELECT request_digest, realm, main_version, contribution, revision
         FROM access.realm_native_variant_recommendation_receipt
         WHERE principal_id = $1 AND idempotency_key = $2`,
        [principalId, input.idempotencyKey]);
      if (prior.rowCount) {
        const receipt = prior.rows[0]!;
        if (receipt.request_digest !== requestDigest || receipt.realm !== input.realm
          || receipt.main_version !== input.mainVersion) {
          throw new RealmVariantRecommendationConflict('recommendation key conflicts');
        }
        await client.query('COMMIT');
        return { recommendation: receipt.contribution && receipt.revision
          ? { contribution: receipt.contribution, revision: receipt.revision } : null,
        replayed: true };
      }
      const current = await client.query<{ revision: string }>(
        `SELECT revision FROM access.realm_native_variant_recommendation
         WHERE realm = $1 AND main_version = $2 FOR UPDATE`, [input.realm, input.mainVersion]);
      if ((current.rows[0]?.revision ?? null) !== input.expectedRevision) {
        throw new StaleRealmVariantRecommendation('Realm recommendation revision changed');
      }
      if (input.contribution !== null && !(await eligible())) {
        throw new NativeVariantUnavailable('recommended native variant is unavailable');
      }
      const revision = input.contribution === null ? null : randomUUID();
      if (input.contribution === null) {
        await client.query(`DELETE FROM access.realm_native_variant_recommendation
          WHERE realm = $1 AND main_version = $2`, [input.realm, input.mainVersion]);
      } else {
        await client.query(`INSERT INTO access.realm_native_variant_recommendation
          (realm, main_version, contribution, revision, acting_subject)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (realm, main_version) DO UPDATE SET
          contribution = EXCLUDED.contribution, revision = EXCLUDED.revision,
          acting_subject = EXCLUDED.acting_subject`,
          [input.realm, input.mainVersion, input.contribution, revision, input.actingSubject]);
      }
      await client.query(`INSERT INTO access.realm_native_variant_recommendation_receipt
        (principal_id, idempotency_key, request_digest, realm, main_version, contribution, revision)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [principalId, input.idempotencyKey, requestDigest,
          input.realm, input.mainVersion, input.contribution, revision]);
      await client.query('COMMIT');
      return { recommendation: input.contribution && revision
        ? { contribution: input.contribution, revision } : null, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
