import type { Static } from 'typebox';
import type { PoolClient } from 'pg';
import { namedDiscoveryCredits, primaryDiscoveryCredits } from '../discovery/credits.ts';
import { type PublicHubCard, readPublicHubCards } from '../hub/public-card.ts';
import type { PublicModCard } from '../package/mod-resolution.ts';
import { fenceAuthorNames, readAuthorNames } from '../source/author-name-read.ts';
import { postBookPlace } from '../structure/post-book-placements.ts';
import { WorkReadInvalid, type WorkReadSession } from '../work/read-session.ts';
import { MODERATION_CONTEXT_COST, type personContext, type workContext } from './read-contract.ts';

export type PersonContext = Static<typeof personContext>;
export type WorkContext = Static<typeof workContext>;

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `?agents=` and `?works=`: a comma list of distinct native IDs, at most `limit` of them. */
export function idList(value: string | undefined, limit: number): string[] {
  if (value === undefined || value === '') return [];
  const ids = value.split(',');
  if (ids.length > limit || new Set(ids).size !== ids.length || ids.some(id => !native.test(id))) {
    throw new WorkReadInvalid(`Name at most ${limit} distinct IDs`);
  }
  return ids;
}

interface Counts { [state: string]: number }
interface PersonRow { agent: string; state: 'joined' | 'left' | 'not_joined'; joined_at: Date | null; banned: boolean;
  banned_until: Date | null; submissions: Counts | null; reports: Counts | null }

/**
 * One aggregate over the named people, keeping those this reader meets in the
 * queue: submitters for a reviewer, reporters for a moderator. Anyone else is
 * left out, so the read never says whether an arbitrary Agent belongs to the
 * Realm. Each count stops at `historyRows`, over the submitter and reporter
 * indexes.
 */
export async function readPeople(client: PoolClient, realm: string, scope: string, agents: readonly string[],
  sees: { submissions: boolean; reports: boolean }): Promise<PersonContext[]> {
  if (!agents.length) return [];
  const cap = MODERATION_CONTEXT_COST.historyRows;
  const rows = (await client.query<PersonRow>(`WITH wanted AS (SELECT DISTINCT unnest($2::text[]) AS agent),
    known AS (SELECT agent FROM wanted w WHERE
      ($4 AND EXISTS (SELECT 1 FROM access.realm_submission s WHERE s.submitting_agent = w.agent AND s.realm = $1))
      OR ($5 AND EXISTS (SELECT 1 FROM access.governance_report r JOIN access.governance_case c ON c.id = r.case_id
        WHERE r.acting_subject = w.agent AND c.context = $1 AND c.authority_scope_id = $3)))
    SELECT k.agent, COALESCE(m.state, 'not_joined') AS state,
      (SELECT h.changed_at FROM access.membership_history h WHERE h.membership_id = m.id
        AND h.state = 'joined' ORDER BY h.generation DESC LIMIT 1) AS joined_at,
      COALESCE(b.active AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()), false) AS banned,
      CASE WHEN b.active AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()) THEN b.expires_at END AS banned_until,
      CASE WHEN $4 THEN (SELECT jsonb_build_object('open', count(*) FILTER (WHERE state IN ('pending', 'deciding')),
          'accepted', count(*) FILTER (WHERE state = 'accepted'), 'rejected', count(*) FILTER (WHERE state = 'rejected'),
          'changesRequested', count(*) FILTER (WHERE state = 'changes-requested'),
          'withdrawn', count(*) FILTER (WHERE state IN ('withdrawn', 'stale')), 'total', count(*))
        FROM (SELECT s.state FROM access.realm_submission s WHERE s.submitting_agent = k.agent AND s.realm = $1
          LIMIT $6) history) END AS submissions,
      CASE WHEN $5 THEN (SELECT jsonb_build_object('open', count(*) FILTER (WHERE outcome IS NULL),
          'upheld', count(*) FILTER (WHERE outcome IN ('restrict', 'interim_restrict', 'final_restrict')),
          'dismissed', count(*) FILTER (WHERE outcome = 'dismiss'), 'total', count(*))
        FROM (SELECT d.outcome FROM access.governance_report r
          JOIN access.governance_case c ON c.id = r.case_id AND c.context = $1 AND c.authority_scope_id = $3
          LEFT JOIN access.moderation_decision d ON d.id = c.decision_head
          WHERE r.acting_subject = k.agent LIMIT $6) history) END AS reports
    FROM known k
    LEFT JOIN access.membership m ON m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = k.agent
    LEFT JOIN access.membership_ban b ON b.kind = 'realm' AND b.owner_subject = $1 AND b.member_subject = k.agent
    ORDER BY k.agent`, [realm, agents, scope, sees.submissions, sees.reports, cap])).rows;
  const counted = (counts: Counts, keys: readonly string[]) => ({
    ...Object.fromEntries(keys.map(key => [key, Number(counts[key] ?? 0)])), capped: Number(counts.total ?? 0) >= cap });
  return rows.map(row => ({ agent: row.agent,
    membership: { state: row.state, joinedAt: row.joined_at?.toISOString() ?? null, banned: row.banned,
      bannedUntil: row.banned_until?.toISOString() ?? null },
    submissions: row.submissions ? counted(row.submissions, ['open', 'accepted', 'rejected', 'changesRequested',
      'withdrawn', 'total']) as PersonContext['submissions'] : null,
    reports: row.reports ? counted(row.reports, ['open', 'upheld', 'dismissed', 'total']) as PersonContext['reports']
      : null }));
}

