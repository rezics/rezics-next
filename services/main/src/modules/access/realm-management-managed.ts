import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { realmIdPattern, realmTransaction } from './realm-management-authority.ts';
import { realmPermissions, RealmAdminDenied, RealmAdminInvalid, RealmAdminLimit, RealmAdminStale } from '../realm-admin/contract.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readRealmPolicy } from '../space/policy.ts';

export const MANAGED_REALMS_COST = { page: 20, grants: 4096, countPointReads: 20, graphCalls: 20, graphBytes: 8192 } as const;
const countView = (value: string) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new RealmAdminLimit('Queue count exceeds the response range');
  return { value: count,kind: 'exact' as const };
};

/** Authorization is scoped per permission and OAuth family. Counts use the
 * transactional Access aggregate, independent of open and closed queue size. */
export class AccessManagedRealms {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}
  read(principal: VerifiedPrincipal, actor: string, options: { after?: string; limit?: number },
    families: { governance: boolean; review: boolean }) {
    const limit = options.limit ?? MANAGED_REALMS_COST.page;
    if (!realmIdPattern.test(actor) || options.after && !realmIdPattern.test(options.after)
      || !Number.isInteger(limit) || limit < 1 || limit > MANAGED_REALMS_COST.page) throw new RealmAdminInvalid('Invalid managed Realm page');
    return realmTransaction(this.pool,null,false,async client => {
      const identity = (await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
        JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3 AND r.active
          AND r.valid_until > clock_timestamp() JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active LIMIT 1 FOR SHARE OF p,r,s`,
      [principal.issuer,principal.subject,actor])).rows[0];
      if (!identity) throw new RealmAdminDenied('Acting Agent is unavailable');
      const rows = (await client.query<{ realm: string; action: string; grant_id: string; representation_id: string }>(`
        SELECT v.realm,g.action,g.id AS grant_id,r.id AS representation_id
        FROM access.permission_grant g JOIN access.realm_admin_revision v ON v.realm = CASE g.action
          WHEN 'review.decide' THEN substring(g.scope_id FROM 15)
          WHEN 'publication.adopt' THEN substring(g.scope_id FROM 19) ELSE substring(g.scope_id FROM 18) END
          AND g.scope_id = CASE g.action WHEN 'review.decide' THEN 'review:decide:' || v.realm
            WHEN 'publication.adopt' THEN 'publication:adopt:' || v.realm ELSE 'governance:realm:' || v.realm END
        JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
        JOIN access.representation r ON r.principal_id = $1 AND r.subject_id = g.recipient_subject
          AND r.action IN (g.action,'agent.control') AND r.active AND r.valid_until > clock_timestamp()
        WHERE g.recipient_subject = $2 AND g.active AND g.valid_until > clock_timestamp()
          AND g.action = ANY($3::text[])
          AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
            WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
        ORDER BY v.realm,g.action,g.id LIMIT $4 FOR SHARE OF g,gate,r`,
      [identity.id,actor,[...realmPermissions,'realm.owner'].filter(p => p === 'review.decide' || p === 'publication.adopt'
        ? families.review : families.governance),MANAGED_REALMS_COST.grants + 1])).rows;
      if (rows.length > MANAGED_REALMS_COST.grants) throw new RealmAdminLimit('Managed Realm grants exceed the read budget');
      const permissions = new Map<string,Set<string>>();
      for (const row of rows) {
        const actions = permissions.get(row.realm) ?? new Set<string>();
        actions.add(row.action); permissions.set(row.realm,actions);
      }
      const realms = [...permissions.keys()].filter(realm => !options.after || realm > options.after).sort();
      const items = [];
      for (const realm of realms.slice(0,limit)) {
        const actions = [...permissions.get(realm)!].sort();
        if (!await readRealmPolicy(this.env,realm)) continue;
        const governance = actions.includes('governance.moderate');
        const review = actions.includes('review.decide');
        const row = (await client.query<{ open_count: string; escalated_count: string; latest_activity: Date | null }>(`
          SELECT ((CASE WHEN $2 THEN open_reports ELSE 0 END) + (CASE WHEN $3 THEN open_submissions ELSE 0 END))::text AS open_count,
            ((CASE WHEN $2 THEN escalated_reports ELSE 0 END) + (CASE WHEN $3 THEN escalated_submissions ELSE 0 END))::text AS escalated_count,
            GREATEST(admin_activity,CASE WHEN $2 THEN report_activity END,CASE WHEN $3 THEN submission_activity END) AS latest_activity
          FROM access.realm_management_activity WHERE realm = $1 FOR SHARE`,[realm,governance,review])).rows[0]
          ?? { open_count: '0',escalated_count: '0',latest_activity: null };
        items.push({ realm,permissions: actions,openCount: countView(row.open_count),
          escalatedCount: countView(row.escalated_count),latestActivity: row.latest_activity?.toISOString() ?? null });
      }
      if (rows.length && !(await client.query<{ current: boolean }>(`SELECT bool_and(g.valid_until > clock_timestamp()
        AND r.valid_until > clock_timestamp()) AS current FROM unnest($1::uuid[],$2::uuid[]) AS proof(grant_id,representation_id)
        JOIN access.permission_grant g ON g.id = proof.grant_id JOIN access.representation r ON r.id = proof.representation_id`,
      [rows.map(row => row.grant_id),rows.map(row => row.representation_id)])).rows[0]?.current) {
        throw new RealmAdminStale('Managed Realm authority expired during the read');
      }
      return { items,nextCursor: realms.length > limit ? realms[limit - 1]! : null };
    });
  }
}
