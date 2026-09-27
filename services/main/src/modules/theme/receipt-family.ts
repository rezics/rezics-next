import { createHash } from 'node:crypto';

export const receiptFamilies = { 'theme.approve': 'theme-activation-v1',
  'theme.create': 'first-party-theme-v1', 'theme.revise': 'first-party-theme-v1',
  'theme.review': 'first-party-theme-v1', 'theme.activate': 'first-party-theme-v1',
  'theme.revoke': 'first-party-theme-v1', 'theme.control': 'first-party-theme-v1' } as const;

export function firstPartyReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0first-party-theme-v1`).digest('hex')}`;
}

export function themeReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0${receiptFamilies['theme.approve']}`).digest('hex')}`;
}
