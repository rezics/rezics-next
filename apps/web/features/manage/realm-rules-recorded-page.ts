import type { AgentOption } from '../auth/acting-identity.ts';
import { browserMainApi } from '../api/browser.ts';
import { zoneText, type ZoneText } from '../realm/adapt.ts';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { saveSettings } from './commands.ts';
import type { RealmHeader, SettingsView } from './types.ts';
import type { JoinPage } from './settings-api.ts';

/**
 * Published Realm rules, the bounded join-page landing, and the settings
 * revision a manager may replace. The public rules route and the recorded
 * page call the same mapping, so a refusal cannot paint the command that
 * Main did not accept.
 */

const recordedOrigin = 'https://recorded.invalid';
/** Answer records redact Idempotency-Key. Replay matches the recorded body; the header only keeps the call stable. */
const recordedCommandKey = '00000000-0000-4000-8000-000000000234';

type SettingsCommand = Parameters<typeof saveSettings>[2];
type RealmRulesClient = ReturnType<typeof browserMainApi>;

export interface PublishedRealmRule {
  id: string;
  title: string;
  body: string;
  governed: boolean;
  lang: string;
}

export interface RealmRulesProblem {
  status: number;
  title: string;
  code: string;
}

export type RealmRulesMapped =
  | { kind: 'published'; name: ZoneText; rules: PublishedRealmRule[] }
  | { kind: 'empty'; name: ZoneText }
  | { kind: 'landing'; page: JoinPage; realm: string }
  | {
      kind: 'settings';
      realm: string;
      settings: SettingsView;
      header: RealmHeader | null;
      agent: AgentOption | null;
    }
  | {
      kind: 'refused';
      problem: RealmRulesProblem;
      /** The last settings Main accepted. A denied read has none, and a refused command does not count. */
      accepted: SettingsView | null;
      realm: string | null;
      header: RealmHeader | null;
      agent: AgentOption | null;
    }
  | { kind: 'discrepancy'; detail: string };

interface RealmRulesRead<T> {
  loaded: { ok: true; data: T } | { ok: false };
  problem: RealmRulesProblem | null;
}

type TreatyAnswer<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  response?: unknown;
};

/** Rules as the public rules page lists them. Null when the header has not published any. */
export function publishedRealmRules(rules: RealmHeader['rules']): PublishedRealmRule[] | null {
  if (!rules) return null;
  return rules.map(rule => ({
    id: rule.id,
    title: rule.title.value,
    body: rule.body.value,
    governed: rule.governanceRule !== null,
    lang: rule.title.language,
  }));
}

function problemOf(status: number, value: unknown): RealmRulesProblem | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return null;
  if (typeof body.status === 'number' && body.status !== status) return null;
  return { status, title: body.title, code: body.code };
}

