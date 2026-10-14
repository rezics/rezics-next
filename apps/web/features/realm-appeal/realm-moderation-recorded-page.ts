import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { MainClient } from '../discover/types.ts';
import { noNames, readQueueNames, type QueueApi } from '../manage/queue-api.ts';
import { readAgents, readDecisionBasis, readQueue, readRealmHeader, type QueueQuery } from '../manage/read.ts';
import type { QueueView } from '../manage/routes.ts';
import type { DecisionBasis, ModerationPage, RealmHeader } from '../manage/types.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { postMemberAppeal, readAppealReceipt, readMemberBan } from './ban-read.ts';
import { banProblem, type BanProblem, type BanReading } from './reading.ts';

// The moderation queue and the member's ban panel, from the same readers the
// routes use. A story passes the replaying client. The queue only asks for a
// decision basis on reports and rights complaints, so a sanction appeal's
// basis is read here and shown beside the queue.

/** Header the appeal command keeps when the record has no idempotency key. Headers are not part of a recorded match. */
export const recordedAppealKey = 'recorded-appeal';

const recordedOrigin = 'https://recorded.invalid';
const recordedMiss = /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply/;

export type RealmModerationMapped =
  | {
    kind: 'queue';
    realm: string;
    actingSubject: string;
    agent: AgentOption;
    header: RealmHeader;
    page: ModerationPage;
    view: QueueView;
    basis: DecisionBasis | null;
    /** The sanction appeal receipt, when the selection recorded one and the queue did not also record a command. */
    appeal: BanReading | null;
  }
  | { kind: 'appeal'; realm: string; reading: BanReading }
  | { kind: 'refusal'; problem: BanProblem }
  | { kind: 'discrepancy'; detail: string };

type SampleKind = 'command' | 'ban' | 'appeal' | 'basis' | 'queue' | 'header' | 'agent' | 'skip';

interface Chosen { sample: AnswerSample; kind: SampleKind }

function located(sample: AnswerSample): URL {
  return new URL(sample.path, recordedOrigin);
}

function segment(sample: AnswerSample, index: number): string {
  return located(sample).pathname.split('/')[index] ?? '';
}

function realmId(sample: AnswerSample): string {
  return segment(sample, 3);
}

function actingSubject(sample: AnswerSample): string | null {
  return located(sample).searchParams.get('actingSubject');
}

function kindOf(sample: AnswerSample): SampleKind {
  const path = located(sample).pathname;
  if (sample.method === 'POST') return 'command';
  if (/\/member-ban$/.test(path)) return 'ban';
  if (/\/appeal$/.test(path)) return 'appeal';
  if (/\/moderation\/[^/]+$/.test(path)) return 'basis';
  if (/\/moderation$/.test(path)) return 'queue';
  if (/^\/v1\/realms\/[^/]+$/.test(path)) return 'header';
  if (/^\/v1\/agents\/[^/]+$/.test(path)) return 'agent';
  return 'skip';
}

function one(items: readonly Chosen[], kind: SampleKind): Chosen | null {
  const found = items.filter(item => item.kind === kind);
  return found.length === 1 ? found[0]! : null;
}

function discrepancy(detail: string): RealmModerationMapped {
  return { kind: 'discrepancy', detail };
}

function fromBan(realm: string, read: Awaited<ReturnType<typeof readMemberBan>>): RealmModerationMapped {
  if (read.ok) return { kind: 'appeal', realm, reading: read.reading };
  if (read.discrepancy) return discrepancy(read.discrepancy);
  if (read.problem) return { kind: 'refusal', problem: read.problem };
  return discrepancy(`recorded ban read ${read.status} kept no problem title`);
}

function statementOf(sample: AnswerSample): string | null {
  const body = sample.body;
  return body && typeof body === 'object' && 'statement' in body && typeof body.statement === 'string'
    ? body.statement : null;
}

function queueQuery(sample: AnswerSample): QueueQuery | null {
  const url = located(sample);
  const state = url.searchParams.get('state');
  const acting = url.searchParams.get('actingSubject');
  if ((state !== 'open' && state !== 'closed') || !acting) return null;
  const type = url.searchParams.get('type');
  const reason = url.searchParams.get('reason');
  const cursor = url.searchParams.get('cursor');
  return {
    actingSubject: acting, state, type: type as QueueQuery['type'],
    ...(reason ? { reason } : {}), ...(cursor ? { cursor } : {}),
  };
}