const cut = (text: string, limit: number) => {
  const characters = Array.from(text);
  return { text: characters.slice(0, limit).join(''), truncated: characters.length > limit };
};

/**
 * The Works a queue page shows, as far as this reader may read them: their
 * authors as discovery names them, a public mod's compatibility card and a
 * public prompt's or skill's text. A chapter placed in a Book the reader may
 * read is named by its place even when the chapter's own record is not
 * readable (Books list their chapters in public contents), with the Book's
 * authors. Any other Work the reader cannot read is left out.
 */
export async function readWorkContext(session: WorkReadSession, works: readonly string[]): Promise<WorkContext[]> {
  if (!works.length) return [];
  const places = await Promise.all(works.map(work => postBookPlace(session, work)));
  const books = [...new Set(places.flatMap(place => place ? [place.work] : []))].filter(book => !works.includes(book));
  const summaries = await session.summaries([...works, ...books]);
  const available = new Set([...works, ...books].filter((_, index) => {
    const summary = summaries[index];
    return summary?.status === 'available' && summary.type === 'work';
  }));
  const shown = works.flatMap((work, index) => {
    const place = places[index] ?? null;
    if (available.has(work)) return [{ work, place, readable: true }];
    // Only a place the Book's contents show: a chapter with an occurrence in a Book this reader may read.
    return place?.occurrence && available.has(place.work) ? [{ work, place, readable: false }] : [];
  });
  // A chapter is credited through its Book; everything else through its own credits.
  const credited = [...new Set(shown.map(item => item.place?.work ?? item.work))].filter(work => available.has(work));
  const readable = shown.filter(item => item.readable).map(item => item.work);
  const credits = new Map(await Promise.all(credited.map(async work =>
    [work, await primaryDiscoveryCredits(session, work)] as const)));
  const all = [...credits.values()].flat();
  const [agents, sources, hub, mods] = await Promise.all([
    namedDiscoveryCredits(session, all, credited.length || 1),
    readAuthorNames(session, all.flatMap(credit => credit.participantKind === 'external-reference' ? [credit.key] : [])),
    session.deps.hub && session.deps.content ? readPublicHubCards(session, readable)
      : new Map<string, PublicHubCard>(),
    session.deps.packageModResolutions ? session.deps.packageModResolutions.readCards(readable)
      : new Map<string, PublicModCard>(),
  ]);
  await fenceAuthorNames(session);
  return shown.map(({ work, place }) => {
    const authors = (credits.get(place?.work ?? work) ?? []).flatMap((credit): WorkContext['authors'] => {
      if (credit.participantKind === 'agent') {
        const name = agents.get(credit.agent);
        return name ? [{ agent: credit.agent, name: name.displayName }] : [];
      }
      const name = sources.get(credit.key)?.displayName ?? credit.displayName;
      return name ? [{ agent: null, name }] : [];
    }).slice(0, MODERATION_CONTEXT_COST.authors);
    const mod = mods.get(work);
    const card = hub.get(work);
    const body = card ? cut(card.copyText, MODERATION_CONTEXT_COST.hubCharacters) : null;
    return { work, partOf: place, authors,
      mod: mod ? { game: mod.game, gameVersions: mod.gameVersions.slice(0, 8), loaders: mod.loaders.slice(0, 8),
        latestRelease: mod.latestRelease } : null,
      hub: card && body ? { kind: card.kind, summary: card.preview, ...body, declaredModels: card.declaredModels } : null };
  });
}
