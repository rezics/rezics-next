import { pickText } from '@rezics/composition';
import { checkSubjectStructure } from '@rezics/definitions/validate';

export const SETTINGS_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const SETTINGS_CAP = 256;
export const DEFAULTS_CAP = 64;
export const SETTINGS_PAGE = 16;
export type DefaultMode = 'inherit' | 'suppress';
export type SettingsChoice = {
  id: string;
  labels: Readonly<Record<string, string>>;
  defaults: Readonly<Record<string, DefaultMode>>;
};
export type SettingsSnapshot = {
  digest: string;
  ids: readonly string[];
  contexts: Readonly<Record<string, SettingsChoice>>;
  properties: Readonly<Record<string, Readonly<Record<string, string>>>>;
};
export type SettingsRead =
  | { kind: 'loading' }
  | { kind: 'denied'; session?: string }
  | { kind: 'unavailable'; session?: string }
  | { kind: 'ready'; snapshot: SettingsSnapshot; session?: string };
export type LabelRow = { id: string; language: string; text: string };
export type SettingsPreview = {
  settings: string | null;
  release: string;
  defaults: Readonly<Record<string, DefaultMode>>;
};
export type CapturedPolicy = {
  settings: { id: string; release: string } | null;
  defaults: Readonly<Record<string, DefaultMode>>;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function textMap(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((text) => typeof text === 'string');
}
function defaultsMap(value: unknown): value is Record<string, DefaultMode> {
  return (
    record(value) &&
    Object.keys(value).length <= DEFAULTS_CAP &&
    Object.values(value).every((mode) => mode === 'inherit' || mode === 'suppress')
  );
}

export function settingsId(value: unknown): value is string {
  return typeof value === 'string' && SETTINGS_ID.test(value);
}

/** One owned snapshot of the exact release. Setting rows look up this copy; they never carry a second release. */
export function parseSettingsSnapshot(digest: string, release: unknown): SettingsSnapshot | null {
  if (typeof digest !== 'string' || !digest || digest.length > 256 || !record(release)) return null;
  const source = record(release.contexts) ? release.contexts : {};
  const ids = Object.keys(source).filter(settingsId).sort().slice(0, SETTINGS_CAP);
  const contexts: Record<string, SettingsChoice> = {};
  const needed = new Set<string>();
  for (const id of ids) {
    const entry = source[id];
    if (!record(entry) || !textMap(entry.labels) || !defaultsMap(entry.defaults)) continue;
    const defaults = Object.fromEntries(Object.entries(entry.defaults).slice(0, DEFAULTS_CAP)) as Record<
      string,
      DefaultMode
    >;
    contexts[id] = {
      id,
      labels: Object.freeze({ ...entry.labels }),
      defaults: Object.freeze(defaults),
    };
    for (const property of Object.keys(defaults)) needed.add(property);
  }
  const properties: Record<string, Record<string, string>> = {};
  const released = record(release.properties) ? release.properties : {};
  for (const property of needed) {
    const definition = released[property];
    properties[property] = record(definition) && textMap(definition.labels) ? { ...definition.labels } : {};
  }
  return {
    digest,
    ids: Object.freeze(Object.keys(contexts)),
    contexts: Object.freeze(contexts),
    properties: Object.freeze(properties),
  };
}

export function settingsChoice(snapshot: SettingsSnapshot, id: string): SettingsChoice | undefined {
  return Object.hasOwn(snapshot.contexts, id) ? snapshot.contexts[id] : undefined;
}

export function filterSettings(snapshot: SettingsSnapshot, query: string, locale: string): SettingsChoice[] {
  const needle = query.trim().toLocaleLowerCase(locale);
  return snapshot.ids.flatMap((id) => {
    const choice = snapshot.contexts[id];
    if (!choice) return [];
    if (!needle) return [choice];
    const label = pickText(choice.labels, locale).text.toLocaleLowerCase(locale);
    return choice.id.includes(needle) || label.includes(needle) ? [choice] : [];
  });
}

export function pageSettings(
  items: readonly SettingsChoice[],
  offset: number,
  limit = SETTINGS_PAGE,
): { items: SettingsChoice[]; offset: number; next: number | null; previous: number | null } {
  const start = Number.isFinite(offset) ? Math.max(0, Math.min(items.length, Math.trunc(offset))) : 0;
  const size = Math.min(SETTINGS_PAGE, Math.max(1, Math.trunc(limit)));
  const sliced = items.slice(start, start + size);
  return {
    items: sliced,
    offset: start,
    next: start + size < items.length ? start + size : null,
    previous: start > 0 ? Math.max(0, start - size) : null,
  };
}

export function propertyCaption(
  snapshot: SettingsSnapshot | null,
  property: string,
  locale: string,
): { text: string; missing: boolean } {
  const labels = snapshot?.properties[property];
  const text = labels ? pickText(labels, locale).text : '';
  return text ? { text, missing: false } : { text: property, missing: true };
}

export function policyPreview(snapshot: SettingsSnapshot, id: string | null): SettingsPreview {
  const choice = id ? settingsChoice(snapshot, id) : undefined;
  return {
    settings: choice ? choice.id : null,
    release: snapshot.digest,
    defaults: choice?.defaults ?? {},
  };
}

function defaultsKey(defaults: Readonly<Record<string, DefaultMode>>): string {
  return JSON.stringify(
    Object.keys(defaults)
      .sort()
      .map((property) => [property, defaults[property]]),
  );
}

export function policyFingerprint(preview: SettingsPreview): string {
  return JSON.stringify({ settings: preview.settings, defaults: defaultsKey(preview.defaults) });
}

export function capturedMatches(preview: SettingsPreview, captured: CapturedPolicy): boolean {
  if (!preview.settings) return captured.settings === null && Object.keys(captured.defaults).length === 0;
  return (
    captured.settings?.id === preview.settings &&
    captured.settings.release === preview.release &&
    defaultsKey(captured.defaults) === defaultsKey(preview.defaults)
  );
}

export function emptyLabelRow(language: string): LabelRow {
  return { id: crypto.randomUUID(), language, text: '' };
}

export function labelsFromRows(rows: readonly LabelRow[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const row of rows) {
    const language = row.language.trim();
    const text = row.text.trim();
    if (language && text) labels[language] = text;
  }
  return labels;
}

export function labelRowIssue(rows: readonly LabelRow[], row: LabelRow): 'language' | 'text' | 'duplicate' | null {
  const language = row.language.trim();
  const text = row.text.trim();
  if (!language) return 'language';
  if (!text) return 'text';
  if (rows.some((other) => other.id !== row.id && other.language.trim() === language)) return 'duplicate';
  return null;
}

export function labelsFromDraft(rows: readonly LabelRow[]): Record<string, string> | null {
  if (!rows.length || rows.some((row) => labelRowIssue(rows, row))) return null;
  const labels = labelsFromRows(rows);
  if (!Object.keys(labels).length || checkSubjectStructure({ labels }).violations.length) return null;
  return labels;
}
