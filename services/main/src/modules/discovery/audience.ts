import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { PRIMARY_READING_PERSON_SQL } from '../preferences/languages.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { eligible, type Labels, type Viewer } from '../suitability/policy.ts';
import { GLOBAL_CONTEXT } from '../governance/schema.ts';
import { summarizeJudgments } from '../judgment/policy.ts';

export interface ClassificationAudience {
  excluded: { resource: string; revision: string | null }[];
  protection: { context: string; concepts: string[]; statements: string[]; judged: string[] }[];
}

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
  /** A bounded policy snapshot for graph aggregation. The policy functions
   * remain the same owners used by summary/count and classification reads.
   * A policy inventory overflow refuses the read instead of dropping fences. */
  classificationAudience(viewer: Viewer, realm?: string): Promise<ClassificationAudience> {
    return controlRead(this.pool, async (client) => {
      const labels: Labels[] = [[], ['r15'], ['r18'], ['r18g'], ['r18', 'r18g']];
      const allowed = labels
        .filter(
          (labels) =>
            eligible({ assessment: { status: 'assessed', labels }, viewer, channel: 'read' })
              .eligible,
        )
        .map((labels) => JSON.stringify(labels));
      const excluded = (
        await client.query<{ resource: string; revision: string | null }>(
          `
        SELECT resource,revision FROM (
          SELECT target AS resource,NULL::text AS revision FROM (
            SELECT DISTINCT ON (target) target,labels FROM access.suitability_assessment
            ORDER BY target,revision_number DESC) latest WHERE NOT (to_jsonb(labels)=ANY($1::jsonb[]))
          UNION SELECT resource,revision FROM access.governance_enforcement
            WHERE state='restricted' AND owner='graph' AND context=ANY($2::text[])
              AND component IN ('name','title','record','publication') AND effect IN ('disclosure','search')
        ) denied ORDER BY resource,revision NULLS FIRST LIMIT 4097`,
          [allowed, [GLOBAL_CONTEXT, ...(realm ? [realm] : [])]],
        )
      ).rows;
      if (excluded.length > 4096)
        throw new WorkReadUnavailable('Count disclosure inventory exceeds its read budget');
      const contexts = ['global', ...(realm ? [realm] : [])];
      const hints = (
        await client.query<{ concept: string; context_key: string }>(
          `SELECT concept,context_key
        FROM access.judgment_concept_hint WHERE context_key=ANY($1::text[]) AND hint='not-spoiler'
        ORDER BY context_key,concept LIMIT 4097`,
          [contexts],
        )
      ).rows;
      const judgments = (
        await client.query<{
          statement: string;
          context_key: string;
          fit_negative: string;
          fit_positive: string;
          spoiler_none: string;
          spoiler_minor: string;
          spoiler_major: string;
        }>(
          `
        SELECT statement,context_key,fit_negative,fit_positive,spoiler_none,spoiler_minor,spoiler_major
        FROM access.judgment_aggregate WHERE context_key=ANY($1::text[])
          AND (spoiler_none+spoiler_minor+spoiler_major)>0 ORDER BY context_key,statement LIMIT 4097`,
          [contexts],
        )
      ).rows;
      if (hints.length > 4096 || judgments.length > 4096) {
        throw new WorkReadUnavailable(
          'Classification protection inventory exceeds its read budget',
        );
      }
      return {
        excluded,
        protection: contexts.map((context) => ({
          context,
          concepts: hints.filter((row) => row.context_key === context).map((row) => row.concept),
          judged: judgments
            .filter((row) => row.context_key === context)
            .map((row) => row.statement),
          statements: judgments
            .filter(
              (row) =>
                row.context_key === context &&
                summarizeJudgments({
                  fitNegative: Number(row.fit_negative),
                  fitPositive: Number(row.fit_positive),
                  spoilerNone: Number(row.spoiler_none),
                  spoilerMinor: Number(row.spoiler_minor),
                  spoilerMajor: Number(row.spoiler_major),
                }).spoiler.protection === 'show-all',
            )
            .map((row) => row.statement),
        })),
      };
    });
  }
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
