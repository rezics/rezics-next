import { storySubjects } from '../src/kernel/story-subjects';

const subjectsById = new Map<string, (typeof storySubjects)[number]>(
  storySubjects.map((subject) => [subject.id, subject] as const),
);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Apply only recorder aliases that were bound from a known input identity to a stable fixture identity. */
export function applyIdentityAliases(value: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return aliases.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => applyIdentityAliases(item, aliases));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, applyIdentityAliases(child, aliases)]));
}

/** Keep stable story values while allowing a known current identity binding to update every reference to that ID. */
export function stableRecording(
  value: unknown,
  previous: unknown,
  currentIdentityIds: ReadonlySet<string> = new Set(),
): unknown {
  if (previous === undefined) return value;
  if (typeof value === 'string' && typeof previous === 'string')
    return currentIdentityIds.has(value) ? value : previous;
  if (Array.isArray(value) && Array.isArray(previous))
    return previous.map((item, index) => stableRecording(value[index], item, currentIdentityIds));
  if (!value || typeof value !== 'object' || !previous || typeof previous !== 'object') return previous;
  const current = value as Record<string, unknown>;
  const before = previous as Record<string, unknown>;
  const oldIds = Object.keys(before).filter((key) => key.match(uuid));
  const newIds = Object.keys(current).filter((key) => key.match(uuid));
  return Object.fromEntries([
    ...Object.entries(current).filter(([name]) => !Object.hasOwn(before, name) && !newIds.includes(name)),
    ...Object.entries(before).flatMap(([name, item]) => {
      if (['cover', 'label', 'labels'].includes(name) && !Object.hasOwn(current, name)) return [];
      const recordedName = oldIds.includes(name) ? (newIds[oldIds.indexOf(name)] ?? name) : name;
      return [
        [
          name,
          ['cover', 'label', 'labels'].includes(name)
            ? current[recordedName]
            : stableRecording(current[recordedName], item, currentIdentityIds),
        ],
      ];
    }),
  ]);
}

/** Apply shared story labels and covers only when the response already carries that exact fixture identity. */
export function applyStorySubjects(value: unknown, locale: string): unknown {
  if (Array.isArray(value)) return value.map((item) => applyStorySubjects(item, locale));
  if (!isRecord(value)) return value;

  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, applyStorySubjects(child, locale)]),
  ) as Record<string, unknown>;
  if (typeof result.id !== 'string' || typeof result.type !== 'string' || !(result.labels || result.label))
    return result;

  const subject = subjectsById.get(result.id);
  if (!subject) return result;

  const labels = subject.labels as Record<string, string>;
  const localizedLanguage = labels[locale] ? locale : labels.en ? 'en' : Object.keys(labels)[0];
  if (!localizedLanguage) return result;
  const localizedLabel = labels[localizedLanguage]!;
  result.type = subject.type;
  if (isRecord(result.labels)) result.labels = { ...subject.labels };
  if (typeof result.label === 'string') result.label = localizedLabel;
  else if (isRecord(result.label))
    result.label = { ...result.label, value: localizedLabel, language: localizedLanguage };
  if (isRecord(result.summary)) {
    const summary = { ...result.summary };
    if (isRecord(summary.label))
      summary.label = { ...summary.label, value: localizedLabel, language: localizedLanguage };
    summary.cover = subject.cover ?? null;
    result.summary = summary;
  }
  result.cover = subject.cover ?? null;
  return result;
}

/**
 * Search response rows, order and identity come from the latest kernel response. Reuse only its stable as_of value;
 * an older response must not contribute rows, facts or aliases.
 */
export function normalizeSearchRecording(
  value: unknown,
  previous: unknown,
  locale: string,
  aliases: ReadonlyMap<string, string> = new Map(),
): unknown {
  const normalized = applyStorySubjects(applyIdentityAliases(value, aliases), locale);
  if (!isRecord(normalized) || !isRecord(previous) || typeof previous.as_of !== 'string') return normalized;
  return { ...normalized, as_of: previous.as_of };
}

/** Normalize a recorder response using exact seed aliases before stable fields preserve older values. */
export function normalizeRecording(
  value: unknown,
  previous: unknown,
  locale: string,
  aliases: ReadonlyMap<string, string> = new Map(),
): unknown {
  const current = applyStorySubjects(applyIdentityAliases(value, aliases), locale);
  return applyStorySubjects(stableRecording(current, previous, new Set(aliases.values())), locale);
}
