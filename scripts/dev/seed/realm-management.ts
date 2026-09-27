import { createHash } from 'node:crypto';
import { SeedApi, SeedApiError } from './api.ts';
import { seedKey } from './plan.ts';

interface Session { id: string; token: string; actingSubject: string }
interface Work { work: string; workRevision: string }
interface Roles { generation: string; roles: { id: string; name: string }[] }

/** One populated management example, created exclusively through public APIs. */
export async function seedRealmManagement(api: SeedApi, realm: string, owner: Session,
  moderators: Session[], works: Work[]) {
  const root = `/v1/realms/${realm.slice(-36)}`;
  await api.post(`${root}/management`, { actingSubject: owner.actingSubject }, owner.token,
    seedKey('realm-management', realm.slice(-36)));
  const roles = async (): Promise<Roles> => {
    const response = await fetch(`${api.endpoints.main}${root}/roles?actingSubject=${encodeURIComponent(owner.actingSubject)}`,
      { headers: { authorization: `Bearer ${owner.token}` } });
    if (!response.ok) throw new SeedApiError('Realm roles', response.status, await response.text());
    return response.json() as Promise<Roles>;
  };
  const hex = createHash('sha256').update(`${realm}:demo-moderators`).digest('hex').slice(0, 32);
  const roleId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const change = async (value: object, label: string, skipEmpty = false) => {
    const current = await roles();
    const input = { actingSubject: owner.actingSubject, expectedGeneration: current.generation,
      reason: 'Set up the Classic Literature moderation team', change: value };
    const preview = await api.post<{ digest: string; affectedCount: number }>(`${root}/role-impact`, input,
      owner.token, seedKey('realm-impact', label));
    if (skipEmpty && preview.affectedCount === 0) return;
    await api.post(`${root}/role-changes`, { ...input, impactDigest: preview.digest }, owner.token,
      seedKey('realm-role', `${label}:${current.generation}`));
  };
  if (!(await roles()).roles.some(role => role.id === roleId)) {
    await change({ kind: 'role', roleId, name: 'Community moderators',
      permissions: ['governance.moderate', 'realm.members.manage'] }, 'moderators');
  }
  for (const moderator of moderators) await change({ kind: 'assignment', roleId,
    member: moderator.actingSubject, assigned: true,
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() }, moderator.id, true);
  for (const [index, work] of works.slice(0, 8).entries()) {
    const idempotencyKey = seedKey('realm-report', `${realm.slice(-36)}:${index}`);
    await api.post('/v1/reports', { profile: 'content-report-v1', actingSubject: owner.actingSubject,
      authority: { kind: 'realm', scopeId: `governance:realm:${realm}` }, context: realm,
      target: { owner: 'graph', resource: work.work, component: 'title' }, disclosure: 'private',
      reasonCode: index % 2 ? 'title_review' : 'edition_details',
      statement: index % 2 ? 'Check whether the title identifies the edition clearly.'
        : 'Review the edition details before adding this work to the community reading list.',
      evidence: [{ owner: 'graph', resource: work.work, component: 'title',
        revision: work.workRevision, locator: null }], idempotencyKey }, owner.token, idempotencyKey);
  }
}
