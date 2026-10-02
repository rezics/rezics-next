import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { realmSettings, RealmAdminInvalid, RealmAdminStale, RealmAdminConflict, RealmAdminDenied, type RealmSettings,
  type SettingsCommand } from '../realm-admin/contract.ts';
import { AdmissionDenied } from './admission.ts';
import { realmMemberProof } from '../realm-reply/member-policy.ts';
import { currentRealmRulesDocument, realmRulesRef, publishRuleRevision } from '../governance/rules.ts';
import { checkedCommunityRules } from '../realm-profile/schema.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale } from '../governance/store.ts';
import type { RealmReviewMode } from '../space/policy.ts';
import type { SpaceSettings } from '../realm-admin/contract.ts';

/** Indexed owner reads, no duplicated admission enum in Realm settings. */
export async function readRealmAccessSettings(client: PoolClient, realm: string): Promise<SpaceSettings> {
  const row = (await client.query<{ visibility: string; listing: SpaceSettings['listing'];
    history: SpaceSettings['history']; self_join: boolean; admission: 'request' | 'invitation' }>(`
    SELECT COALESCE(s.visibility,'public') AS visibility,COALESCE(s.listing,'listed') AS listing,
      COALESCE(s.history,'everything') AS history,COALESCE(s.self_join,false) AS self_join,p.admission
    FROM (SELECT $1::text AS realm) target
    LEFT JOIN access.realm_admin_settings s ON s.realm = target.realm
    LEFT JOIN access.membership_policy p ON p.kind = 'realm' AND p.owner_subject = target.realm`, [realm])).rows[0];
  return { visibility: row?.visibility === 'private' ? 'private' : 'public',
    listing: row?.listing ?? 'listed', history: row?.history ?? 'everything',
    admission: row?.self_join ? 'open' : row?.admission ?? 'invitation' };
}

export async function saveRealmAccessSettings(client: PoolClient, realm: string, settings: SpaceSettings) {
  const before = await readRealmAccessSettings(client, realm);
  await client.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit,visibility,listing,history,self_join)
    VALUES ($1,'granted',$2,$3,$4,$5) ON CONFLICT (realm) DO UPDATE SET visibility = CASE
     WHEN access.realm_admin_settings.visibility = 'restricted' AND EXCLUDED.visibility = 'public'
     THEN 'restricted' ELSE EXCLUDED.visibility END,
      listing = EXCLUDED.listing,history = EXCLUDED.history,self_join = EXCLUDED.self_join`,
  [realm,settings.visibility,settings.listing,settings.history,settings.admission === 'open']);
  const policy = await client.query(`UPDATE access.membership_policy SET admission = $2,
    revision = revision + CASE WHEN $3 THEN 1 ELSE 0 END WHERE kind = 'realm' AND owner_subject = $1`,
  [realm,settings.admission === 'request' ? 'request' : 'invitation',before.admission !== settings.admission]);
  if (!policy.rowCount) throw new RealmAdminInvalid('Realm membership policy is unavailable');
}

const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Settings keep the localized title/body maps intact. The immutable rule
 * revision is shared with GovernanceRules, so moderation uses the exact basis. */
export async function readRealmSettings(client: PoolClient, realm: string) {
  const row = (await client.query<{ who_may_submit: RealmSettings['whoMaySubmit']; visibility: RealmSettings['visibility']; review_mode: RealmReviewMode; self_join: boolean }>(`
    SELECT who_may_submit,visibility,review_mode,self_join FROM access.realm_admin_settings WHERE realm = $1`, [realm])).rows[0];
  const rules = (await client.query<{ revision: string; digest: string; document: unknown }>(`
    SELECT h.revision::text,h.digest,r.document FROM access.governance_rule_head h
    JOIN access.governance_rule_revision r ON r.ref = h.ref AND r.revision = h.revision
    WHERE h.ref = $1 AND h.scope_id = $2`, [realmRulesRef(realm), `governance:realm:${realm}`])).rows[0];
  let currentRules: RealmSettings['rules'];
  try { currentRules = rules ? currentRealmRulesDocument(rules.document).rules : []; }
  catch { throw new RealmAdminInvalid('Realm rules document has an unsupported shape'); }
  const settings = { visibility: row?.visibility ?? 'public', reviewRequired: (row?.review_mode ?? 'mandatory') === 'mandatory',
    reviewMode: row?.review_mode ?? 'mandatory',
    whoMaySubmit: row?.who_may_submit ?? 'granted', selfJoin: row?.self_join ?? false, rules: currentRules };
  if (!Value.Check(realmSettings, settings)) throw new RealmAdminInvalid('Realm rules document has an unsupported shape');
  return { settings, ruleBasis: { ref: realmRulesRef(realm), revision: rules?.revision ?? null, digest: rules?.digest ?? null } };
}

export async function saveRealmSettings(client: PoolClient, realm: string, principalId: string,
  input: SettingsCommand, key: string) {
  const settings = input.settings;
  const before = await readRealmAccessSettings(client, realm);
  const mode = settings.reviewMode ?? (settings.reviewRequired ? 'mandatory' : 'open');
  if (settings.reviewRequired !== (mode === 'mandatory')) throw new RealmAdminInvalid('Review mode and reviewRequired disagree');
  try { checkedCommunityRules(settings.rules); }
  catch { throw new RealmAdminInvalid('Rules need unique identities and valid localized text'); }
  const document = { profile: 'realm-settings-rules-v2', public: settings.visibility !== 'private', rules: settings.rules };
  if (Buffer.byteLength(JSON.stringify(document)) > 16_384) throw new RealmAdminInvalid('Rules exceed the governance document budget');
  const ref = realmRulesRef(realm);
  const published = await publishRuleRevision(client, principalId, { ref, scopeId: `governance:realm:${realm}`,
    expectedRevision: input.expectedRulesRevision, actingSubject: input.actingSubject,
    document, idempotencyKey: hash({ realm, key }) }).catch((error: unknown) => {
    if (error instanceof GovernanceStale) throw new RealmAdminStale(error.message);
    if (error instanceof GovernanceConflict) throw new RealmAdminConflict(error.message);
    if (error instanceof GovernanceInvalid) throw new RealmAdminInvalid(error.message);
    if (error instanceof GovernanceDenied) throw new RealmAdminDenied(error.message);
    throw error;
  });
  await client.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit,visibility,review_mode,self_join) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (realm) DO UPDATE SET who_may_submit = EXCLUDED.who_may_submit,
      visibility = EXCLUDED.visibility,review_mode = EXCLUDED.review_mode,
      self_join = CASE WHEN $6 THEN EXCLUDED.self_join ELSE access.realm_admin_settings.self_join END`,
  [realm, settings.whoMaySubmit,settings.visibility,mode,settings.selfJoin ?? false,settings.selfJoin !== undefined]);
  const admission = settings.selfJoin === undefined ? before.admission
    : settings.selfJoin ? 'open' : before.admission === 'open' ? 'invitation' : before.admission;
  await client.query(`UPDATE access.membership_policy SET admission = $2,
    revision = revision + CASE WHEN $3 THEN 1 ELSE 0 END WHERE kind = 'realm' AND owner_subject = $1`,
  [realm,admission === 'request' ? 'request' : 'invitation',before.admission !== admission]);
  return { settings, ruleBasis: { ref, revision: published.revision, digest: published.digest } };
}

