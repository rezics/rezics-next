import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { readExactContributionDraft } from '../contribution/history.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_NATIVE_VARIANTS = 64;

export class InvalidNativeVariant extends Error {}
export class NativeVariantUnavailable extends Error {}
export class NativeVariantLimit extends Error {}
export class StaleReaderVariantPreference extends Error {}
export class ReaderVariantIdempotencyConflict extends Error {}

export interface NativeVariant {
  contribution: string;
  publicationDecision: string;
  selectedDraft: string;
  language: string;
  author: string;
}

export interface ReaderVariantPreference {
  contribution: string;
  revision: string;
}

export interface SetReaderVariantPreferenceInput {
  mainVersion: string;
  contribution: string | null;
  expectedRevision: string | null;
  idempotencyKey: string;
}

function checkedMain(mainVersion: string): void {
  if (!nativeId.test(mainVersion)) throw new InvalidNativeVariant('invalid Main Version identity');
}

function preferenceDigest(input: SetReaderVariantPreferenceInput): string {
  checkedMain(input.mainVersion);
  if ((input.contribution !== null && !nativeId.test(input.contribution))
    || (input.expectedRevision !== null && !uuid.test(input.expectedRevision))
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)) {
    throw new InvalidNativeVariant('invalid reader preference command');
  }
  return createHash('sha256').update(JSON.stringify({
    family: 'reader-native-variant-preference-v1', mainVersion: input.mainVersion,
    contribution: input.contribution, expectedRevision: input.expectedRevision,
  })).digest('hex');
}

/** Graph publication, not a reader preference, defines current eligibility. */
export async function readNativeMainWork(env: WorkActivationEnvironment,
  mainVersion: string): Promise<string> {
  checkedMain(mainVersion);
  const linked = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work . }
  }`);
  const links = linked.results?.bindings ?? [];
  if (links.length !== 1 || !links[0]?.work?.value || !nativeId.test(links[0].work.value)) {
    throw new NativeVariantUnavailable('Main Version is unavailable');
  }
  return links[0].work.value;
}

export async function listEligibleNativeVariants(env: WorkActivationEnvironment,
  mainVersion: string, language?: string): Promise<{ work: string; variants: NativeVariant[] }> {
  if (language !== undefined && !languageTag.test(language)) {
    throw new InvalidNativeVariant('invalid content language');
  }
  const work = await readNativeMainWork(env, mainVersion);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?contribution ?decision ?draft ?language ?author WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(work)} rv:mainVersion ${iri(mainVersion)} .
      ?contribution a rv:TextContribution ; rv:work ${iri(work)} ;
        rv:author ?author ; rv:language ?language ; rv:publicationHead ?decision .
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:PublicationDecision ;
      rv:component ?contribution ; rv:work ${iri(work)} ;
      rv:contribution ?contribution ; rv:selectedDraft ?draft ;
      rv:language ?language ; rv:rightsBasis rv:OriginalContribution ;
      rv:disclosure rv:Public .
      ?draft a rv:RevisionAnchor ; rv:component ?contribution .
    }
    ${language ? `FILTER(?language = ${lit(language)})` : ''}
  } LIMIT ${MAX_NATIVE_VARIANTS + 1}`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_NATIVE_VARIANTS) throw new NativeVariantLimit('native variant inventory exceeds bound');
  const variants = rows.map(row => {
    const contribution = row.contribution?.value;
    const publicationDecision = row.decision?.value;
    const selectedDraft = row.draft?.value;
    const candidateLanguage = row.language?.value;
    const author = row.author?.value;
    if (!contribution || !publicationDecision || !selectedDraft || !candidateLanguage || !author
      || ![contribution, publicationDecision, selectedDraft, author].every(value => nativeId.test(value))
      || !languageTag.test(candidateLanguage)) {
      throw new NativeVariantUnavailable('native variant publication is incomplete');
    }
    return { contribution, publicationDecision, selectedDraft,
      language: candidateLanguage, author };
  });
  if (new Set(variants.map(variant => variant.contribution)).size !== variants.length) {
    throw new NativeVariantUnavailable('native variant publication is ambiguous');
  }
  variants.sort((a, b) => a.language.localeCompare(b.language)
    || a.contribution.localeCompare(b.contribution));
  return { work, variants };
}

