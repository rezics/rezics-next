import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { classifyRealmSpacePage } from '../address/space-page.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { MainClient } from '../discover/types.ts';
import { commandFailure, type CommandFailure } from '../manage/commands.ts';
import { readAgents, readRealmHeader, settle } from '../manage/read.ts';
import { realmEditSite } from '../manage/realm-site.ts';
import { readPrivateSpaceJoinPage, readRequestsAtAddress, type JoinBasis, type RequestPage } from '../manage/settings-api.ts';
import { problemCode, uuidOf, type RealmHeader as ManageRealmHeader } from '../manage/types.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { readMembership, type Membership } from './membership-state.ts';
import type { RealmHeader } from './types.ts';

/** Which recorded page the production route can reach. */
export type MembershipSurface = 'landing' | 'joined' | 'requests' | 'basis';

export type RecordedMembershipView =
  | { kind: 'join'; page: Extract<ReturnType<typeof classifyRealmSpacePage>, { kind: 'join' }>['page'] }
  | { kind: 'joined'; header: RealmHeader; membership: Membership; actingSubject: string }
  | { kind: 'requests'; space: string; realm: string; page: RequestPage; header: ManageRealmHeader; agent: AgentOption; siteHref: string | null }
  | { kind: 'refusal'; failure: CommandFailure; code?: string; problemTitle: string | null };

const recordedOrigin = 'https://recorded.invalid';

export function recordedSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

export function recordedRealmId(path: string): string | null {
  return new URL(path, recordedOrigin).pathname.match(/\/v1\/(?:realms|spaces)\/([0-9a-f-]{36})/)?.[1] ?? null;
}

export function recordedSubject(path: string): string | null {
  return new URL(path, recordedOrigin).searchParams.get('actingSubject');
}

/** Realm and acting Person named by the selected samples. Agent profile paths name neither Realm. */
export function recordedIdentity(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]):
  { realm: string; actingSubject: string | null } {
  let realm: string | null = null;
  let actingSubject: string | null = null;
  for (const item of selections) {
    const sample = recordedSample(record, persona, item.label);
    realm ??= recordedRealmId(sample.path);
    actingSubject ??= recordedSubject(sample.path);
  }
  if (!realm) throw new Error(`Recorded ${record.row}/${persona} selections name no Realm`);
  return { realm, actingSubject };
}

function problemTitle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('title' in value)) return null;
  const title = (value as { title: unknown }).title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

function raise(probe: () => string | null) {
  const missed = probe();
  if (missed) throw new Error(missed);
}

function headerOf(answer: { data: unknown; error: { status: number; value: unknown } | null; status?: number }):
  { ok: boolean; status: number; body: unknown } {
  const status = answer.status ?? answer.error?.status ?? 0;
  return { ok: answer.data != null, status, body: answer.data ?? answer.error?.value ?? null };
}

/** The same basis read as membership administration, keeping the problem sentence the command adapter drops. */
export async function readAdmissionBasis(main: MainClient, realm: string, actingSubject: string):
  Promise<Extract<RecordedMembershipView, { kind: 'refusal' }> | { kind: 'basis'; data: JoinBasis }> {
  const answer = await main.v1.realms({ realm: uuidOf(realm) })['join-requests'].basis.get({ query: { actingSubject } });
  if (answer.data) return { kind: 'basis', data: answer.data };
  const code = problemCode(answer.error?.value);
  return { kind: 'refusal', failure: commandFailure(answer.error?.status ?? answer.status ?? 0, code),
    ...(code ? { code } : {}), problemTitle: problemTitle(answer.error?.value) };
}

/**
 * Membership and admission the community and request routes already read.
 * `probe` reports a replay that matched nothing, including a failure the typed
 * client turned into an empty result.
 */
export async function loadRecordedMembership(main: MainClient, input: {
  surface: MembershipSurface; realm: string; actingSubject: string | null; locale: UiLocale;
}, probe: () => string | null = () => null): Promise<RecordedMembershipView> {
  if (input.surface === 'basis') {
    if (!input.actingSubject) throw new Error('Recorded admission basis names no acting Person');
    const basis = await readAdmissionBasis(main, input.realm, input.actingSubject);
    raise(probe);
    if (basis.kind === 'basis') throw new Error('Recorded admission basis succeeded; this page shows its refusal');
    return basis;
  }
  if (input.surface === 'landing') {
    const header = headerOf(await main.v1.realms({ realm: input.realm }).get({ query: {} }));
    raise(probe);
    const landing = !header.ok && [401, 403, 404].includes(header.status)
      ? await readPrivateSpaceJoinPage(main, input.realm) : null;
    raise(probe);
    const classified = classifyRealmSpacePage(input.realm, header, landing
      ? { ok: landing.ok, status: landing.ok ? 200 : 0, body: landing.ok ? landing.data : null } : null);
    if (classified.kind !== 'join') throw new Error(`Recorded join landing resolved to ${classified.kind}`);
    return { kind: 'join', page: classified.page };
  }
  if (input.surface === 'joined') {
    if (!input.actingSubject) throw new Error('Recorded joined Realm names no acting Person');
    const header = headerOf(await main.v1.realms({ realm: input.realm }).get({ query: { actingSubject: input.actingSubject } }));
    raise(probe);
    const classified = classifyRealmSpacePage(input.realm, header, null);
    if (classified.kind !== 'realm') throw new Error(`Recorded joined Realm resolved to ${classified.kind}`);
    const membership = await readMembership(main, classified.header.id, input.actingSubject);
    raise(probe);
    return { kind: 'joined', header: classified.header, membership, actingSubject: input.actingSubject };
  }
  if (!input.actingSubject) throw new Error('Recorded join requests name no acting Person');
  const actingSubject = input.actingSubject;
  const requests = await readRequestsAtAddress(main, input.realm, actingSubject);
  raise(probe);
  if (!requests.ok) throw new Error(`Recorded join requests failed: ${requests.failure}`);
  const [header, siteHref, names] = await Promise.all([
    readRealmHeader(main, input.realm, input.locale, actingSubject),
    realmEditSite({
      zone: () => settle(() => main.v1.realms({ realm: input.realm }).zone.get({ query: { actingSubject } })),
      editor: () => Promise.reject(new Error('No recorded Zone editor read')),
    }),
    readAgents(main, [actingSubject], actingSubject),
  ]);
  raise(probe);
  if (!header.ok) throw new Error(`Recorded management Realm failed: ${header.failure}`);
  const agent = names[actingSubject];
  return { kind: 'requests', space: requests.data.space, realm: requests.data.realm, page: requests.data.page,
    header: header.data, siteHref, agent: { iri: actingSubject, label: agent?.label ?? null, handle: agent?.handle ?? null,
      kind: null, path: null } };
}