async function settle<T>(call: () => Promise<TreatyAnswer<T>>, method: 'GET' | 'PUT'): Promise<RealmRulesRead<T>> {
  try {
    let answer = await call();
    if (!answer.response && answer.error) {
      const value = answer.error.value;
      throw value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (method === 'GET' && answer.error?.status === 409) answer = await call();
    if (answer.error) {
      return { loaded: { ok: false }, problem: problemOf(answer.error.status, answer.error.value) };
    }
    return answer.data == null
      ? { loaded: { ok: false }, problem: null }
      : { loaded: { ok: true, data: answer.data }, problem: null };
  } catch (error) {
    if (error instanceof Error && /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply|No realm rules reader/.test(error.message)) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw error;
  }
}

function client(fetcher: typeof fetch): RealmRulesClient {
  return browserMainApi(recordedOrigin, { anonymous: true, fetcher });
}

export function readRecordedRealmHeader(fetcher: typeof fetch, realm: string, query: { language?: string; actingSubject?: string }) {
  const main = client(fetcher);
  return settle(() => main.v1.realms({ realm }).get({ query }), 'GET');
}

export function readRecordedRealmSettings(fetcher: typeof fetch, realm: string, actingSubject: string) {
  const main = client(fetcher);
  return settle(() => main.v1.realms({ realm }).settings.get({ query: { actingSubject } }), 'GET');
}

export function readRecordedJoinPage(fetcher: typeof fetch, realm: string, query: { language?: string; actingSubject?: string }) {
  const main = client(fetcher);
  return settle(() => main.v1.realms({ realm })['join-page'].get({ query }), 'GET');
}

export function readRecordedAgent(fetcher: typeof fetch, id: string, actingSubject: string) {
  const main = client(fetcher);
  return settle(() => main.v1.agents({ id }).get({ query: { actingSubject } }), 'GET');
}

export function amendRecordedRealmSettings(fetcher: typeof fetch, realm: string, command: SettingsCommand) {
  const main = client(fetcher);
  return settle(() => main.v1.realms({ realm }).settings.put(command, { headers: { 'idempotency-key': recordedCommandKey } }), 'PUT');
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nameOf(value: unknown, label: string): ZoneText | { detail: string } {
  const name = record(value);
  if (!name || typeof name.value !== 'string' || !name.value) return { detail: `${label} name is not text` };
  if (typeof name.language !== 'string' || !name.language) return { detail: `${label} name has no language` };
  if (name.direction !== 'ltr' && name.direction !== 'rtl') return { detail: `${label} name direction is not ltr or rtl` };
  const text = zoneText({ value: name.value, language: name.language, direction: name.direction });
  return text ?? { detail: `${label} name is empty` };
}

function publishedRule(value: unknown, index: number): string | null {
  const rule = record(value);
  if (!rule || typeof rule.id !== 'string') return `published rule ${index} has no id`;
  const title = record(rule.title);
  const body = record(rule.body);
  if (!title || typeof title.value !== 'string' || typeof title.language !== 'string') {
    return `published rule ${index} title is not a localized string`;
  }
  if (!body || typeof body.value !== 'string') return `published rule ${index} body is not text`;
  if (!('governanceRule' in rule)) return `published rule ${index} has no governanceRule`;
  return null;
}

function settingsRule(value: unknown, index: number): string | null {
  const rule = record(value);
  if (!rule || typeof rule.id !== 'string') return `settings rule ${index} has no id`;
  for (const field of ['title', 'body'] as const) {
    const text = record(rule[field]);
    if (!text || typeof text.original !== 'string') return `settings rule ${index} ${field}.original is not a string`;
    if (!record(text.labels)) return `settings rule ${index} ${field}.labels is not a record`;
  }
  return null;
}

function asHeader(value: unknown): { header: RealmHeader } | { detail: string } {
  const header = record(value);
  if (!header) return { detail: 'realm header is not a record' };
  if (header.profile !== 'realm-read-v1') return { detail: `realm header profile ${JSON.stringify(header.profile)} is not realm-read-v1` };
  const name = nameOf(header.name, 'realm header');
  if ('detail' in name) return name;
  if (header.rules !== null && !Array.isArray(header.rules)) return { detail: 'realm header rules is not a list' };
  if (Array.isArray(header.rules)) {
    for (const [index, rule] of header.rules.entries()) {
      const problem = publishedRule(rule, index);
      if (problem) return { detail: problem };
    }
  }
  return { header: header as unknown as RealmHeader };
}

function asSettings(value: unknown): { settings: SettingsView } | { detail: string } {
  const answer = record(value);
  if (!answer) return { detail: 'settings answer is not a record' };
  if (typeof answer.generation !== 'string') return { detail: 'settings generation is not a string' };
  const settings = record(answer.settings);
  if (!settings) return { detail: 'settings.settings is not a record' };
  if (!Array.isArray(settings.rules)) return { detail: 'settings.rules is not an array' };
  for (const [index, rule] of settings.rules.entries()) {
    const problem = settingsRule(rule, index);
    if (problem) return { detail: problem };
  }
  const basis = record(answer.ruleBasis);
  if (!basis) return { detail: 'settings ruleBasis is not a record' };
  if (typeof basis.ref !== 'string') return { detail: 'settings ruleBasis.ref is not a string' };
  if (basis.revision !== null && typeof basis.revision !== 'string') return { detail: 'settings ruleBasis.revision is not a string' };
  if (basis.digest !== null && typeof basis.digest !== 'string') return { detail: 'settings ruleBasis.digest is not a string' };
  return { settings: { generation: answer.generation, settings: answer.settings, ruleBasis: answer.ruleBasis } as SettingsView };
}

function asJoin(value: unknown): { page: JoinPage } | { detail: string } {
  const page = record(value);
  if (!page) return { detail: 'join page is not a record' };
  if (page.profile !== 'realm-join-page-v1') return { detail: `join page profile ${JSON.stringify(page.profile)} is not realm-join-page-v1` };
  const name = nameOf(page.name, 'join page');
  if ('detail' in name) return name;
  if (!Array.isArray(page.rules)) return { detail: 'join page rules is not a list' };
  for (const [index, rule] of page.rules.entries()) {
    const item = record(rule);
    const title = item ? record(item.title) : null;
    const body = item ? record(item.body) : null;
    if (!item || typeof item.id !== 'string' || !title || typeof title.value !== 'string' || typeof title.language !== 'string'
      || !body || typeof body.value !== 'string') {
      return { detail: `join page rule ${index} is not a localized rule` };
    }
  }
  return { page: page as unknown as JoinPage };
}

const agentKinds = ['person', 'pen-name', 'organization', 'service'] as const;

function asAgent(value: unknown): { agent: AgentOption } | { detail: string } {
  const profile = record(value);
  if (!profile) return { detail: 'agent profile is not a record' };
  if (typeof profile.id !== 'string' || typeof profile.displayName !== 'string') {
    return { detail: 'agent profile has no id and display name' };
  }
  if (profile.handle !== null && typeof profile.handle !== 'string') return { detail: 'agent profile handle is not text' };
  if (!(agentKinds as readonly string[]).includes(String(profile.kind)) && profile.kind !== null) {
    return { detail: `agent kind ${JSON.stringify(profile.kind)} is not a person, pen name, organization or service` };
  }
  const publication = profile.path === 'represented-agent' || profile.path === 'direct-principal' ? profile.path : null;
  return { agent: {
    iri: profile.id,
    label: profile.displayName,
    handle: profile.handle,
    kind: profile.kind as AgentOption['kind'],
    path: publication,
  } };
}

function isSettingsCommand(body: unknown): body is SettingsCommand {
  const command = record(body);
  const settings = command ? record(command.settings) : null;
  return !!command && typeof command.actingSubject === 'string' && typeof command.expectedGeneration === 'string'
    && (command.expectedRulesRevision === null || typeof command.expectedRulesRevision === 'string')
    && typeof command.reason === 'string' && !!settings && Array.isArray(settings.rules);
}

function refused(read: RealmRulesRead<unknown>, label: string): RealmRulesProblem | { detail: string } {
  if (read.loaded.ok) return { detail: `${label} succeeded and is not a refusal` };
  if (!read.problem) return { detail: `${label} refusal has no title and code` };
  return read.problem;
}

type Planned =
  | { kind: 'header'; realm: string; query: { language?: string; actingSubject?: string } }
  | { kind: 'settings'; realm: string; actingSubject: string }
  | { kind: 'join'; realm: string; query: { language?: string; actingSubject?: string } }
  | { kind: 'amend'; realm: string; command: SettingsCommand }
  | { kind: 'profile'; id: string; actingSubject: string };

function allowedQuery(url: URL, allowed: readonly string[]): { query: Record<string, string> } | { detail: string } {
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) return { detail: `No realm rules reader for ${key} on ${url.pathname}` };
    if (key in query) return { detail: `No realm rules reader for repeated ${key}` };
    query[key] = value;
  }
  return { query };
}

