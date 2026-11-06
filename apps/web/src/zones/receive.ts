import type { CompositionDocument, View } from '@rezics/composition';
import { APPEARANCE, UI_LOCALES, VIEWS } from '@rezics/composition';
import type { ZonePageResponse, ZonePublic } from '../../../../services/kernel/src/zones/contract.ts';
import { validZoneCursor } from './visit.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revisionPattern = /^[1-9][0-9]*$/;
const visibility = new Set(['private', 'unlisted', 'public']);
const privateKeys = new Set([
  'ownerId',
  'deletedAt',
  'restoreUntil',
  'configuration',
  'mounts',
  'scope',
  'scopes',
  'sources',
  'collections',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function appearanceTokens(value: unknown): ZonePublic['appearance'] | undefined {
  if (!isRecord(value)) return;
  const appearance: ZonePublic['appearance'] = {};
  for (const name of Object.keys(APPEARANCE) as (keyof typeof APPEARANCE)[]) {
    const token = value[name];
    if (token === undefined) continue;
    if (typeof token !== 'string' || !(APPEARANCE[name] as readonly string[]).includes(token)) return;
    Object.assign(appearance, { [name]: token });
  }
  if (Object.keys(value).some((key) => !(key in APPEARANCE))) return;
  return appearance;
}

function publicLabels(value: unknown): ZonePublic['labels'] | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !(UI_LOCALES as readonly string[]).includes(key))) return;
  const labels: Record<string, string> = {};
  for (const [locale, text] of Object.entries(value)) {
    if (typeof text !== 'string' || text.length === 0 || text.length > 80) return;
    labels[locale] = text;
  }
  return labels as ZonePublic['labels'];
}

function navigation(value: unknown): ZonePublic['navigation'] | undefined {
  if (!Array.isArray(value) || value.length > 16) return;
  const routes: ZonePublic['navigation'] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).join() !== 'route' || typeof item.route !== 'string') return;
    if (item.route !== '' && !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(item.route)) return;
    if (item.route.split('/')[0] === 'subjects' || seen.has(item.route)) return;
    seen.add(item.route);
    routes.push({ route: item.route });
  }
  return routes;
}

/** Public shell only: no owner, mounts, scopes, or source names. */
export function receiveZonePublic(value: unknown): ZonePublic | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => privateKeys.has(key))) return;
  const labels = publicLabels(value.labels);
  const appearance = appearanceTokens(value.appearance);
  const items = navigation(value.navigation);
  if (
    !nativeId(value.id) ||
    typeof value.revision !== 'string' ||
    !revisionPattern.test(value.revision) ||
    !labels ||
    typeof value.visibility !== 'string' ||
    !visibility.has(value.visibility) ||
    !appearance ||
    !items ||
    (value.primaryLanguage !== undefined &&
      (typeof value.primaryLanguage !== 'string' || !(UI_LOCALES as readonly string[]).includes(value.primaryLanguage)))
  )
    return;
  return {
    id: value.id,
    revision: value.revision,
    labels,
    ...(typeof value.primaryLanguage === 'string'
      ? { primaryLanguage: value.primaryLanguage as ZonePublic['primaryLanguage'] }
      : {}),
    visibility: value.visibility as ZonePublic['visibility'],
    appearance,
    navigation: items,
  };
}

function template(value: unknown): ZonePageResponse['template'] | undefined {
  if (
    !isRecord(value) ||
    (value.scope !== 'route' && value.scope !== 'type' && value.scope !== 'base' && value.scope !== 'generic')
  )
    return;
  if (value.key !== null && typeof value.key !== 'string') return;
  return { scope: value.scope, key: value.key };
}

function documentOf(value: unknown): CompositionDocument | undefined {
  if (!isRecord(value) || !isRecord(value.root) || !isRecord(value.root.props) || !Array.isArray(value.content)) return;
  return value as CompositionDocument;
}

export type ReceivedRead = { status: number; body: unknown; retryAt?: number };

