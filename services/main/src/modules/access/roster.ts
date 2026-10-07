import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { realmActor, realmIdPattern, realmManager, realmTransaction } from './realm-management-authority.ts';
import { RealmAdminDenied, RealmAdminInvalid, RealmAdminStale } from '../realm-admin/contract.ts';
import { visibleNames } from '../disclosure/name-policy.ts';
import { disclosureViewer } from '../disclosure/viewer.ts';
import { PersonPreferencesStore } from '../preferences/store.ts';
import { readRealmPolicy } from '../space/policy.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';

// Two exact graph policy reads, one indexed page of <= 51 listing rows, one
// name-policy read and bounded point joins. No account/principal identifiers
// are public roster data.
export const REALM_ROSTER_COST = { page: 50, graphCalls: 2, graphBytes: 8192, sqlStatements: 10 } as const;
export class AccessRealmRoster {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}

  read(realm: string, options: { after?: string; limit?: number; featured?: boolean },
    principal: VerifiedPrincipal | null = null) {
    const limit = options.limit ?? REALM_ROSTER_COST.page;
    if (!Number.isInteger(limit) || limit < 1 || limit > REALM_ROSTER_COST.page
      || options.after && !realmIdPattern.test(options.after)) throw new RealmAdminInvalid('Invalid roster page');
    return realmTransaction(this.pool,realm,false,async client => {
      const policy = await readRealmPolicy(this.env,realm);
      if (policy?.visibility !== 'public' || (await client.query(`SELECT 1 FROM access.realm_admin_settings
        WHERE realm = $1 AND visibility <> 'public' UNION ALL SELECT 1 FROM access.realm_policy_delivery
        WHERE realm = $1 AND NOT delivered LIMIT 1`,[realm])).rowCount) throw new RealmAdminDenied('Public roster is unavailable');
      // Bound candidates before eligibility joins. A page may contain fewer
      // visible members; its cursor advances over every examined candidate.
      const candidates = (await client.query<{ member: string; membership_id: string }>(`SELECT member,membership_id
        FROM access.realm_roster_listing WHERE realm = $1 AND listed ${options.featured ? 'AND featured' : ''}
          AND ($2::text IS NULL OR member > $2) ORDER BY member LIMIT $3 FOR SHARE`,
      [realm,options.after ?? null,limit + 1])).rows;
      const rows = (await client.query<{ member: string; featured: boolean; display_name: string | null }>(`
        SELECT l.member,l.featured,p.display_name FROM access.realm_roster_listing l
        JOIN access.membership m ON m.id = l.membership_id AND m.generation = l.membership_generation
          AND m.kind = 'realm' AND m.owner_subject = l.realm AND m.member_subject = l.member AND m.state = 'joined'
        JOIN access.authority_subject s ON s.id = l.member AND s.active
        LEFT JOIN access.agent_provision p ON p.agent_id = l.member AND p.state = 'active'
        WHERE l.realm = $1 AND l.listed ${options.featured ? 'AND l.featured' : ''}
          AND l.membership_id = ANY($2::uuid[])
          AND NOT EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind = 'realm'
            AND b.owner_subject = l.realm AND b.member_subject = l.member AND b.active
            AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp()))
        ORDER BY l.member LIMIT $3 FOR SHARE OF l,m,s`,[realm,candidates.slice(0,limit).map(row => row.membership_id),limit])).rows;
      const end = await readRealmPolicy(this.env,realm);
      if (end?.visibility !== 'public' || end.revision !== policy.revision) throw new RealmAdminStale('Realm visibility changed');
      const page = rows.slice(0,limit);
      // The public route passes no principal, so a private name stays null
      // while the member remains. A controller still sees their own name.
      const visible = page.length ? await visibleNames(new PersonPreferencesStore(this.pool),
        page.map(row => row.member), disclosureViewer(principal)) : new Set<string>();
      return { items: page.map(row => ({ agent: row.member,
        displayName: visible.has(row.member) ? row.display_name : null, featured: row.featured })),
        nextCursor: candidates.length > limit ? candidates[limit - 1]!.member : null };
    });
  }

  listing(principal: VerifiedPrincipal, realm: string, actor: string, expectedGeneration: string, listed: boolean) {
    return realmTransaction(this.pool,realm,true,async client => {
      await realmActor(client,principal,actor,'access.membership.consent');
      const member = (await client.query<{ id: string; generation: string }>(`SELECT id,generation::text
        FROM access.membership WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2
          AND state = 'joined' FOR SHARE`,[realm,actor])).rows[0];
      if (!member || member.generation !== expectedGeneration) throw new RealmAdminStale('Membership changed');
      await client.query(`INSERT INTO access.realm_roster_listing (membership_id,membership_generation,realm,member,listed)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (membership_id,membership_generation)
        DO UPDATE SET listed = EXCLUDED.listed,featured = CASE WHEN EXCLUDED.listed
          THEN access.realm_roster_listing.featured ELSE false END,changed_at = clock_timestamp()`,
      [member.id,member.generation,realm,actor,listed]);
      return { member: actor,membershipGeneration: member.generation,listed };
    });
  }

  feature(principal: VerifiedPrincipal, realm: string, actor: string, member: string,
    expectedGeneration: string, featured: boolean) {
    return realmTransaction(this.pool,realm,true,async client => {
      await realmManager(client,principal,realm,actor);
      const result = await client.query(`UPDATE access.realm_roster_listing l SET featured = $4,changed_at = clock_timestamp()
        FROM access.membership m WHERE l.membership_id = m.id AND l.membership_generation = m.generation
          AND m.kind = 'realm' AND m.owner_subject = $1 AND m.member_subject = $2 AND m.generation = $3
          AND m.state = 'joined' AND l.listed`,[realm,member,expectedGeneration,featured]);
      if (!result.rowCount) throw new RealmAdminStale('Listed membership is unavailable');
      return { member,membershipGeneration: expectedGeneration,featured };
    });
  }
}