function planSample(sample: AnswerSample): Planned {
  const url = new URL(sample.path, recordedOrigin);
  const parts = url.pathname.split('/');
  if (sample.method === 'GET' && parts[1] === 'v1' && parts[2] === 'realms' && parts[3] && !parts[4]) {
    const query = allowedQuery(url, ['language', 'actingSubject', 'languages']);
    if ('detail' in query) throw new Error(query.detail);
    return { kind: 'header', realm: decodeURIComponent(parts[3]), query: query.query };
  }
  if (sample.method === 'GET' && parts[1] === 'v1' && parts[2] === 'realms' && parts[4] === 'settings' && parts[3] && !parts[5]) {
    const query = allowedQuery(url, ['actingSubject']);
    if ('detail' in query) throw new Error(query.detail);
    if (!query.query.actingSubject) throw new Error(`No realm rules reader for GET ${sample.path}`);
    return { kind: 'settings', realm: decodeURIComponent(parts[3]), actingSubject: query.query.actingSubject };
  }
  if (sample.method === 'GET' && parts[1] === 'v1' && parts[2] === 'realms' && parts[4] === 'join-page' && parts[3] && !parts[5]) {
    const query = allowedQuery(url, ['language', 'actingSubject', 'languages']);
    if ('detail' in query) throw new Error(query.detail);
    return { kind: 'join', realm: decodeURIComponent(parts[3]), query: query.query };
  }
  if (sample.method === 'PUT' && parts[1] === 'v1' && parts[2] === 'realms' && parts[4] === 'settings' && parts[3] && !parts[5]) {
    if (url.search) throw new Error(`No realm rules reader for PUT ${sample.path}`);
    if (!isSettingsCommand(sample.body)) throw new Error(`No realm rules reader for PUT ${sample.path}`);
    return { kind: 'amend', realm: decodeURIComponent(parts[3]), command: sample.body };
  }
  if (sample.method === 'GET' && parts[1] === 'v1' && parts[2] === 'agents' && parts[3] && !parts[4]) {
    const query = allowedQuery(url, ['actingSubject']);
    if ('detail' in query) throw new Error(query.detail);
    if (!query.query.actingSubject) throw new Error(`No realm rules reader for GET ${sample.path}`);
    return { kind: 'profile', id: decodeURIComponent(parts[3]), actingSubject: query.query.actingSubject };
  }
  throw new Error(`No realm rules reader for ${sample.method} ${sample.path}`);
}