function receiveRead(value: unknown): ReceivedRead | undefined {
  if (!isRecord(value) || typeof value.status !== 'number' || !Number.isInteger(value.status)) return;
  if (value.status < 100 || value.status > 599) return;
  const body = Object.hasOwn(value, 'body') ? value.body : undefined;
  if (isRecord(body) && Object.keys(body).some((key) => privateKeys.has(key))) return;
  return {
    status: value.status,
    body,
    ...(typeof value.retryAt === 'number' ? { retryAt: value.retryAt } : {}),
  };
}

export type ReceivedZonePage = {
  profile: string;
  template: ZonePageResponse['template'];
  document: CompositionDocument;
  reads: Record<string, ReceivedRead>;
  zone: ZonePublic;
  subject?: string;
  views?: View[];
};

const views = new Set<View>(VIEWS);

/** Typed receiving of a native Zone page: public shell, admitted reads, no private mount metadata. */
export function receiveZonePage(value: unknown): ReceivedZonePage | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => privateKeys.has(key))) return;
  const zone = receiveZonePublic(value.zone);
  const pageTemplate = template(value.template);
  const document = documentOf(value.document);
  if (
    !zone ||
    !pageTemplate ||
    !document ||
    typeof value.profile !== 'string' ||
    value.profile.length === 0 ||
    !isRecord(value.reads)
  )
    return;
  const reads: Record<string, ReceivedRead> = {};
  for (const [key, result] of Object.entries(value.reads)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return;
    const read = receiveRead(result);
    if (!read) return;
    reads[key] = read;
  }
  if (value.subject !== undefined && !nativeId(value.subject)) return;
  let pageViews: View[] | undefined;
  if (value.views !== undefined) {
    if (!Array.isArray(value.views) || value.views.some((view) => typeof view !== 'string' || !views.has(view as View)))
      return;
    pageViews = [...new Set(value.views as View[])];
  }
  return {
    profile: value.profile,
    template: pageTemplate,
    document,
    reads,
    zone,
    ...(typeof value.subject === 'string' ? { subject: value.subject } : {}),
    ...(pageViews ? { views: pageViews } : {}),
  };
}

export type SlotContinuation = { next: string | null };

/** Overlapping/alias members keep the first native occurrence; continuation stays opaque, including empty windows. */
export function receiveSlotContinuation(body: unknown): SlotContinuation | undefined {
  if (!isRecord(body) || (body.next !== null && !validZoneCursor(body.next))) return;
  const rows = Array.isArray(body.subjects) ? body.subjects : Array.isArray(body.members) ? body.members : undefined;
  if (!rows) return { next: body.next };
  for (const row of rows) {
    if (!isRecord(row)) return;
    const id = typeof row.id === 'string' ? row.id : typeof row.subjectId === 'string' ? row.subjectId : undefined;
    if (!id || !uuid.test(id)) return;
  }
  return { next: body.next };
}

function leaksPrivateFacts(body: unknown): boolean {
  return isRecord(body) && Object.keys(body).some((name) => privateKeys.has(name));
}

/**
 * Anonymous and revoked SSR keep the public shell. A live session may keep admitted private-mount
 * rows. Owner, mount and source names never ship in the public body.
 *
 * Guard: a session-mode reread without a current credential (revoked/suspended) used to keep leaked
 * `ownerId`/`mounts` because isolation keyed off credential mode rather than an actual bearer.
 * Input: `{ credentialMode: 'session' }` with no Authorization and a 200 body `{ ownerId, mounts }`.
 */
export function isolatePublicZonePage(page: ReceivedZonePage, session: boolean): ReceivedZonePage {
  if (session) {
    const reads: Record<string, ReceivedRead> = {};
    for (const [key, read] of Object.entries(page.reads)) {
      if (read.status === 200 && leaksPrivateFacts(read.body)) return isolatePublicZonePage(page, false);
      reads[key] = read;
    }
    return { ...page, reads };
  }
  const reads: Record<string, ReceivedRead> = {};
  for (const [key, read] of Object.entries(page.reads)) {
    if (read.status === 200 && leaksPrivateFacts(read.body)) continue;
    if (read.status === 401 || read.status === 403) continue;
    reads[key] = read;
  }
  return { ...page, reads };
}

/** Withheld native summaries stay null; the row is not filled from another source. */
export function withheldSlotRow(row: unknown): boolean {
  if (!isRecord(row)) return true;
  return Object.hasOwn(row, 'summary') && row.summary === null;
}
