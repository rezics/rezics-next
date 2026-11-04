import { subjectVisitReturn } from '../../../pages/subject-visit-navigation';

const statementIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function recordingStatementDomId(statement: string): string {
  return `recording-statement-${statement}`;
}

function currentRecordingAddress(value: string, subjectId: string, locale: string): URL | undefined {
  if (!statementIdPattern.test(subjectId)) return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const parts = url.pathname.split('/');
  if (parts[1] !== locale || parts[2] !== 'subjects' || parts[3]?.toLowerCase() !== subjectId.toLowerCase()) return;
  return url;
}

/** Add the displayed statement as the existing Subject visit's current focus locator. */
export function recordingStatementReturnHref(
  currentHref: string | undefined,
  subjectId: string,
  statement: string,
  locale: string,
): string | undefined {
  if (!currentHref || !statementIdPattern.test(statement)) return;
  const url = currentRecordingAddress(currentHref, subjectId, locale);
  if (!url) return;
  url.hash = recordingStatementDomId(statement);
  return subjectVisitReturn(`${url.pathname}${url.search}${url.hash}`, locale);
}

/** Restore focus only when the current localized Subject address still owns this statement. */
export function recordingStatementFromHref(
  currentHref: string | undefined,
  subjectId: string,
  locale: string,
): string | undefined {
  if (!currentHref) return;
  const url = currentRecordingAddress(currentHref, subjectId, locale);
  if (!url) return;
  const match = /^#recording-statement-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.hash);
  return match?.[1];
}
