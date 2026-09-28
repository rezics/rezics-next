import { isDeepStrictEqual } from 'node:util';
import { SeedApiError, type SeedApi } from './api.ts';
import { communityPeople, communityRealms, type CommunityRealm } from './community-plan.ts';
import { follow } from './feed.ts';
import { grantRealmProfileSeed, realmProfileClient } from './official-authority.ts';
import { grantHomeSeedAuthority, type LocalOperatorInput } from './operator.ts';
import { people, seedKey } from './plan.ts';
import { refreshSeedTokens, stableId, type SeedState, type Session, type SpaceReceipt, type WorkReceipt }
  from './state.ts';

// Community Realms as their founders make them through Main: create the Realm,
// open it to members with its rules, let members join, give the moderators
// their role and public consent, publish the profile and adopt the Works the
// community reads. Reads come first, so a replay changes nothing.

const short = (id: string) => id.slice(-36);
const query = (session: Session) => `actingSubject=${encodeURIComponent(session.actingSubject)}`;

export function person(state: SeedState, id: string): Session {
  const session = state.sessions.find(item => item.id === id);
  if (!session) throw new Error(`Demo person ${id} has no session`);
  return session;
}

/** A Work with a public selected text, from the base plan or an official Zone. */
export function publicWork(state: SeedState, id: string):
  { work: WorkReceipt; contribution: string; decision: string } | null {
  const shared = state.publicWorks.get(id);
  if (shared) return shared;
  const base = state.publicForRealm.get(id), work = state.created.get(id);
  return base && work ? { work, ...base } : null;
}

/** A Main read that answers 404 as absent and retries a graph that moves under it. */
export async function readMain<T>(api: SeedApi, path: string, token?: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${api.endpoints.main}${path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {});
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.ok) return await response.json() as T;
    if (attempt < 4 && [409, 503].includes(response.status)) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    throw new SeedApiError(`Main ${path}`, response.status, (await response.text()).slice(0, 300));
  }
}

interface Settings { generation: string; settings: { visibility: string; reviewMode?: string; selfJoin?: boolean;
  rules: unknown[] } & Record<string, unknown>; ruleBasis: { revision: string | null } }

async function roleChange(api: SeedApi, root: string, owner: Session, change: object, label: string, skipEmpty = false) {
  const roles = await readMain<{ generation: string }>(api, `${root}/roles?${query(owner)}`, owner.token);
  if (!roles) throw new Error('Realm roles are unavailable');
  const input = { actingSubject: owner.actingSubject, expectedGeneration: roles.generation,
    reason: 'Give the community’s moderators their role', change };
  const preview = await api.post<{ digest: string; affectedCount: number }>(`${root}/role-impact`, input,
    owner.token, seedKey('community-role-impact', `${label}:${roles.generation}`));
  if (skipEmpty && preview.affectedCount === 0) return;
  await api.post(`${root}/role-changes`, { ...input, impactDigest: preview.digest }, owner.token,
    seedKey('community-role', `${label}:${roles.generation}`));
}

/** Open to members who join on their own; trusted members' replies are placed without a queue. */
async function openRealm(api: SeedApi, plan: CommunityRealm, root: string, owner: Session) {
  await api.post(`${root}/management`, { actingSubject: owner.actingSubject }, owner.token,
    seedKey('realm-management', `community:${plan.id}`));
  const rules = plan.rules.map(rule => ({ ...rule, governanceRule: null }));
  const current = await readMain<Settings>(api, `${root}/settings?${query(owner)}`, owner.token);
  if (!current) throw new Error(`Realm ${plan.id} settings are unavailable`);
  const desired = { ...current.settings, visibility: 'public', selfJoin: true, reviewMode: 'trusted-members',
    reviewRequired: false, rules };
  if (isDeepStrictEqual(desired, current.settings)) return;
  await api.put(`${root}/settings`, { actingSubject: owner.actingSubject, expectedGeneration: current.generation,
    reason: 'Open the community to readers and publish its rules', settings: desired,
    expectedRulesRevision: current.ruleBasis.revision }, owner.token,
  seedKey('community-settings', `${plan.id}:${current.generation}`));
}

async function join(state: SeedState, plan: CommunityRealm, root: string) {
  let joined = 0;
  for (const member of plan.members.filter(id => id !== plan.owner).map(id => person(state, id))) {
    const policy = await readMain<{ selfJoin: boolean; open: boolean; state: string; membershipGeneration: string;
      policyRevision: string; termsRevision: string }>(state.api, `${root}/joining?${query(member)}`, member.token);
    if (!policy || policy.state === 'joined') continue;
    if (!policy.selfJoin || !policy.open) throw new Error(`Realm ${plan.id} is not open to members`);
    await state.api.post(`${root}/join`, { actingSubject: member.actingSubject,
      expectedMembershipGeneration: policy.membershipGeneration, expectedPolicyRevision: policy.policyRevision,
      termsRevision: policy.termsRevision, listed: true }, member.token,
    seedKey('community-join', `${plan.id}:${member.id}:${policy.membershipGeneration}`));
    joined++;
  }
  return joined;
}

async function moderatorRole(state: SeedState, plan: CommunityRealm, root: string, owner: Session) {
  const roleId = stableId(`community-moderators:${plan.id}`);
  const roles = await readMain<{ roles: { id: string }[] }>(state.api, `${root}/roles?${query(owner)}`, owner.token);
  if (!roles) throw new Error(`Realm ${plan.id} roles are unavailable`);
  if (!roles.roles.some(role => role.id === roleId)) {
    await roleChange(state.api, root, owner, { kind: 'role', roleId, name: 'Moderators',
      permissions: ['governance.moderate', 'realm.members.manage', 'review.decide'] }, `${plan.id}:role`);
  }
  for (const moderator of plan.moderators.map(id => person(state, id))) {
    await roleChange(state.api, root, owner, { kind: 'assignment', roleId, member: moderator.actingSubject,
      assigned: true, validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString() },
    `${plan.id}:${moderator.id}`, true);
  }
}

