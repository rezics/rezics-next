import { expect, test } from 'bun:test';
import {
  catalogueFileCorrectionOriginParam,
  parseCatalogueFileCorrectionOrigin,
  type CatalogueFileCorrectionOrigin,
} from '../src/features/catalogue/catalogue-file-profile/origin';
import { catalogueFile, catalogueFileProfileFixture } from '../src/kernel/fake/catalogue-file-profile';

test('the correction boundary refuses contradictory, nested, wrong-locale and overbudget intent without truncation', async () => {
  const read = await catalogueFileProfileFixture('ready').read();
  if (!read.ok) throw new Error('Expected current File');
  const origin: CatalogueFileCorrectionOrigin = {
    subject: catalogueFile,
    type: read.public.subject.type,
    context: read.public.subject.context,
    definition: read.digest,
    returnHref: `/en/subjects/${catalogueFile}/file#catalogue-file-reader`,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of [
    { ...origin, realm: catalogueFile },
    { ...origin, returnHref: origin.returnHref.replace('/en/', '/ja/') },
    { ...origin, returnHref: `/en/subjects/${catalogueFile}/file?via=${encodeURIComponent(origin.returnHref)}` },
    { ...origin, definition: 'x'.repeat(2049) },
    { ...origin, selection: { property: 'wdt:P4092', statement: 'row-0', holder: catalogueFile } },
  ])
    expect(parseCatalogueFileCorrectionOrigin(encode(value), 'en', catalogueFile).kind).toBe('invalid');
  const valid = catalogueFileCorrectionOriginParam(origin, 'en', catalogueFile)!;
  expect(parseCatalogueFileCorrectionOrigin(valid, 'en', catalogueFile).kind).toBe('valid');
  expect(parseCatalogueFileCorrectionOrigin(valid, 'en', catalogueFile, true).kind).toBe('invalid');
  expect(parseCatalogueFileCorrectionOrigin('x'.repeat(2049), 'en', catalogueFile).kind).toBe('invalid');
  expect(
    catalogueFileCorrectionOriginParam(
      { ...origin, type: 'schema:Book' },
      'en',
      catalogueFile,
      catalogueFile,
      origin.type,
    ),
  ).toBeUndefined();
});
