export const WORK_STRUCTURE_PUBLICATION_RECEIPT_FAMILY = 'work-structure-publication-v1';
export const WORK_STRUCTURE_WITHDRAWAL_RECEIPT_FAMILY = 'work-structure-withdrawal-v1';

export const receiptFamilies: Readonly<Record<string, string>> = {
  'work.publish': WORK_STRUCTURE_PUBLICATION_RECEIPT_FAMILY,
  'work.withdraw-publication': WORK_STRUCTURE_WITHDRAWAL_RECEIPT_FAMILY,
};
