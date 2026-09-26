import { createHash } from 'node:crypto';

/** Access admission action to exact Content receipt family. */
export const receiptFamilies = {
  'content.protection.tighten': 'content-protection-change',
  'content.protection.confirm': 'content-protection-change',
  'content.protection.relax': 'content-protection-change',
  'content.correction.propose': 'content-correction-propose',
  'content.correction.review': 'content-correction-decide',
} as const;

export type ProtectionAdmissionAction = keyof typeof receiptFamilies;

export function protectionReceiptIri(admissionId: string, action: ProtectionAdmissionAction) {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0${receiptFamilies[action]}`).digest('hex')}`;
}
