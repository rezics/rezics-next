import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { realmSettings, RealmAdminInvalid, RealmAdminStale, type RealmSettings,
  type SettingsCommand } from '../realm-admin/contract.ts';
import { AdmissionDenied } from './admission.ts';
import { realmMemberProof } from '../realm-reply/member-policy.ts';
import { realmRulesRef } from '../governance/rules.ts';

const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Settings keep the localized title/body maps intact. The immutable rule
 * revision is shared with GovernanceRules, so moderation uses the exact basis. */
export async function readRealmSettings(client: PoolClient, realm: string) {
  const row = (await client.query<{ who_may_submit: RealmSettings['whoMaySubmit'] }>(`
    SELECT who_may_submit FROM access.realm_admin_settings WHERE realm = $1`, [realm])).rows[0];
  const rules = (await client.query<{ revision: string; digest: string; document: { rules?: unknown } }>(`
    SELECT h.revision::text,h.digest,r.document FROM access.governance_rule_head h
    JOIN access.governance_rule_revision r ON r.ref = h.ref AND r.revision = h.revision
    WHERE h.ref = $1 AND h.scope_id = $2`, [realmRulesRef(realm), `governance:realm:${realm}`])).rows[0];
  const settings = { visibility: 'public' as const, reviewRequired: true as const,
    whoMaySubmit: row?.who_may_submit ?? 'granted', rules: rules?.document.rules ?? [] };
  if (!Value.Check(realmSettings, settings)) throw new RealmAdminInvalid('Realm rules document has an unsupported shape');
  return { settings, ruleBasis: { ref: realmRulesRef(realm), revision: rules?.revision ?? null, digest: rules?.digest ?? null } };
}

export async function saveRealmSettings(client: PoolClient, realm: string, principalId: string,
  input: SettingsCommand, key: string) {
  const settings = input.settings;
  if (new Set(settings.rules.map(rule => rule.id)).size !== settings.rules.length
    || settings.rules.some(rule => [...Object.values(rule.title), ...Object.values(rule.body)].some(value => !value.trim()))) {
    throw new RealmAdminInvalid('Rules need unique identities and nonempty localized text');
  }
  const document = { profile: 'realm-settings-rules-v1', public: true, rules: settings.rules };
  if (Buffer.byteLength(JSON.stringify(document)) > 16_384) throw new RealmAdminInvalid('Rules exceed the governance document budget');
  const ref = realmRulesRef(realm);
  // Same absent-head serialization as GovernanceRules.publish, including generic
  // rule edits made outside this aggregate settings endpoint.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ref]);
  const prior = (await client.query<{ revision: string; scope_id: string }>(`
    SELECT revision::text,scope_id FROM access.governance_rule_head WHERE ref = $1 FOR UPDATE`, [ref])).rows[0];
  if ((prior?.revision ?? null) !== input.expectedRulesRevision) throw new RealmAdminStale('Realm rules revision changed');
  const scope = `governance:realm:${realm}`;
  if (prior && prior.scope_id !== scope) throw new RealmAdminInvalid('Realm rules belong to another scope');
  const revision = (BigInt(prior?.revision ?? '0') + 1n).toString();
  const digest = hash(document);
  await client.query(`INSERT INTO access.governance_rule_head (ref,scope_id,revision,digest)
    VALUES ($1,$2,$3,$4) ON CONFLICT (ref) DO UPDATE SET revision = EXCLUDED.revision,digest = EXCLUDED.digest`,
  [ref, scope, revision, digest]);
  await client.query(`INSERT INTO access.governance_rule_revision
    (ref,revision,scope_id,digest,document,principal_id,acting_subject,idempotency_key,request_digest)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [ref, revision, scope, digest, document, principalId, input.actingSubject, hash({ realm, key }), hash(input)]);
  await client.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit) VALUES ($1,$2)
    ON CONFLICT (realm) DO UPDATE SET who_may_submit = EXCLUDED.who_may_submit`, [realm, settings.whoMaySubmit]);
  return { settings, ruleBasis: { ref, revision, digest } };
}

/** This is an additional Access restriction on the existing submission grant,
 * never a replacement for admission or a grant manufactured by UI settings. */
export async function requireRealmSubmissionPolicy(client: PoolClient, realm: string,
  principal: string, actor: string) {
  await client.query(`SELECT id FROM access.scope_gate WHERE id = $1 FOR SHARE`, [`governance:realm:${realm}`]);
  const ban = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
    AND owner_subject = $1 AND member_subject = $2 AND active
    AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`, [realm, actor]);
  if (ban.rowCount) throw new AdmissionDenied('Realm member is banned');
  const policy = (await client.query<{ who_may_submit: string }>(`
    SELECT who_may_submit FROM access.realm_admin_settings WHERE realm = $1 FOR SHARE`, [realm])).rows[0];
  if (policy?.who_may_submit === 'closed' || policy?.who_may_submit === 'members'
    && !await realmMemberProof(client, realm, principal, actor)) throw new AdmissionDenied('Realm submission policy denies this request');
}

/** Explicit grants must obey Realm participation bans too. Claim rechecks this
 * guard, so a ban invalidates an admission registered before the ban committed. */
export async function requireRealmParticipation(client: PoolClient, scope: string, action: string,
  principal: string, actor: string) {
  const prefix = action === 'submission.submit' ? 'submission:submit:'
    : action === 'reply.place' ? 'reply:place:' : null;
  if (!prefix || !scope.startsWith(prefix)) return;
  const realm = scope.slice(prefix.length);
  if (action === 'submission.submit') return requireRealmSubmissionPolicy(client, realm, principal, actor);
  await client.query('SELECT id FROM access.scope_gate WHERE id = $1 FOR SHARE', [`governance:realm:${realm}`]);
  const banned = await client.query(`SELECT 1 FROM access.membership_ban WHERE kind = 'realm'
    AND owner_subject = $1 AND member_subject = $2 AND active
    AND (expires_at IS NULL OR expires_at > clock_timestamp()) LIMIT 1`, [realm, actor]);
  if (banned.rowCount) throw new AdmissionDenied('Realm member is banned');
}
