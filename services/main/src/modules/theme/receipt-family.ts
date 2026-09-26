import { createHash } from 'node:crypto';

export const receiptFamilies = { 'theme.approve': 'theme-activation-v1' } as const;

export function themeReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0${receiptFamilies['theme.approve']}`).digest('hex')}`;
}
