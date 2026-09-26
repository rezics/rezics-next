import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { CommerceDenied, resolveBenefits, SUBSCRIBE_ACTION } from '../commerce/store.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { queryPublicRealmPhrase } from '../work/search-public.ts';

export class SiteUnavailable extends Error {}
export class SiteBenefitRequired extends Error {}

const hostPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface FixedSite {
  siteId: string; host: string; revision: string; realm: string;
  presentationProfile: string; requiredBenefit: string | null;
}

export interface SitePhraseQuery {
  phrase: string; language: string | null; author?: string;
}

/** Installation-provisioned fixed-Realm site configuration (Access DB `site`). */
export class FixedSiteStore {
  constructor(private readonly pool: Pool) {}

  /** The active head revision of one host. Retired or unknown hosts are unavailable. */
  async active(host: string): Promise<FixedSite> {
    if (!hostPattern.test(host)) throw new SiteUnavailable('invalid site host');
    const row = await this.pool.query<{ id: string; head_revision: string; realm: string;
      presentation_profile: string; required_benefit: string | null }>(`SELECT d.id, d.head_revision,
        r.realm, r.presentation_profile, r.required_benefit
      FROM site.definition d JOIN site.definition_revision r ON r.site_id = d.id AND r.revision = d.head_revision
      WHERE d.host = $1 AND r.lifecycle = 'active'`, [host]);
    const site = row.rows[0];
    if (!site) throw new SiteUnavailable('site is unavailable');
    return { siteId: site.id, host, revision: site.head_revision, realm: site.realm,
      presentationProfile: site.presentation_profile, requiredBenefit: site.required_benefit };
  }

  /** A gated site admits a reader only through the commerce effective benefit
   * of an Agent the caller currently represents; a payment record alone never does. */
  async assertReader(site: FixedSite, principal: VerifiedPrincipal, beneficiary: string): Promise<void> {
    if (!site.requiredBenefit) return;
    if (!nativeId.test(beneficiary)) throw new SiteBenefitRequired('reader Agent is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const allowed = await client.query(`SELECT 1 FROM access.principal p
        JOIN access.representation r ON r.principal_id = p.id
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND r.subject_id = $3
          AND r.action = $4 AND r.active AND r.valid_until > clock_timestamp() LIMIT 1`,
      [principal.issuer, principal.subject, beneficiary, SUBSCRIBE_ACTION]);
      if (!allowed.rowCount) throw new CommerceDenied('caller does not represent the reader');
      const benefits = await resolveBenefits(client, beneficiary);
      await client.query('COMMIT');
      if (!benefits.benefits.some(entry => entry.benefitKey === site.requiredBenefit)) {
        throw new SiteBenefitRequired('reader lacks the site benefit');
      }
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw error;
    } finally { client.release(); }
  }
}

/**
 * Phrase query inside one fixed site's Realm boundary. It reuses the public
 * Realm relation but keeps only the Realm's own adoptions: Main-default
 * fallback rows (general content) are removed, so a sparse or empty Realm
 * returns a sparse or empty complete result. The response carries only the
 * admitted rows and their count, never a global or private population.
 */
export async function queryFixedSitePhrase(env: WorkActivationEnvironment, site: FixedSite,
  input: SitePhraseQuery) {
  const relation = await queryPublicRealmPhrase(env, { phrase: input.phrase, language: input.language,
    author: input.author, context: { kind: 'realm-local', id: site.realm } });
  const results = relation.results.filter(row => row.reason === 'realm-adoption')
    .map(({ reason: _reason, ...row }) => row);
  return { profile: 'fixed-site-phrase-v1' as const,
    site: { id: site.siteId, host: site.host, revision: site.revision, realm: site.realm },
    complete: true as const, total: results.length, results,
    indexGeneration: relation.indexGeneration, sourcePosition: relation.sourcePosition };
}
