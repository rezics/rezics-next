import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { PRIMARY_READING_PERSON_SQL } from '../preferences/languages.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';

export interface DiscoverySignals {
  owner: string;
  revision: string | null;
  settingsRevision: string | null;
  enabled: boolean;
  topics: string[];
  languages: string[];
}
/** Access owns the identity proof and recovery fence. Only explicit following
 * and reading-language choices leave this adapter; no browsing history.
 * Two bounded indexed reads (the existing 1,000-follow inventory), and one
 * candidate membership/follow batch of at most 64 resources. */
export class DiscoveryAudienceStore {
  constructor(private readonly pool: Pool) {}
  signals(principal: VerifiedPrincipal, actor: string): Promise<DiscoverySignals> {
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, actor);
      const row = (
        await client.query<{
          revision: string | null;
          settings_revision: string | null;
          enabled: boolean;
          languages: string[];
        }>(
          `SELECT f.revision, h.revision AS settings_revision,
        COALESCE((h.preferences->>'recommendations')::boolean,true) AS enabled,
        COALESCE(p.content_languages,'{}'::text[]) AS languages
        FROM (SELECT $1::uuid AS principal_id) identity
        LEFT JOIN access.follow_inventory f ON f.principal_id=identity.principal_id
        LEFT JOIN access.home_state h ON h.principal_id=identity.principal_id
        LEFT JOIN (${PRIMARY_READING_PERSON_SQL}) reader ON true
        LEFT JOIN access.person_preferences p ON p.agent_id=reader.agent_id`,
          [owner],
        )
      ).rows[0]!;
      const topics = (
        await client.query<{ target: string }>(
          `SELECT target FROM access.follow
        WHERE principal_id=$1 AND following AND kind='concept' ORDER BY target LIMIT 1001`,
          [owner],
        )
      ).rows;
      if (topics.length > 1000)
        throw new WorkReadUnavailable('Follow inventory exceeds its declared bound');
      return {
        owner,
        revision: row.revision,
        settingsRevision: row.settings_revision,
        enabled: row.enabled,
        topics: topics.map((topic) => topic.target),
        languages: row.languages,
      };
    });
  }

  /** The picker prioritizes joined Realms without loading the membership
   * population. Each seek returns at most 64 identities plus one lookahead. */
  joinedRealms(principal: VerifiedPrincipal, actor: string, after: string, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new WorkReadUnavailable('Reader community batch exceeds its bound');
    return controlRead(this.pool, async (client) => {
      await followPrincipal(client, principal, actor);
      return (
        await client.query<{ id: string }>(
          `SELECT m.owner_subject AS id
        FROM access.membership m JOIN access.authority_subject s ON s.id=m.member_subject AND s.active
        WHERE m.kind='realm' AND m.member_subject=$1 AND m.state='joined' AND m.owner_subject>$2
          AND NOT EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind='realm'
            AND b.owner_subject=m.owner_subject AND b.member_subject=m.member_subject AND b.active
            AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
        ORDER BY m.owner_subject LIMIT $3`,
          [actor, after, limit + 1],
        )
      ).rows;
    });
  }

  flags(principal: VerifiedPrincipal, actor: string, ids: readonly string[]) {
    if (ids.length > 64) throw new WorkReadUnavailable('Reader candidate batch exceeds its bound');
    return controlRead(this.pool, async (client) => {
      const owner = await followPrincipal(client, principal, actor);
      const rows = (
        await client.query<{ id: string; following: boolean; membership: string | null }>(
          `
        SELECT wanted.id, EXISTS (SELECT 1 FROM access.follow f
          WHERE f.principal_id=$1 AND f.target=wanted.id AND f.following) AS following,
          (SELECT m.generation::text FROM access.membership m
            JOIN access.authority_subject s ON s.id=m.member_subject AND s.active
            WHERE m.kind='realm' AND m.owner_subject=wanted.id AND m.member_subject=$2 AND m.state='joined'
              AND NOT EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind='realm'
                AND b.owner_subject=m.owner_subject AND b.member_subject=m.member_subject AND b.active
                AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))) AS membership
        FROM unnest($3::text[]) AS wanted(id) ORDER BY wanted.id`,
          [owner, actor, ids],
        )
      ).rows;
      return new Map(
        rows.map((row) => [
          row.id,
          {
            following: row.following,
            community: row.membership !== null,
            membership: row.membership,
          },
        ]),
      );
    });
  }
}
