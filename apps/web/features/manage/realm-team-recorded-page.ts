import { changeRole, previewRole, type Outcome } from './commands.ts';
import { readAgents, readMembers, readOutgoingInvitations, readRealmHeader, readRoles, settle } from './read.ts';
import { realmEditSite } from './realm-site.ts';
import type { AgentSummary, InvitationPage, Loaded, MainClient, MemberPage, ReadFailure, RealmHeader, Role,
  RoleCommand, RoleImpact, RoleList, RoleReceipt } from './types.ts';

/**
 * Roles and members, from the reads the management routes already issue.
 * Callers supply the client: the request-cached host client in production,
 * the replaying client in a story. A 404 Zone read does not continue into
 * presentation or the editor, so the frame has no site link.
 */

export interface RealmTeamProblem {
  status: number;
  title: string;
  code: string;
}

export type RealmRolesMapped =
  | { kind: 'roles'; list: RoleList }
  | { kind: 'refusal'; failure: ReadFailure; problem: RealmTeamProblem | null };

export type RealmMembersMapped =
  | {
    kind: 'members';
    page: MemberPage;
    roles: readonly Role[] | null;
    invitations: Loaded<InvitationPage>;
    roleFilter: { id: string; name: string | null } | null;
    empty: boolean;
  }
  | { kind: 'refusal'; failure: ReadFailure; problem: RealmTeamProblem | null };

export interface RealmTeamClients {
  main: MainClient;
  /** Public profiles. Management reads return ids only, and this client sends no acting subject. */
  anonymous: MainClient;
}

export interface RealmTeamFrame {
  header: RealmHeader | null;
  /** Null when the Realm has no Zone, including a 404. The editor read does not run. */
  siteHref: string | null;
}

export interface RealmRolesPage {
  roles: Loaded<RoleList>;
  agents: Record<string, AgentSummary>;
}

export interface RealmMembersPage {
  page: Loaded<MemberPage>;
  roles: Loaded<RoleList>;
  invitations: Loaded<InvitationPage>;
  agents: Record<string, AgentSummary>;
}

/** The roles route and the recorded page share this decision. */
export function mapRealmRoles(list: Loaded<RoleList>, problem: RealmTeamProblem | null = null): RealmRolesMapped {
  if (!list.ok) return { kind: 'refusal', failure: list.failure, problem: list.problem ?? problem };
  return { kind: 'roles', list: list.data };
}

/** The members route and the recorded page share this decision. An invitations failure stays on the page. */
export function mapRealmMembers(page: Loaded<MemberPage>, roles: Loaded<RoleList>, invitations: Loaded<InvitationPage>,
  roleId: string | null, problem: RealmTeamProblem | null = null): RealmMembersMapped {
  if (!page.ok) return { kind: 'refusal', failure: page.failure, problem: page.problem ?? problem };
  const named = roleId && roles.ok ? roles.data.roles.find(item => item.id === roleId)?.name ?? null : null;
  return {
    kind: 'members', page: page.data, roles: roles.ok ? roles.data.roles : null, invitations,
    roleFilter: roleId ? { id: roleId, name: named } : null, empty: page.data.items.length === 0,
  };
}

export function problemOf(status: number, value: unknown): RealmTeamProblem | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return null;
  if (typeof body.status === 'number' && body.status !== status) return null;
  return { status, title: body.title, code: body.code };
}

/**
 * The layout's Realm header and Zone reads. The editor read is the layout's,
 * and it runs only after the Zone read succeeds.
 */
export async function readRealmTeamFrame(main: MainClient, realm: string, actingSubject: string, locale: string):
  Promise<RealmTeamFrame> {
  const [header, siteHref] = await Promise.all([
    readRealmHeader(main, realm, locale, actingSubject),
    realmEditSite({
      zone: () => settle(() => main.v1.realms({ realm }).zone.get({ query: { actingSubject } })),
      editor: zoneId => settle(() => main.v1.zones({ id: zoneId })['showcase-editor'].get({
        query: { actingSubject } }), { management: true }),
    }),
  ]);
  return { header: header.ok ? header.data : null, siteHref };
}

/** Each role card names its first three holders. A Realm at the cap is 32 cards. */
const HOLDER_NAMES = 32 * 3;

/** The roles route's reads: the role list, then public names for its holders. */
export async function readRealmRolesPage(clients: RealmTeamClients, input: { realm: string; actingSubject: string }):
  Promise<RealmRolesPage> {
  const roles = await readRoles(clients.main, input.realm, input.actingSubject);
  if (!roles.ok) return { roles, agents: {} };
  const agents = await readAgents(clients.anonymous, roles.data.roles.flatMap(role =>
    role.holders?.map(holder => holder.member) ?? []), undefined, HOLDER_NAMES);
  return { roles, agents };
}

/**
 * The members route's reads. Roles and invitations are requested with the
 * roster; a roster refusal does not stand in for either of them.
 */
export async function readRealmMembersPage(clients: RealmTeamClients, input: {
  realm: string; actingSubject: string; role?: string | null;
}): Promise<RealmMembersPage> {
  const [page, roles, invitations] = await Promise.all([
    readMembers(clients.main, input.realm, { actingSubject: input.actingSubject, role: input.role }),
    readRoles(clients.main, input.realm, input.actingSubject),
    readOutgoingInvitations(clients.main, input.realm, input.actingSubject),
  ]);
  if (!page.ok) return { page, roles, invitations, agents: {} };
  const agents = await readAgents(clients.anonymous, [
    ...page.data.items.map(item => item.member),
    ...invitations.ok ? invitations.data.items.map(item => item.member) : [],
  ]);
  return { page, roles, invitations, agents };
}

export interface RecordedRoleSave {
  preview: Outcome<RoleImpact>;
  saved: Outcome<RoleReceipt> | null;
}

/**
 * The dialog saves only after the impact preview. The digest on the change
 * is the preview's, at the command's compare-and-set generation.
 */
export async function saveRecordedRole(main: MainClient, realm: string, command: RoleCommand, key: string):
  Promise<RecordedRoleSave> {
  const preview = await previewRole(main, realm, command);
  if (!preview.ok) return { preview, saved: null };
  const saved = await changeRole(main, realm, command, preview.data.digest, key);
  return { preview, saved };
}

/** One stable key for a recorded role command. The record redacts the original key. */
export const recordedRoleCommandKey = 'recorded-role-change';

export function recordedRoleCommand(body: unknown): { command: RoleCommand; impactDigest: string | null } {
  if (!body || typeof body !== 'object') throw new Error('Recorded role command is not a record');
  const record = body as Record<string, unknown>;
  const { impactDigest, ...command } = record;
  if (typeof command.actingSubject !== 'string' || typeof command.expectedGeneration !== 'string'
    || typeof command.reason !== 'string' || !command.change || typeof command.change !== 'object') {
    throw new Error('Recorded role command is missing actingSubject, expectedGeneration, reason or change');
  }
  return {
    command: command as RoleCommand,
    impactDigest: typeof impactDigest === 'string' ? impactDigest : null,
  };
}
