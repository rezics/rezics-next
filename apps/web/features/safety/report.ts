import { parseAddressSegment } from '../address/path.ts';
import type { browserMainApi } from '../api/browser.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { safetyText, type SafetyMessages } from './messages.ts';

// Main's public report shapes (`services/main/src/modules/public-report/contract.ts`),
// taken from the typed Eden client so a contract change breaks this build.
type Client = ReturnType<typeof browserMainApi>;
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Report = Client['v1']['public-reports'];
export type ReportInput = Parameters<Report['post']>[0];
export type ReportCategory = ReportInput['category'];
export type NciiDeclaration = NonNullable<ReportInput['ncii']>;
export type CopyrightDeclaration = NonNullable<ReportInput['copyright']>;
export type ReportReceipt = Ok<Report['post']>;
type Case = ReturnType<Report>;
export type CaseStatus = Ok<Case['get']>;
export type CaseStep = CaseStatus['steps'][number];
type Correspondence = Parameters<Case['correspondence']['post']>[0];
export type CorrespondenceInput = Correspondence;
export type CounterNotice = NonNullable<Correspondence['counterNotice']>;
export type ReportList = Ok<Report['mine']['get']>;

/**
 * Which declarations Main requires for each kind of report; a category it
 * does not list here would fail to compile. Main refuses a report that lacks
 * them, so this only decides which fields the form shows.
 */
const declarations = {
  child_exploitation: null, ncii: 'ncii', credible_threat: null, copyright: 'copyright', privacy: null,
  harassment: null, hateful_abuse: null, fraud_or_malware: null, explicit_imagery: null, impersonation: null,
  spam_or_manipulation: null, illegal_content: null, realm_rules: null,
} as const satisfies Record<ReportCategory, 'ncii' | 'copyright' | null>;

/** Main handles these first and restricts who can read their evidence. */
const urgent: ReadonlySet<ReportCategory> = new Set(['child_exploitation', 'ncii', 'credible_threat']);

/** The categories in the order the form lists them; Realm rules only where a Realm is reported. */
export function categoriesFor(realm: string | null): ReportCategory[] {
  return (Object.keys(declarations) as ReportCategory[]).filter(category => category !== 'realm_rules' || realm);
}
export const declarationOf = (category: ReportCategory) => declarations[category];
export const isUrgent = (category: ReportCategory) => urgent.has(category);
/** Contact email is required where Main requires a declaration: it must reach the person who made it. */
export const needsEmail = (category: ReportCategory) => declarations[category] !== null;

export type Text = { [Key in keyof SafetyMessages]: string };
/** One locale's strings. */
export const textFor = (locale: UiLocale): Text => Object.fromEntries(
  Object.entries(safetyText).map(([key, row]) => [key, row[locale]])) as Text;

/** `{name}` slots in a catalog string. */
export function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (slot, name: string) => values[name] ?? slot);
}

/** "5 minutes", "2 hours": how long a spent budget asks the reader to wait, in the reader's language. */
export function waitText(seconds: number, locale: UiLocale): string {
  const [unit, size] = seconds >= 86_400 ? ['day', 86_400] as const : seconds >= 3_600 ? ['hour', 3_600] as const
    : seconds >= 60 ? ['minute', 60] as const : ['second', 1] as const;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' })
    .format(Math.max(1, Math.ceil(seconds / size)));
}

/** The label of one of the catalog's keyed families, such as `cat_ncii`. */
export const keyed = (text: Text, family: string, key: string, fallback = key): string =>
  (text as Record<string, string>)[`${family}_${key}`] ?? fallback;

const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
/** The case credential lives in the URL fragment, which no server or referrer ever sees. */
export const credentialFromHash = (hash: string): string | null => {
  const value = hash.replace(/^#/, '');
  return CREDENTIAL.test(value) ? value : null;
};
export const casePath = (caseId: string, credential: string) => `/report/${caseId}#${credential}`;

/** The report page for a target: the REZICS ID of what is reported (Main resolves only IDs and its own addresses). */
export function reportHref(target: string, realm?: string | null): string {
  const query = new URLSearchParams({ target });
  if (realm) query.set('realm', realm);
  return `/report?${query}`;
}

const ID = 'https://rezics.com/id/';
/**
 * The ID Main can resolve for a page this site shows a post on, or null when
 * the page's address carries none. Only discussion and reply pages do:
 * `/r/{realm}/discussions/{reply}` names a reply by its durable identity.
 */
export function discussionTarget(href: string): string | null {
  const segment = /\/discussions\/([^/?#]+)(?:[/?#]|$)/.exec(href)?.[1];
  if (!segment) return null;
  try {
    const reply = parseAddressSegment(decodeURIComponent(segment));
    return reply && reply.kind !== 'alias' ? ID + reply.id : null;
  } catch { return null; }
}

/** Whether `value` looks like something Main can resolve: a REZICS ID or a web address. Main decides which. */
export function plausibleTarget(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 2048) return false;
  try { return ['http:', 'https:'].includes(new URL(text).protocol); } catch { return false; }
}
