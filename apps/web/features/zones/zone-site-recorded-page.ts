import { documentText } from '@rezics/document';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { browserMainApi } from '../api/browser.ts';
import { failedRead, isOfflineError } from '../feed/types.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { failureOf, type Loaded, type ReadFailure, type ZonePresentationRead, type ZoneRouteRead } from '../realm/types.ts';

/**
 * The published Zone home, an empty publication, and a missing path, taken from
 * Main's presentation, route and content revision. The site route and the
 * recorded stories both call these functions, so the page cannot show a document
 * the answers did not carry.
 */

export type ZoneSiteClient = ReturnType<typeof browserMainApi>;
type RevisionCall = ReturnType<ReturnType<ZoneSiteClient['v1']['content-revisions']>['get']>;
export type ZoneSiteRevision = NonNullable<Awaited<RevisionCall>['data']>;
type AddressCall = ReturnType<ZoneSiteClient['v1']['addresses']['resolve']['get']>;
export type ZoneSiteAddress = NonNullable<Awaited<AddressCall>['data']>;

export interface ZoneSiteCredit {
  rightsBasis: string;
  author: string;
  revisionId: string;
}

export interface ZoneSiteProblem {
  status: number;
  title: string;
  code: string;
}

export type ZoneSiteRead<T> = { loaded: Loaded<T>; problem: ZoneSiteProblem | null };

export type ZoneSiteMapped =
  | {
      kind: 'published';
      page: NonNullable<ZonePresentationRead['home']>;
      text: string;
      credit: ZoneSiteCredit | null;
      name: string | null;
    }
  | { kind: 'empty'; name: string | null }
  | { kind: 'refusal'; problem: ZoneSiteProblem | null }
  | { kind: 'unavailable'; failure: ReadFailure }
  | { kind: 'discrepancy'; detail: string };

type TreatyAnswer<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  response?: unknown;
  headers?: unknown;
};

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

function problemOf(status: number, value: unknown): ZoneSiteProblem | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return null;
  if (typeof body.status === 'number' && body.status !== status) return null;
  return { status, title: body.title, code: body.code };
}