interface Collected {
  header: { realm: string; read: RealmRulesRead<unknown> } | null;
  settings: { realm: string; read: RealmRulesRead<unknown> } | null;
  join: { realm: string; read: RealmRulesRead<unknown> } | null;
  amend: { realm: string; read: RealmRulesRead<unknown> } | null;
  profile: RealmRulesRead<unknown> | null;
}

function sameRealm(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

/** One recorded rules page. A refused command keeps the settings read; it does not show its own rules. */
export function mapRealmRulesRecorded(reads: Collected): RealmRulesMapped {
  const realms = [reads.header?.realm ?? null, reads.settings?.realm ?? null, reads.join?.realm ?? null, reads.amend?.realm ?? null];
  const realm = realms.find((item): item is string => item !== null) ?? null;
  if (!realms.every(item => sameRealm(item, realm))) return { kind: 'discrepancy', detail: 'recorded rules reads name more than one Realm' };
  const header = reads.header ? asHeaderRead(reads.header.read) : null;
  if (header && 'detail' in header) return { kind: 'discrepancy', detail: header.detail };
  const settings = reads.settings ? asSettingsRead(reads.settings.read) : null;
  if (settings && 'detail' in settings) return { kind: 'discrepancy', detail: settings.detail };
  const join = reads.join ? asJoinRead(reads.join.read) : null;
  if (join && 'detail' in join) return { kind: 'discrepancy', detail: join.detail };
  const agent = reads.profile ? asAgentRead(reads.profile) : null;
  if (agent && 'detail' in agent) return { kind: 'discrepancy', detail: agent.detail };
  const amend = reads.amend;
  if (amend) {
    if (amend.read.loaded.ok) {
      const accepted = asSettings(amend.read.loaded.data);
      if ('detail' in accepted) return { kind: 'discrepancy', detail: accepted.detail };
      return { kind: 'settings', realm: amend.realm, settings: accepted.settings, header: header?.header ?? null, agent: agent?.agent ?? null };
    }
    const problem = refused(amend.read, 'settings command');
    if ('detail' in problem) return { kind: 'discrepancy', detail: problem.detail };
    return {
      kind: 'refused', problem, accepted: settings?.settings ?? null, realm: amend.realm,
      header: header?.header ?? null, agent: agent?.agent ?? null,
    };
  }
  if (settings?.problem) {
    return {
      kind: 'refused', problem: settings.problem, accepted: null, realm: reads.settings?.realm ?? null,
      header: header?.header ?? null, agent: agent?.agent ?? null,
    };
  }
  if (settings?.settings) {
    return {
      kind: 'settings', realm: reads.settings!.realm, settings: settings.settings,
      header: header?.header ?? null, agent: agent?.agent ?? null,
    };
  }
  if (join?.problem && !join.page) {
    if (header?.header) return pageOf(header.header);
    return { kind: 'refused', problem: join.problem, accepted: null, realm, header: null, agent: agent?.agent ?? null };
  }
  if (header?.problem && join?.page) return { kind: 'landing', page: join.page, realm: reads.join!.realm };
  if (header?.problem) return { kind: 'refused', problem: header.problem, accepted: null, realm, header: null, agent: agent?.agent ?? null };
  if (join?.page && !header) return { kind: 'landing', page: join.page, realm: reads.join!.realm };
  if (header?.header) return pageOf(header.header);
  if (agent?.agent) return { kind: 'discrepancy', detail: 'agent profile has no rules read' };
  return { kind: 'discrepancy', detail: 'realm rules page has no header, landing or settings answer' };
}

function pageOf(header: RealmHeader): RealmRulesMapped {
  const name = zoneText(header.name);
  if (!name) return { kind: 'discrepancy', detail: 'realm header name is empty' };
  const rules = publishedRealmRules(header.rules);
  if (!rules?.length) return { kind: 'empty', name };
  return { kind: 'published', name, rules };
}

function asHeaderRead(read: RealmRulesRead<unknown>): { header: RealmHeader | null; problem: RealmRulesProblem | null } | { detail: string } {
  if (!read.loaded.ok) {
    const problem = refused(read, 'realm header');
    return 'detail' in problem ? problem : { header: null, problem };
  }
  const header = asHeader(read.loaded.data);
  return 'detail' in header ? header : { header: header.header, problem: null };
}

function asSettingsRead(read: RealmRulesRead<unknown>): { settings: SettingsView | null; problem: RealmRulesProblem | null } | { detail: string } {
  if (!read.loaded.ok) {
    const problem = refused(read, 'settings');
    return 'detail' in problem ? problem : { settings: null, problem };
  }
  const settings = asSettings(read.loaded.data);
  return 'detail' in settings ? settings : { settings: settings.settings, problem: null };
}

function asJoinRead(read: RealmRulesRead<unknown>): { page: JoinPage | null; problem: RealmRulesProblem | null } | { detail: string } {
  if (!read.loaded.ok) {
    const problem = refused(read, 'join page');
    return 'detail' in problem ? problem : { page: null, problem };
  }
  const page = asJoin(read.loaded.data);
  return 'detail' in page ? page : { page: page.page, problem: null };
}

function asAgentRead(read: RealmRulesRead<unknown>): { agent: AgentOption } | { detail: string } {
  if (!read.loaded.ok) {
    if (!read.problem) return { detail: 'agent profile refusal has no title and code' };
    return { detail: `agent profile was refused: ${read.problem.title}` };
  }
  return asAgent(read.loaded.data);
}

export interface RealmRulesRecordedLoad {
  mapped: RealmRulesMapped;
}

/** Replay the selected samples through the typed client and the shared mapping. */
export async function readRealmRulesRecorded(
  fetcher: typeof fetch,
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): Promise<RealmRulesRecordedLoad> {
  const plans = selections.map(selection => {
    const found = record.personas[persona].filter(sample => sample.label === selection.label);
    const sample = found.length === 1 ? found[0] : undefined;
    if (!sample) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${selection.label}`);
    return planSample(sample);
  });
  const reads: Collected = { header: null, settings: null, join: null, amend: null, profile: null };
  const taken = new Set<string>();
  await Promise.all(plans.map(async plan => {
    if (taken.has(plan.kind)) throw new Error(`Ambiguous realm rules read: two ${plan.kind} samples`);
    taken.add(plan.kind);
    if (plan.kind === 'header') reads.header = { realm: plan.realm, read: await readRecordedRealmHeader(fetcher, plan.realm, plan.query) };
    else if (plan.kind === 'settings') reads.settings = { realm: plan.realm, read: await readRecordedRealmSettings(fetcher, plan.realm, plan.actingSubject) };
    else if (plan.kind === 'join') reads.join = { realm: plan.realm, read: await readRecordedJoinPage(fetcher, plan.realm, plan.query) };
    else if (plan.kind === 'amend') reads.amend = { realm: plan.realm, read: await amendRecordedRealmSettings(fetcher, plan.realm, plan.command) };
    else reads.profile = await readRecordedAgent(fetcher, plan.id, plan.actingSubject);
  }));
  return { mapped: mapRealmRulesRecorded(reads) };
}