async function hold(client: MainClient, sample: AnswerSample): Promise<void> {
  const realm = realmId(sample);
  const acting = actingSubject(sample);
  if (kindOf(sample) === 'queue') {
    const query = queueQuery(sample);
    if (query) await readQueue(client, realm, query);
    return;
  }
  if (kindOf(sample) === 'ban' && acting) {
    await readMemberBan(client, realm, acting);
    return;
  }
  if (kindOf(sample) === 'appeal') {
    await readAppealReceipt(client, realm, segment(sample, 5));
    return;
  }
  if (kindOf(sample) === 'basis' && acting) {
    await readDecisionBasis(client, realm, segment(sample, 5), acting);
    return;
  }
  if (kindOf(sample) === 'header' && acting) {
    const language = located(sample).searchParams.get('language');
    if (language) await readRealmHeader(client, realm, language, acting);
    return;
  }
  if (kindOf(sample) === 'agent' && acting) await readAgents(client, [acting], acting);
  if (kindOf(sample) === 'command') {
    const statement = statementOf(sample);
    if (statement) await postMemberAppeal(client, realm, segment(sample, 5), statement, recordedAppealKey);
  }
}

async function fromCommand(client: MainClient, sample: AnswerSample): Promise<RealmModerationMapped> {
  const statement = statementOf(sample);
  if (!statement) return discrepancy('appeal command record has no statement');
  const answer = await postMemberAppeal(client, realmId(sample), segment(sample, 5), statement, recordedAppealKey);
  if (!answer.response && answer.error) {
    const value = answer.error.value;
    if (value instanceof Error && recordedMiss.test(value.message)) throw value;
    if (value instanceof DOMException && value.name === 'AbortError') throw value;
  }
  if (answer.error) {
    const problem = banProblem(answer.error.status, answer.error.value);
    if (problem) return { kind: 'refusal', problem };
    return discrepancy(`appeal command ${answer.error.status} kept no problem title`);
  }
  // A 201 names the case. The receipt the member sees is a later recorded read.
  return discrepancy('appeal command admitted; the receipt read is a separate recorded answer');
}

async function fromQueue(client: MainClient, items: readonly Chosen[], queue: Chosen): Promise<RealmModerationMapped> {
  const query = queueQuery(queue.sample);
  if (!query) return discrepancy('queue record names no acting Person or open/closed state');
  const header = one(items, 'header');
  const agentSample = one(items, 'agent');
  if (!header) return discrepancy('queue page has no recorded realm header');
  if (!agentSample) return discrepancy('queue page has no recorded acting agent');
  const language = located(header.sample).searchParams.get('language');
  // The realm header read always sends a language. A record without one cannot be that read.
  if (!language) return discrepancy('realm header record has no language, and the realm header read always sends one');
  const realm = realmId(queue.sample);
  if (realmId(header.sample) !== realm) return discrepancy('realm header is for another realm');
  const profile = segment(agentSample.sample, 3);
  if (!query.actingSubject.endsWith(profile)) return discrepancy('acting agent profile is not the queue actor');
  const basisSample = one(items, 'basis');
  const appealSample = items.some(item => item.kind === 'command') ? null : one(items, 'appeal');
  const [headerRead, agents, page] = await Promise.all([
    readRealmHeader(client, realm, language, query.actingSubject),
    readAgents(client, [query.actingSubject], query.actingSubject),
    readQueue(client, realm, query),
  ]);
  if (!headerRead.ok) return discrepancy(`realm header read failed (${headerRead.failure})`);
  const named = agents[query.actingSubject];
  if (!named?.label) return discrepancy('acting agent read returned no name');
  if (!page.ok) return discrepancy(`moderation queue read failed (${page.failure})`);
  let basis: DecisionBasis | null = null;
  if (basisSample) {
    const caseId = segment(basisSample.sample, 5);
    const read = await readDecisionBasis(client, realm, caseId, query.actingSubject);
    if (!read.ok) return discrepancy(`decision basis read failed (${read.failure})`);
    if (read.data.caseId !== caseId) return discrepancy('decision basis case does not match the request');
    if (page.data.items.length && !page.data.items.some(item => item.id === caseId)) {
      return discrepancy('decision basis is not an item on the recorded queue');
    }
    basis = read.data;
  }
  let appeal: BanReading | null = null;
  if (appealSample) {
    const receipt = segment(appealSample.sample, 5);
    const read = await readAppealReceipt(client, realm, receipt);
    if (!read.ok) {
      return discrepancy(read.discrepancy ?? read.problem?.title ?? `appeal read ${read.status} kept no problem title`);
    }
    const caseId = read.reading.appeal.state === 'none' ? null : read.reading.appeal.caseId;
    const onPage = page.data.items.some(item => item.target.resource === read.reading.receiptId || item.id === caseId);
    if (page.data.items.length && !onPage) return discrepancy('appeal receipt is not the queue item');
    appeal = read.reading;
  }
  return {
    kind: 'queue', realm, actingSubject: query.actingSubject,
    agent: { iri: query.actingSubject, label: named.label, handle: named.handle, kind: null, path: null },
    header: headerRead.data, page: page.data,
    view: { state: query.state, type: query.type, reason: query.reason ?? null },
    basis, appeal,
  };
}

