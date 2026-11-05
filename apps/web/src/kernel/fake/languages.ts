import type { Fixtures, KernelRecording } from '../fake.ts';
import type { FakeRoute } from '../fake-modules.ts';

export const routes: FakeRoute[] = [];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function languageList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((language): language is string => typeof language === 'string') : [];
}

export function originalLanguage(subject: Fixtures['subjects'][number]): string | undefined {
  const statements = subject.statements as unknown as Record<
    string,
    { rank?: string; value?: { type?: string; content?: unknown } }[]
  >;
  const read = (property: string) => {
    const values = statements[property] ?? [];
    const preferred = values.filter((statement) => statement.rank === 'preferred');
    const normal = values.filter((statement) => statement.rank === 'normal');
    for (const statement of preferred.length > 0 ? preferred : normal) {
      if (statement.value?.type !== 'value') continue;
      const content = statement.value.content;
      if (property === 'schema:inLanguage' && typeof content === 'string') return content;
      if (property === 'schema:name' && isRecord(content) && typeof content.language === 'string')
        return content.language;
    }
    return undefined;
  };
  return read('schema:inLanguage') ?? read('schema:name');
}

export function chosenLabels(
  labels: Record<string, string>,
  languages: readonly string[],
  original?: string,
): Record<string, string> {
  const available = Object.keys(labels).filter((language) => typeof labels[language] === 'string');
  const exact = (language: string) => available.find((candidate) => candidate.toLowerCase() === language.toLowerCase());
  const language =
    languages.map(exact).find((candidate): candidate is string => candidate !== undefined) ??
    (original ? exact(original) : undefined) ??
    exact('en');
  return language ? { [language]: labels[language]! } : {};
}

/** Replay subject labels as the kernel selects them for the request's language list. */
export function localizeRecording(
  recording: KernelRecording,
  languages: readonly string[],
  fixtures: Fixtures,
): KernelRecording {
  const copy = structuredClone(recording);
  if (languages.length === 0) return copy;
  const subjects = new Map(fixtures.subjects.map((subject) => [subject.id, subject]));

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;

    const fixture = typeof value.id === 'string' ? subjects.get(value.id) : undefined;
    if (fixture && isRecord(value.labels)) {
      const labels = chosenLabels(fixture.labels, languages, originalLanguage(fixture));
      value.labels = labels;
      const language = Object.keys(labels)[0];
      const summary = value.summary;
      if (language && isRecord(summary) && isRecord(summary.label))
        summary.label = { value: labels[language], language };
    }

    for (const [key, child] of Object.entries(value)) {
      const related = subjects.get(key);
      if (related && isRecord(child) && isRecord(child.labels))
        child.labels = chosenLabels(related.labels, languages, originalLanguage(related));
      visit(child);
    }
  };
  visit(copy);
  return copy;
}

/** Page reads retain full subject labels; only their planned search-result lists use the requested languages. */
export function localizeSearchReads(
  recording: KernelRecording,
  languages: readonly string[],
  fixtures: Fixtures,
): KernelRecording {
  const copy = structuredClone(recording);
  if (languages.length === 0) return copy;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    if (Array.isArray(value.subjects)) {
      const localized = localizeRecording({ status: 200, subjects: value.subjects }, languages, fixtures);
      value.subjects = localized.subjects;
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'subjects') visit(child);
  };
  visit(copy);
  return copy;
}