/** The public profile: name, description, rules and the moderators who agreed to be listed. */
async function profile(state: SeedState, operator: LocalOperatorInput, plan: CommunityRealm, realm: string,
  owner: Session, client: SeedApi, tokens: Map<string, string>) {
  const root = `/v1/realms/${short(realm)}`;
  const token = async (id: string) => {
    let value = tokens.get(id);
    if (!value) {
      const credentials = [...people, ...communityPeople].find(item => item.id === id);
      if (!credentials) throw new Error(`Demo person ${id} has no credentials`);
      value = await client.token((await client.signInOrUp(credentials)).cookie);
      tokens.set(id, value);
    }
    return value;
  };
  const moderators: string[] = [];
  for (const moderator of plan.moderators.map(id => person(state, id))) {
    await grantRealmProfileSeed({ ...operator, ownerAccountSubject: moderator.accountId,
      actingSubject: moderator.actingSubject }, [{ action: 'realm.moderator.choose', realm,
      agent: moderator.actingSubject }]);
    await client.put(`${root}/moderators/${short(moderator.actingSubject)}/public-choice`, {
      profile: 'realm-public-moderator-choice-v1', expectedHead: null, public: true,
      actingSubject: moderator.actingSubject }, await token(moderator.id),
    seedKey('community-moderator-choice', `${plan.id}:${moderator.id}`)).catch((error: unknown) => {
      // A choice made on an earlier run stands; only its first command has no head.
      if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
    });
    moderators.push(moderator.actingSubject);
  }
  const header = await readMain<{ profileRevision: string | null; description: { value: string } | null;
    moderators: { items: string[] } }>(state.api, `${root}?language=en`);
  if (header?.description?.value === plan.description.en
    && JSON.stringify(header.moderators.items) === JSON.stringify(moderators)) return;
  await grantRealmProfileSeed({ ...operator, ownerAccountSubject: owner.accountId, actingSubject: owner.actingSubject },
    [{ action: 'realm.profile.publish', realm }]);
  await client.put(`${root}/profile`, { profile: 'realm-public-profile-v1',
    expectedHead: header?.profileRevision ?? null, actingSubject: owner.actingSubject,
    publication: { name: plan.name, description: plan.description, iconSelection: null, bannerSelection: null,
      rules: plan.rules.map(rule => ({ ...rule, governanceRule: null })),
      count: { kind: 'exact', value: null }, moderators } },
  await token(owner.id), seedKey('community-profile', `${plan.id}:${header?.profileRevision?.slice(-12) ?? 'first'}`));
}

async function adopt(state: SeedState, operator: LocalOperatorInput, plan: CommunityRealm, realm: string,
  owner: Session) {
  await grantHomeSeedAuthority({ ...operator, ownerAccountSubject: owner.accountId, actingSubject: owner.actingSubject },
    [{ action: 'publication.adopt', scope: `publication:adopt:${realm}` }]);
  let adopted = 0;
  for (const id of plan.adopt) {
    const target = publicWork(state, id);
    if (!target) throw new Error(`Community Realm ${plan.id} cannot adopt ${id}: it has no public text`);
    await state.api.post('/v1/publication-selections', { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: realm }, work: target.work.work, mainVersion: target.work.mainVersion,
      contribution: target.contribution, publicationDecision: target.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review', actingSubject: owner.actingSubject }, owner.token,
    seedKey('community-adoption', `${plan.id}:${id}`));
    adopted++;
  }
  return adopted;
}

/** The community Realms, each on its own so one failing leaves the others. */
export async function seedCommunityRealms(state: SeedState) {
  const operator = state.operatorInput;
  if (!operator) {
    state.findings.add('Community Realms: the local fixture operator is unavailable');
    return;
  }
  const client = await realmProfileClient(operator);
  const tokens = new Map<string, string>();
  let joined = 0, adopted = 0;
  // The Realms share nothing but their members' sessions, so they are made side by side.
  await Promise.all(communityRealms.map(async plan => {
    await refreshSeedTokens(state);
    await state.optional(`Community Realm ${plan.id}`, async () => {
      const owner = person(state, plan.owner);
      const receipt = await state.api.post<SpaceReceipt>('/v1/spaces', { profile: 'space-realm-v2',
        name: `${plan.name.en} · ${plan.name['zh-CN']}`, capabilities: ['realm'], actingSubject: owner.actingSubject },
      owner.token, seedKey('community-realm', plan.id));
      const root = `/v1/realms/${short(receipt.realm)}`;
      await openRealm(state.api, plan, root, owner);
      joined += await join(state, plan, root);
      await moderatorRole(state, plan, root, owner);
      await profile(state, operator, plan, receipt.realm, owner, client, tokens);
      adopted += await adopt(state, operator, plan, receipt.realm, owner);
      // Members follow the Realms they join, so Home and the sidebar carry them.
      for (const member of plan.members.map(id => person(state, id))) {
        await follow(state.api, member, receipt.realm, 'realm',
          seedKey('follow', `${member.id}:realm:${plan.id}:${short(receipt.realm)}`));
      }
      state.communityRealms.set(plan.id, { realm: receipt.realm, owner });
    });
  }));
  console.log(`Community Realms: ${state.communityRealms.size}/${communityRealms.length}, ${joined} new members, ${adopted} adoptions.`);
}
