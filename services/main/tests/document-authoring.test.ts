import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { textContributionDigest, InvalidContributionInput } from '../src/modules/contribution/draft.ts';
import { textContributionEditDigest } from '../src/modules/contribution/edit.ts';

test('draft idempotency binds formatting and rejects a second independent text body', () => {
  const document = fromPlainText('Same words');
  const create = { work: `https://rezics.com/id/${randomUUID()}`, language: 'zh-Hant',
    actingSubject: `https://rezics.com/id/${randomUUID()}`, document };
  const edit = { contribution: `https://rezics.com/id/${randomUUID()}`,
    expectedHead: `https://rezics.com/id/${randomUUID()}`, actingSubject: create.actingSubject, document };
  const formatted = structuredClone(document);
  formatted.doc.content![0]!.content![0]!.marks = [{ type: 'bold' }];
  expect(textContributionDigest(create)).not.toBe(textContributionDigest({ ...create, document: formatted }));
  expect(textContributionEditDigest(edit)).not.toBe(textContributionEditDigest({ ...edit, document: formatted }));
  expect(() => textContributionDigest({ ...create, body: 'Same words' })).toThrow(InvalidContributionInput);
  expect(() => textContributionEditDigest({ ...edit, body: 'Same words' })).toThrow(InvalidContributionInput);
});