/**
 * The recorded moderation queue or the recorded ban receipt.
 * Call only the readers the selection names, so a held request is the only request.
 * Platform access is not a page: an empty grant is a closed gate, reported by the caller, not drawn here.
 */
export async function readRealmModerationRecorded(client: MainClient, record: AnswerRecord, persona: AnswerPersona,
  selections: readonly RecordedSelection[]): Promise<RealmModerationMapped> {
  const chosen: Chosen[] = [];
  for (const selection of selections) {
    const found = record.personas[persona].filter(item => item.label === selection.label);
    if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${selection.label}`);
    chosen.push({ sample: found[0]!, kind: kindOf(found[0]!) });
  }
  if (selections.some(item => item.state === 'loading')) {
    await Promise.all(chosen.filter((_item, index) => selections[index]?.state === 'loading').map(item => hold(client, item.sample)));
    return discrepancy('loading selection resolved');
  }
  const pages = chosen.filter(item => item.kind !== 'skip');
  if (!pages.length) return discrepancy('no recorded page read in the selection');
  if (pages.filter(item => item.kind === 'queue').length > 1) return discrepancy('two queue reads share one request');
  const queue = one(pages, 'queue');
  if (queue) {
    if (pages.filter(item => item.kind === 'header').length > 1) return discrepancy('two realm header reads share one request');
    if (pages.filter(item => item.kind === 'ban').length) return discrepancy('a queue and a ban read are both selected');
    return fromQueue(client, pages, queue);
  }
  const bans = pages.filter(item => item.kind === 'ban');
  const appeals = pages.filter(item => item.kind === 'appeal');
  const commands = pages.filter(item => item.kind === 'command');
  if (bans.length > 1) return discrepancy('two ban reads share one request');
  if (appeals.length > 1) return discrepancy('two appeal reads share one request');
  if (bans.length && appeals.length && !commands.length) return discrepancy('ban and appeal reads are both selected');
  if (bans.length === 1) {
    const acting = actingSubject(bans[0]!.sample);
    if (!acting) return discrepancy('ban record names no acting Person');
    return fromBan(realmId(bans[0]!.sample), await readMemberBan(client, realmId(bans[0]!.sample), acting));
  }
  if (appeals.length === 1 && !commands.length) {
    const sample = appeals[0]!.sample;
    return fromBan(realmId(sample), await readAppealReceipt(client, realmId(sample), segment(sample, 5)));
  }
  if (commands.length === 1) return fromCommand(client, commands[0]!.sample);
  return discrepancy('no recorded page read in the selection');
}

/** Later queue reads stay on the same client. This case has no recorded decision command. */
export function recordedModerationQueueApi(client: MainClient, realm: string, actingSubject: string, locale: string): QueueApi {
  return {
    page: (view, cursor) => readQueue(client, realm, { actingSubject, ...view, cursor }),
    // No author and no work: the name read does not call moderation context.
    names: (items, known) => readQueueNames(client, realm, items, { language: locale, actingSubject }, known ?? noNames),
    draft: () => Promise.reject(new Error('Unmatched recorded request: no submission draft on this case')),
    basis: item => readDecisionBasis(client, realm, item.id, actingSubject),
    people: iris => readAgents(client, iris, actingSubject),
    commit: () => Promise.reject(new Error('Unmatched recorded request: no recorded decision command')),
  };
}