/** This is an additional Access restriction on the existing submission grant,
 * never a replacement for admission or a grant manufactured by UI settings. */
export async function requireRealmSubmissionPolicy(client: PoolClient, realm: string,
  principal: string, actor: string, submission = true) {
  await client.query(`SELECT id FROM access.scope_gate WHERE id = $1 FOR SHARE`, [`governance:realm:${realm}`]);
  const ban = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
    AND owner_subject = $1 AND member_subject = $2 AND active
    AND (expires_at IS NULL OR expires_at > clock_timestamp())
    UNION ALL SELECT 1 FROM access.private_membership_ban WHERE kind = 'realm'
      AND owner_subject = $1 AND principal_id = $3 AND active LIMIT 1`, [realm, actor, principal]);
  if (ban.rowCount) throw new AdmissionDenied('Realm member is banned');
  const policy = (await client.query<{ who_may_submit: string; visibility: string }>(`
    SELECT who_may_submit,visibility FROM access.realm_admin_settings WHERE realm = $1 FOR SHARE`, [realm])).rows[0];
  if ((await client.query('SELECT 1 FROM access.realm_policy_delivery WHERE realm = $1 AND NOT delivered', [realm])).rowCount) {
    throw new AdmissionDenied('Realm policy publication is pending');
  }
  const needsMember = policy?.visibility === 'restricted' || policy?.visibility === 'private'
    || submission && policy?.who_may_submit === 'members';
  const owner = needsMember && (await client.query(`SELECT 1 FROM access.permission_grant WHERE scope_id = $1
    AND recipient_subject = $2 AND action = 'realm.owner' AND active AND valid_until > clock_timestamp()
    AND membership_id IS NULL LIMIT 1`, [`governance:realm:${realm}`, actor])).rowCount;
  if (submission && policy?.who_may_submit === 'closed' || needsMember && !owner
    && !await realmMemberProof(client, realm, principal, actor)) throw new AdmissionDenied('Realm submission policy denies this request');
}

/** Explicit grants must obey Realm participation bans too. Claim rechecks this
 * guard, so a ban invalidates an admission registered before the ban committed. */
export async function requireRealmParticipation(client: PoolClient, scope: string, action: string,
  principal: string, actor: string) {
  const prefix = action === 'submission.submit' ? 'submission:submit:'
    : action === 'reply.place' ? 'reply:place:' : action === 'publication.adopt' ? 'publication:adopt:' : null;
  if (!prefix || !scope.startsWith(prefix)) return;
  const realm = scope.slice(prefix.length);
  return requireRealmSubmissionPolicy(client, realm, principal, actor, action === 'submission.submit');
}
