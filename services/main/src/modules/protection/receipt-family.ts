import { createHash } from 'node:crypto';

/** Owner-local Access action to its exact receipt family. */
export const contentReceiptFamilies = {
  'content.protection.tighten': 'content-protection-change',
  'content.protection.confirm': 'content-protection-change',
  'content.protection.relax': 'content-protection-change',
  'content.correction.propose': 'content-correction-propose',
  'content.correction.review': 'content-correction-decide',
} as const;

export const workReceiptFamilies = {
  'work.protection.tighten': 'work-protection-change',
  'work.protection.confirm': 'work-protection-change',
  'work.protection.relax': 'work-protection-change',
  'work.correction.propose': 'work-correction-propose',
  'work.correction.review': 'work-correction-review',
} as const;

export const receiptFamilies = { ...contentReceiptFamilies, ...workReceiptFamilies } as const;

export type ProtectionAdmissionAction = keyof typeof receiptFamilies;
export type ContentProtectionAdmissionAction = keyof typeof contentReceiptFamilies;
export type WorkProtectionAdmissionAction = keyof typeof workReceiptFamilies;

export function protectionReceiptIri(admissionId: string, action: ProtectionAdmissionAction) {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0${receiptFamilies[action]}`).digest('hex')}`;
}
