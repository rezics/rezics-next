import type { CandidateSessionLease } from '../../subject/candidate-lifetime';

export type ChangePageHistory = { addresses: (string | undefined)[]; truncated: boolean };
export const changePageHistoryLimit = 5;
export function firstChangePage(): ChangePageHistory {
  return { addresses: [undefined], truncated: false };
}
export function appendChangePage(history: ChangePageHistory, cursor: string): ChangePageHistory {
  if (!cursor || cursor.length > 4096 || history.addresses.at(-1) === cursor) return history;
  const addresses = [...history.addresses, cursor];
  const truncated = history.truncated || addresses.length > changePageHistoryLimit;
  if (addresses.length > changePageHistoryLimit) addresses.shift();
  return { addresses, truncated };
}
export function validChangePageHistory(value: unknown): value is ChangePageHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const history = value as ChangePageHistory;
  return (
    Object.keys(history).every((key) => key === 'addresses' || key === 'truncated') &&
    Array.isArray(history.addresses) &&
    history.addresses.length > 0 &&
    history.addresses.length <= changePageHistoryLimit &&
    history.addresses.every((cursor) => cursor === undefined || (typeof cursor === 'string' && cursor.length <= 4096)) &&
    typeof history.truncated === 'boolean'
  );
}

export type CurrentCandidateAddress = { subject: string; property: string; candidate: string; context: string };
export type SubjectChangesReturn = {
  id: string;
  subject: string;
  href: string;
  locale: string;
  history: ChangePageHistory;
  revision: number;
  address: CurrentCandidateAddress;
  lease: CandidateSessionLease;
};
type StoredReturn = SubjectChangesReturn & { key: string; stop: () => void };
let stored: StoredReturn | undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clear(key?: string) {
  if (!stored || (key && stored.key !== key)) return;
  const previous = stored;
  stored = undefined;
  previous.stop();
}
function validAddress(address: CurrentCandidateAddress) {
  return (
    uuid.test(address.subject) &&
    uuid.test(address.candidate) &&
    uuid.test(address.context) &&
    !!address.property &&
    address.property.length <= 256
  );
}
function safeSubjectReturnHref(href: string, subject: string, locale: string) {
  if (
    !href.startsWith('/') ||
    href.startsWith('//') ||
    href.includes('\\') ||
    /[\r\n?#]/.test(href) ||
    /%(?:2f|5c|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(href)
  )
    return false;
  try {
    const target = new URL(href, 'https://rezics.invalid');
    const parts = target.pathname.split('/');
    return (
      target.origin === 'https://rezics.invalid' &&
      parts.length === 6 &&
      decodeURIComponent(parts[1] ?? '') === locale &&
      parts[2] === 'subjects' &&
      decodeURIComponent(parts[3] ?? '') === subject &&
      !!parts[4] &&
      parts[5] === 'changes'
    );
  } catch {
    return false;
  }
}

export function saveSubjectChangesReturn(
  visit: Omit<SubjectChangesReturn, 'lease'> & { lease: CandidateSessionLease },
): boolean {
  clear();
  if (
    !visit.lease.current() ||
    !uuid.test(visit.id) ||
    visit.subject !== visit.id ||
    !safeSubjectReturnHref(visit.href, visit.subject, visit.locale) ||
    !visit.locale ||
    !Number.isSafeInteger(visit.revision) ||
    visit.revision < 1 ||
    !validChangePageHistory(visit.history) ||
    !validAddress(visit.address) ||
    visit.address.subject !== visit.subject
  )
    return false;
  const key = crypto.randomUUID();
  const stop = visit.lease.subscribe(() => {
    if (stored?.key === key && !visit.lease.current()) clear(key);
  });
  stored = { ...visit, key, stop };
  return true;
}
export function subjectChangesReturnForReview(
  address: CurrentCandidateAddress,
  reader: string,
): SubjectChangesReturn | undefined {
  if (!stored) return undefined;
  if (!stored.lease.current() || stored.lease.reader !== reader) {
    clear(stored.key);
    return undefined;
  }
  return validAddress(address) &&
    stored.lease.reader === reader &&
    stored.subject === address.subject &&
    stored.address.subject === address.subject &&
    stored.address.property === address.property &&
    stored.address.candidate === address.candidate &&
    stored.address.context === address.context
    ? stored
    : undefined;
}
export function takeSubjectChangesReturn(subject: string, reader: string): SubjectChangesReturn | undefined {
  if (!stored) return undefined;
  if (!stored.lease.current() || stored.lease.reader !== reader || stored.subject !== subject) {
    clear(stored.key);
    return undefined;
  }
  const result = stored;
  clear(result.key);
  return result;
}
