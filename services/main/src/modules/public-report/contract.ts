import { parseLanguage } from '../display-language/tag.ts';
import { reasons } from '../safety-queue/contract.ts';
import { operationResult } from '../operation/contract.ts';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId } from '../work/read-contract.ts';

export const CATEGORY_VERSION = 'public-report-v1';
export const categoryProcesses = {
  child_exploitation: { process: 'child_safety', urgent: true },
  ncii: { process: 'ncii', urgent: true },
  credible_threat: { process: 'credible_threat', urgent: true },
  copyright: { process: 'dmca_512', urgent: false },
  privacy: { process: 'privacy', urgent: false },
  harassment: { process: 'platform_rules', urgent: false },
  hateful_abuse: { process: 'platform_rules', urgent: false },
  fraud_or_malware: { process: 'platform_rules', urgent: false },
  explicit_imagery: { process: 'platform_rules', urgent: false },
  impersonation: { process: 'platform_rules', urgent: false },
  spam_or_manipulation: { process: 'platform_rules', urgent: false },
  illegal_content: { process: 'platform_rules', urgent: false },
  realm_rules: { process: 'realm_rules', urgent: false },
} as const;
export type Category = keyof typeof categoryProcesses;
export const PUBLIC_REPORT_COST = { evidence: 1, page: 50, stepsPerMessage: 3,
  ownerResolutions: 2, addressHops: 8, credentialBytes: 32 } as const;
export const PLATFORM_SCOPE = 'governance:platform';
export const SPECIALIST_ACTION = 'governance.safety.evidence';
const text = (max: number) => t.String({ minLength: 1, maxLength: max, pattern: '\\S' });
export const contentLanguage = text(255);
export const copyrightDeclaration = t.Object({ signature: text(300), claimantName: text(300),
  claimantAddress: text(500), claimantPhone: text(100), claimedWork: text(1000),
  materialLocation: text(1000), goodFaith: t.Literal(true), accurateAndAuthorizedUnderPerjury: t.Literal(true) },
{ additionalProperties: false });
export const nciiDeclaration = t.Object({ signature: text(300), depictedPersonOrAuthorized: t.Literal(true),
  goodFaithWithoutConsent: t.Literal(true), supportingInformation: text(4000) }, { additionalProperties: false });
export const reportCategory = t.Union([t.Literal('child_exploitation'), t.Literal('ncii'), t.Literal('credible_threat'),
    t.Literal('copyright'), t.Literal('privacy'), t.Literal('harassment'), t.Literal('hateful_abuse'),
    t.Literal('fraud_or_malware'), t.Literal('explicit_imagery'), t.Literal('impersonation'),
    t.Literal('spam_or_manipulation'), t.Literal('illegal_content'), t.Literal('realm_rules')]);
export const publicReportInput = t.Object({ profile: t.Literal(CATEGORY_VERSION),
  target: t.Union([readId, t.String({ format: 'uri', maxLength: 2048 })]),
  category: reportCategory,
  statement: text(4000), contentLanguage,
  contactEmail: t.Optional(t.String({ format: 'email', maxLength: 320 })),
  actingSubject: t.Optional(readId), realm: t.Optional(readId),
  ncii: t.Optional(nciiDeclaration), copyright: t.Optional(copyrightDeclaration),
}, { additionalProperties: false });
export type PublicReportInput = Static<typeof publicReportInput>;
export const counterDeclaration = t.Object({ signature: text(300), materialLocation: text(1000),
  goodFaithMistakeUnderPerjury: t.Literal(true), name: text(300), address: text(500), phone: text(100),
  courtJurisdiction: text(1000), consentToJurisdiction: t.Literal(true), acceptService: t.Literal(true) },
{ additionalProperties: false });
export const correspondenceInput = t.Object({ kind: t.Union([t.Literal('message'), t.Literal('appeal'),
  t.Literal('counter_notice')]), statement: text(8000), contentLanguage,
  counterNotice: t.Optional(counterDeclaration) }, { additionalProperties: false });
export type CorrespondenceInput = Static<typeof correspondenceInput>;

const uuid = t.String({ format: 'uuid' });
const instant = t.String({ format: 'date-time' });
const profile = t.Literal(CATEGORY_VERSION);
const reportReceipt = { reportId: uuid, caseId: uuid, receivedAt: instant };
export const publicReportReceipt = t.Object({ profile, ...reportReceipt,
  credential: t.String({ pattern: '^[A-Za-z0-9_-]{43}$' }), replayed: t.Boolean() }, { additionalProperties: false });
export const publicReportStatus = t.Object({ profile, ...reportReceipt, state: t.String(),
  generation: t.String(), category: reportCategory, contentLanguage, process: t.String(),
  outcome: t.Nullable(t.String()), reasons: t.Nullable(t.String()),
  statementOfReasons: t.Nullable(t.Object({ ...reasons.properties,
    rule: t.Object({ ref: t.String(), revision: t.String(), digest: t.String() }) })),
  operation: t.Nullable(operationResult),
  steps: t.Array(t.Object({ id: uuid, kind: t.String(), occurredAt: instant, dueAt: t.Nullable(instant),
    statement: t.Nullable(t.String()), contentLanguage: t.Nullable(contentLanguage) }, { additionalProperties: false }),
  { maxItems: PUBLIC_REPORT_COST.page }), nextCursor: t.Nullable(uuid) }, { additionalProperties: false });
export const publicReportList = t.Object({ profile,
  reports: t.Array(t.Object({ ...reportReceipt, category: reportCategory }, { additionalProperties: false }),
    { maxItems: PUBLIC_REPORT_COST.page }), nextCursor: t.Nullable(uuid) }, { additionalProperties: false });
export const correspondenceReceipt = t.Object({ profile, stepId: uuid, replayed: t.Boolean() },
  { additionalProperties: false });

/** BCP 47 validity is independent of UI locale support; preserve original spelling. */
export function validContentLanguage(value: string): boolean {
  return value.length <= 255 && parseLanguage(value) !== null;
}

/** UTC weekdays, preserving receipt time; no holiday service in this profile.
 * https://www.copyright.gov/title17/92chap5.html#512 */
export function addBusinessDays(receivedAt: Date, days: number): Date {
  if (!Number.isInteger(days) || days < 0 || days > 14 || !Number.isFinite(receivedAt.getTime())) {
    throw new RangeError('Invalid business-day input');
  }
  const result = new Date(receivedAt);
  while (days > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    if (result.getUTCDay() !== 0 && result.getUTCDay() !== 6) days--;
  }
  return result;
}
