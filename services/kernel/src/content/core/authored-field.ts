import { CONTENT_AUTHORED_LANGUAGE_MAX, type ContentAuthoredFieldInput } from '../contract/index.ts';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export function admitAuthoredLanguage(language: unknown): language is string {
  if (
    typeof language !== 'string' ||
    language.length < 1 ||
    language.length > CONTENT_AUTHORED_LANGUAGE_MAX ||
    CONTROL_CHARACTERS.test(language)
  )
    return false;
  try {
    new Intl.Locale(language);
    return true;
  } catch {
    return false;
  }
}

export function admitAuthoredRevision(revision: unknown): revision is number {
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1;
}

type DocumentNode = { readonly type?: unknown; readonly content?: readonly DocumentNode[] };

export function authoredFieldContainsMedia(document: unknown): boolean {
  if (document === null || typeof document !== 'object') return false;
  const pending: DocumentNode[] = [document as DocumentNode];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'image' || node.type === 'media') return true;
    if (Array.isArray(node.content)) pending.push(...node.content);
  }
  return false;
}

export function admitAuthoredFieldInput(input: ContentAuthoredFieldInput): string | null {
  if (!admitAuthoredLanguage(input.language)) return 'Invalid authored document language';
  if (!admitAuthoredRevision(input.revision))
    return 'Authored revision must be a positive safe integer allocated by semantic';
  if (authoredFieldContainsMedia(input.document)) return 'Authored field documents cannot contain image or media nodes';
  return null;
}
