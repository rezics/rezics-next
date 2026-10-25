import { expect, test } from 'bun:test';
import type { CommandTransaction } from '../../src/command/command.ts';
import { appendImportedField, type ImportedFieldResult } from '../../src/content/imported-fields.ts';
import type { ImportedFieldInput } from '../../src/content/imported-contract.ts';
import { claimMedia, type ClaimMediaInput, type MediaReservationInput } from '../../src/content/media.ts';
import type { Actor } from '../../src/request/access.ts';

test('semantic summary hook input includes an allocated candidate and numeric revision', () => {
  const append: (tx: CommandTransaction, input: ImportedFieldInput) => Promise<ImportedFieldResult> =
    appendImportedField;
  const input: ImportedFieldInput = {
    subject: '00000000-0000-8000-8000-000000000000',
    candidate: '00000000-0000-8000-8000-000000000001',
    revision: 2,
    source: {
      source: 'example',
      external_id: 'record-1',
      record_revision: 'r1',
      digest: 'a'.repeat(64),
      converter_revision: 'converter-1',
      field_group: 'summary',
      references: [],
    },
    rights: { license: 'LicenseRef-unknown', obligations: [], attribution: 'Example' },
    language: 'en',
    document: { version: 1 },
  };
  // @ts-expect-error Semantic revision is numeric, not a fabricated content revision id.
  const invalidRevision: ImportedFieldInput = { ...input, revision: '2' };
  expect([append, input.candidate, input.revision, invalidRevision]).toBeTruthy();
});

test('media claim accepts original post images and explicit semantic candidate references', () => {
  const claim: (tx: CommandTransaction, input: ClaimMediaInput) => Promise<void> = claimMedia;
  const actor: Actor = { kind: 'anonymous' };
  const semanticClaim: ClaimMediaInput = {
    mediaIds: ['00000000-0000-8000-8000-000000000010'],
    containerId: '00000000-0000-8000-8000-000000000011',
    author: actor,
    reference: {
      kind: 'semantic_candidate',
      subjectId: '00000000-0000-8000-8000-000000000012',
      candidateId: '00000000-0000-8000-8000-000000000013',
      revision: 3,
    },
  };
  const contentClaim: ClaimMediaInput = {
    mediaIds: ['00000000-0000-8000-8000-000000000010'],
    containerId: '00000000-0000-8000-8000-000000000011',
    author: actor,
    itemId: '00000000-0000-8000-8000-000000000014',
    revisionId: '00000000-0000-8000-8000-000000000015',
  };
  // @ts-expect-error Semantic candidate claims have no content item or revision ids.
  const mixedClaim: ClaimMediaInput = { ...semanticClaim, itemId: '00000000-0000-8000-8000-000000000014' };
  const reservation: MediaReservationInput = {
    containerId: '00000000-0000-8000-8000-000000000011',
    purpose: 'post-image',
    mediaType: 'image/webp',
    byteCount: 1,
  };
  // @ts-expect-error Browser reservation cannot directly reserve a cover.
  const coverReservation: MediaReservationInput = { ...reservation, purpose: 'cover' };
  expect([claim, semanticClaim, contentClaim, mixedClaim, coverReservation]).toBeTruthy();
});