export async function readEligibleNativeVariant(env: WorkActivationEnvironment,
  mainVersion: string, contribution: string): Promise<{
  work: string; variant: NativeVariant; body: string;
} | null> {
  if (!nativeId.test(contribution)) throw new InvalidNativeVariant('invalid Contribution identity');
  const { work, variants } = await listEligibleNativeVariants(env, mainVersion);
  const variant = variants.find(candidate => candidate.contribution === contribution);
  if (!variant) return null;
  const exact = await readExactContributionDraft(env, contribution, variant.selectedDraft,
    async () => true);
  if (exact.work !== work || exact.author !== variant.author || exact.language !== variant.language) {
    throw new NativeVariantUnavailable('public native variant differs from exact revision');
  }
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ${iri(work)} .
      ${iri(contribution)} a rv:TextContribution ; rv:work ${iri(work)} ;
        rv:author ${iri(variant.author)} ; rv:language ${lit(variant.language)} ;
        rv:publicationHead ${iri(variant.publicationDecision)} .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(variant.publicationDecision)} a rv:PublicationDecision ;
        rv:component ${iri(contribution)} ; rv:work ${iri(work)} ;
        rv:contribution ${iri(contribution)} ; rv:language ${lit(variant.language)} ;
        rv:selectedDraft ${iri(variant.selectedDraft)} ;
        rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .
    }
  }`);
  if (current.boolean !== true) return null;
  return { work, variant, body: exact.body };
}

export class ReaderVariantPreferenceStore {
  constructor(private readonly pool: Pool) {}

  /** A same-key replay remains observable after the published candidate changes. */
  async replay(principalId: string, input: SetReaderVariantPreferenceInput): Promise<{
    preference: ReaderVariantPreference | null; replayed: true;
  } | null> {
    if (!uuid.test(principalId)) throw new InvalidNativeVariant('invalid principal identity');
    const requestDigest = preferenceDigest(input);
    const result = await this.pool.query<{ request_digest: string; main_version: string;
      contribution: string | null; revision: string | null }>(
      `SELECT request_digest, main_version, contribution, revision
       FROM access.reader_variant_preference_receipt
       WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, input.idempotencyKey]);
    if (!result.rowCount) return null;
    const receipt = result.rows[0]!;
    if (receipt.request_digest !== requestDigest || receipt.main_version !== input.mainVersion) {
      throw new ReaderVariantIdempotencyConflict('reader preference idempotency key conflicts');
    }
    return { preference: receipt.contribution && receipt.revision
      ? { contribution: receipt.contribution, revision: receipt.revision } : null,
    replayed: true };
  }

  async read(principalId: string, mainVersion: string): Promise<ReaderVariantPreference | null> {
    checkedMain(mainVersion);
    if (!uuid.test(principalId)) throw new InvalidNativeVariant('invalid principal identity');
    const result = await this.pool.query<{ contribution: string; revision: string }>(
      `SELECT p.contribution, p.revision FROM access.reader_variant_preference p
       JOIN access.principal a ON a.id = p.principal_id
       WHERE p.principal_id = $1 AND p.main_version = $2 AND a.active`,
      [principalId, mainVersion]);
    return result.rows[0] ?? null;
  }

  async set(principalId: string, input: SetReaderVariantPreferenceInput): Promise<{
    preference: ReaderVariantPreference | null; replayed: boolean;
  }> {
    if (!uuid.test(principalId)) throw new InvalidNativeVariant('invalid principal identity');
    const requestDigest = preferenceDigest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([principalId, input.mainVersion])]);
      const principal = await client.query<{ active: boolean }>(
        'SELECT active FROM access.principal WHERE id = $1 FOR SHARE', [principalId]);
      if (principal.rows[0]?.active !== true) {
        throw new NativeVariantUnavailable('reader principal is inactive');
      }
      const prior = await client.query<{ request_digest: string; main_version: string;
        contribution: string | null; revision: string | null }>(
        `SELECT request_digest, main_version, contribution, revision
         FROM access.reader_variant_preference_receipt
         WHERE principal_id = $1 AND idempotency_key = $2`,
        [principalId, input.idempotencyKey]);
      if (prior.rowCount) {
        const receipt = prior.rows[0]!;
        if (receipt.request_digest !== requestDigest || receipt.main_version !== input.mainVersion) {
          throw new ReaderVariantIdempotencyConflict('reader preference idempotency key conflicts');
        }
        await client.query('COMMIT');
        return { preference: receipt.contribution && receipt.revision
          ? { contribution: receipt.contribution, revision: receipt.revision } : null,
        replayed: true };
      }
      const current = await client.query<{ revision: string }>(
        `SELECT revision FROM access.reader_variant_preference
         WHERE principal_id = $1 AND main_version = $2 FOR UPDATE`,
        [principalId, input.mainVersion]);
      if ((current.rows[0]?.revision ?? null) !== input.expectedRevision) {
        throw new StaleReaderVariantPreference('reader preference revision changed');
      }
      const revision = input.contribution === null ? null : randomUUID();
      if (input.contribution === null) {
        await client.query(`DELETE FROM access.reader_variant_preference
          WHERE principal_id = $1 AND main_version = $2`, [principalId, input.mainVersion]);
      } else {
        await client.query(`INSERT INTO access.reader_variant_preference
          (principal_id, main_version, contribution, revision) VALUES ($1, $2, $3, $4)
          ON CONFLICT (principal_id, main_version) DO UPDATE SET
          contribution = EXCLUDED.contribution, revision = EXCLUDED.revision`,
          [principalId, input.mainVersion, input.contribution, revision]);
      }
      await client.query(`INSERT INTO access.reader_variant_preference_receipt
        (principal_id, idempotency_key, request_digest, main_version, contribution, revision)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [principalId, input.idempotencyKey, requestDigest,
          input.mainVersion, input.contribution, revision]);
      await client.query('COMMIT');
      return { preference: input.contribution && revision
        ? { contribution: input.contribution, revision } : null, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

export async function readMainDefaultVariant(env: WorkActivationEnvironment,
  mainVersion: string): Promise<{ work: string; selection: string;
  variant: NativeVariant; body: string }> {
  checkedMain(mainVersion);
  const query = `PREFIX rv: <${RV}> SELECT
    ?work ?selection ?contribution ?decision ?draft ?language ?author ?body WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work ; rv:selectionHead ?selection .
      ?contribution a rv:TextContribution ; rv:work ?work ; rv:author ?author ;
        rv:language ?language ; rv:publicationHead ?decision .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?selection a rv:PublicationSelection ; rv:component ${iri(mainVersion)} ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ;
        rv:selectedDraft ?draft ; rv:matchUnit ?unit .
      ?decision a rv:PublicationDecision ; rv:component ?contribution ;
        rv:selectedDraft ?draft ; rv:rightsBasis rv:OriginalContribution ;
        rv:disclosure rv:Public .
    }
    GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
      ?unit a rv:MatchUnit ; rv:selection ?selection ;
        rv:mainVersion ${iri(mainVersion)} ; rv:disclosure rv:Public ;
        rv:language ?language ; rv:searchBody ?body .
    }
  }`;
  const result = await env.fuseki.query(query);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.work || !row.selection || !row.contribution
    || !row.decision || !row.draft || !row.language || !row.author || !row.body) {
    throw new NativeVariantUnavailable('Main Version default is unavailable');
  }
  const variant = { contribution: row.contribution.value,
    publicationDecision: row.decision.value, selectedDraft: row.draft.value,
    language: row.language.value, author: row.author.value };
  const exact = await readExactContributionDraft(env, variant.contribution,
    variant.selectedDraft, async () => true);
  if (exact.work !== row.work.value || exact.author !== variant.author
    || exact.language !== variant.language || exact.body !== row.body.value) {
    throw new NativeVariantUnavailable('Main Version default differs from exact revision');
  }
  const rechecked = await env.fuseki.query(query);
  const current = rechecked.results?.bindings ?? [];
  if (current.length !== 1 || ['work', 'selection', 'contribution', 'decision',
    'draft', 'language', 'author', 'body'].some(key => current[0]?.[key]?.value !== row[key]?.value)) {
    throw new NativeVariantUnavailable('Main Version default changed during read');
  }
  return { work: row.work.value, selection: row.selection.value,
    variant, body: exact.body };
}