async function settle<T>(call: () => Promise<TreatyAnswer<T>>): Promise<ZoneSiteRead<T>> {
  try {
    let answer = await call();
    if (!answer.response && answer.error) {
      const value = answer.error.value;
      throw value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (answer.error?.status === 409) answer = await call();
    if (answer.error) {
      const failure = failureOf(answer.error.status, answer.error.value);
      const headers = answer.headers ?? (answer.response && typeof answer.response === 'object' && 'headers' in answer.response
        ? answer.response.headers : undefined);
      return {
        loaded: failedRead(failure, answer.error.value, headers),
        problem: failure === 'missing' ? problemOf(answer.error.status, answer.error.value) : null,
      };
    }
    return answer.data == null
      ? { loaded: { ok: false, failure: 'unavailable' }, problem: null }
      : { loaded: { ok: true, data: answer.data }, problem: null };
  } catch (error) {
    if (error instanceof Error && /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply/.test(error.message)) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { loaded: { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' }, problem: null };
  }
}

export function readZoneSitePresentation(main: ZoneSiteClient, zone: string) {
  return settle(() => main.v1.zones({ id: zone }).presentation.get());
}

export function readZoneSiteRouteAnswer(main: ZoneSiteClient, zone: string, path: string) {
  return settle(() => main.v1.zones({ id: zone }).routes.get({ query: { path } }));
}

export function readZoneSiteRevision(main: ZoneSiteClient, revision: string) {
  return settle(() => main.v1['content-revisions']({ revision }).get());
}

export function readZoneSiteAddress(main: ZoneSiteClient, scope: string, key: string) {
  return settle(() => main.v1.addresses.resolve.get({ query: { scope, key } }));
}

function creditOf(page: { reference?: { revisionId?: unknown; provenance?: unknown } | null } | null | undefined): ZoneSiteCredit | null {
  const reference = page?.reference;
  if (!reference) return null;
  const provenance = reference.provenance;
  if (!provenance || typeof provenance !== 'object') return null;
  const record = provenance as Record<string, unknown>;
  if (typeof record.rightsBasis !== 'string' || typeof record.author !== 'string' || typeof reference.revisionId !== 'string') return null;
  return { rightsBasis: record.rightsBasis, author: record.author, revisionId: reference.revisionId };
}

/** A presentation's published home, or the empty publication when it has no home document. */
export function mapZoneSiteHome(presentation: ZonePresentationRead): Extract<ZoneSiteMapped, { kind: 'published' | 'empty' }> {
  const page = presentation.home;
  const document = page ? zoneHomeDocument(page) : null;
  if (!page || !document) return { kind: 'empty', name: presentation.name };
  return { kind: 'published', page, text: documentText(document), credit: creditOf(page), name: presentation.name };
}

function revisionFacts(revision: ZoneSiteRevision): { text: string; document: unknown; credit: ZoneSiteCredit | null } | { detail: string } {
  const body = revision.body;
  if (!body || typeof body !== 'object') return { detail: 'content revision body is not a record' };
  const record = body as Record<string, unknown>;
  if (typeof record.body !== 'string') return { detail: 'content revision body.text is not a string' };
  if (!('document' in record)) return { detail: 'content revision body has no document' };
  return { text: record.body, document: record.document, credit: creditOf({ reference: revision.reference }) };
}

/** Combine the reads the page asked for. A missing route or revision stays a refusal. */
export function mapZoneSiteRecordedPage(input: {
  presentation?: ZoneSiteRead<ZonePresentationRead> | null;
  route?: ZoneSiteRead<ZoneRouteRead> | null;
  revision?: ZoneSiteRead<ZoneSiteRevision> | null;
}): ZoneSiteMapped {
  const route = input.route;
  if (route && !route.loaded.ok && route.loaded.failure === 'missing') return { kind: 'refusal', problem: route.problem };
  const revision = input.revision;
  if (revision && !revision.loaded.ok && revision.loaded.failure === 'missing') return { kind: 'refusal', problem: revision.problem };
  const presentation = input.presentation;
  if (!presentation) return { kind: 'discrepancy', detail: 'zone site page has no presentation answer' };
  if (!presentation.loaded.ok) return { kind: 'unavailable', failure: presentation.loaded.failure };
  const data = presentation.loaded.data;
  const home = mapZoneSiteHome(data);
  if (home.kind === 'empty' && data.home) {
    return { kind: 'discrepancy', detail: 'presentation home is present but not a document the page can show' };
  }
  if (home.kind !== 'published') return home;
  if (data.home && !home.credit && creditReferencePresent(data.home)) {
    return { kind: 'discrepancy', detail: 'published home reference has no readable rightsBasis, author and revisionId' };
  }
  if (route?.loaded.ok) {
    const read = route.loaded.data;
    if (read.kind !== 'home' || !read.page) return { kind: 'discrepancy', detail: `recorded route is ${read.kind}, not a home page` };
    if (read.name !== home.name) {
      return { kind: 'discrepancy', detail: `route name ${JSON.stringify(read.name)} is not presentation name ${JSON.stringify(home.name)}` };
    }
    const routeDocument = zoneHomeDocument(read.page);
    const homeDocument = zoneHomeDocument(home.page);
    if (!routeDocument || !homeDocument || !sameValue(routeDocument, homeDocument)) {
      return { kind: 'discrepancy', detail: 'route document does not equal the presentation home document' };
    }
    if (!sameValue(creditOf(read.page), home.credit)) {
      return { kind: 'discrepancy', detail: 'route credit does not equal the presentation home credit' };
    }
  }
  if (revision?.loaded.ok) {
    const facts = revisionFacts(revision.loaded.data);
    if ('detail' in facts) return { kind: 'discrepancy', detail: facts.detail };
    if (facts.text !== home.text) {
      return { kind: 'discrepancy', detail: `content revision text ${JSON.stringify(facts.text)} is not home text ${JSON.stringify(home.text)}` };
    }
    const homeDocument = zoneHomeDocument(home.page);
    if (!homeDocument || !sameValue(facts.document, homeDocument)) {
      return { kind: 'discrepancy', detail: 'content revision document does not equal the presentation home document' };
    }
    if (!sameValue(facts.credit, home.credit)) {
      return { kind: 'discrepancy', detail: 'content revision credit does not equal the presentation home credit' };
    }
  }
  return home;
}

function creditReferencePresent(page: object): boolean {
  return 'reference' in page && (page as { reference?: unknown }).reference != null;
}

/** A missing path is a refusal. Any other route result keeps the caller's own failure view. */
export function zoneSiteRouteMissing(route: Loaded<ZoneRouteRead>): boolean {
  return mapZoneSiteRecordedPage({ route: { loaded: route, problem: null } }).kind === 'refusal';
}

type PlannedRead =
  | { kind: 'address'; scope: string; key: string }
  | { kind: 'presentation'; zone: string }
  | { kind: 'route'; zone: string; path: string }
  | { kind: 'revision'; revision: string };

function planSample(sample: AnswerSample): PlannedRead {
  if (sample.method !== 'GET' || sample.body !== undefined) {
    throw new Error(`No zone site reader for ${sample.method} ${sample.path}`);
  }
  const url = new URL(sample.path, 'https://recorded.invalid');
  const parts = url.pathname.split('/');
  if (parts[1] === 'v1' && parts[2] === 'addresses' && parts[3] === 'resolve' && !parts[4]) {
    const scope = url.searchParams.get('scope');
    const key = url.searchParams.get('key');
    if (!scope || !key || url.searchParams.size !== 2) throw new Error(`No zone site reader for GET ${sample.path}`);
    return { kind: 'address', scope, key };
  }
  if (parts[1] === 'v1' && parts[2] === 'zones' && parts[4] === 'presentation' && parts[3] && !parts[5]) {
    if (url.search) throw new Error(`No zone site reader for GET ${sample.path}`);
    return { kind: 'presentation', zone: decodeURIComponent(parts[3]) };
  }
  if (parts[1] === 'v1' && parts[2] === 'zones' && parts[4] === 'routes' && parts[3] && !parts[5]) {
    const path = url.searchParams.get('path');
    if (path === null || url.searchParams.size !== 1) throw new Error(`No zone site reader for GET ${sample.path}`);
    return { kind: 'route', zone: decodeURIComponent(parts[3]), path };
  }
  if (parts[1] === 'v1' && parts[2] === 'content-revisions' && parts[3] && !parts[4]) {
    if (url.search) throw new Error(`No zone site reader for GET ${sample.path}`);
    return { kind: 'revision', revision: decodeURIComponent(parts[3]) };
  }
  throw new Error(`No zone site reader for GET ${sample.path}`);
}

export interface ZoneSiteRecordedLoad {
  mapped: ZoneSiteMapped;
  presentation: ZonePresentationRead | null;
  address: Extract<ZoneSiteAddress, { status: 'resolved' | 'retired' }> | null;
}

/** Replay the selected samples through the typed client and the shared mapping. */
export async function readZoneSiteRecorded(
  main: ZoneSiteClient,
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): Promise<ZoneSiteRecordedLoad> {
  const plans = selections.map(selection => {
    const found = record.personas[persona].filter(sample => sample.label === selection.label);
    const sample = found.length === 1 ? found[0] : undefined;
    if (!sample) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${selection.label}`);
    return planSample(sample);
  });
  const reads: {
    presentation: ZoneSiteRead<ZonePresentationRead> | null;
    route: ZoneSiteRead<ZoneRouteRead> | null;
    revision: ZoneSiteRead<ZoneSiteRevision> | null;
    address: ZoneSiteRead<ZoneSiteAddress> | null;
  } = { presentation: null, route: null, revision: null, address: null };
  await Promise.all(plans.map(async plan => {
    if (plan.kind === 'presentation') reads.presentation = await readZoneSitePresentation(main, plan.zone);
    else if (plan.kind === 'route') reads.route = await readZoneSiteRouteAnswer(main, plan.zone, plan.path);
    else if (plan.kind === 'revision') reads.revision = await readZoneSiteRevision(main, plan.revision);
    else reads.address = await readZoneSiteAddress(main, plan.scope, plan.key);
  }));
  const mapped = mapZoneSiteRecordedPage(reads);
  const address = reads.address;
  if (address && !address.loaded.ok) {
    return { mapped: { kind: 'discrepancy', detail: `address read failed: ${address.loaded.failure}` }, presentation: null, address: null };
  }
  const resolved = address?.loaded.ok && 'canonical' in address.loaded.data ? address.loaded.data : null;
  if (address?.loaded.ok && !resolved) {
    return { mapped: { kind: 'discrepancy', detail: 'address answer has no canonical address' }, presentation: null, address: null };
  }
  return { mapped, presentation: reads.presentation?.loaded.ok ? reads.presentation.loaded.data : null, address: resolved };
}
