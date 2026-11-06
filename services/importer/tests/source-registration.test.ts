import { expect, test } from 'bun:test';
import { convertBangumi, converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { convertVndb, converter_revision as vndbRevision } from '@rezics/conversion/vndb';
import { convertOpenLibrary, converter_revision as openLibraryRevision } from '@rezics/conversion/open-library';
import { convertWikidata, converter_revision as wikidataRevision } from '@rezics/conversion/wikidata';
import type { ConversionContext } from '@rezics/conversion';
import bangumi from '../../../specs/fixtures/imports/bangumi/subject.json';
import {
  admittedSourceAdmissions,
  bangumiSourceAdmission,
  openLibrarySourceAdmission,
  vndbSourceAdmission,
  wikidataSourceAdmission,
} from '../src/registration-contract.ts';
import { bindSourceRegistration } from '../src/source-registry.ts';

test('four-provider admissions are declared values bound without acquisition', () => {
  const converters = {
    bangumi: { convert: convertBangumi, revision: bangumiRevision, admission: bangumiSourceAdmission },
    vndb: { convert: convertVndb, revision: vndbRevision, admission: vndbSourceAdmission },
    openlibrary: { convert: convertOpenLibrary, revision: openLibraryRevision, admission: openLibrarySourceAdmission },
    wikidata: { convert: convertWikidata, revision: wikidataRevision, admission: wikidataSourceAdmission },
  };
  for (const kind of ['bangumi', 'vndb', 'openlibrary', 'wikidata'] as const) {
    const admission = admittedSourceAdmissions[kind];
    expect(admission).toBe(converters[kind].admission);
    expect(admission.revision.converter_revision).toBe(converters[kind].revision);
    const registration = bindSourceRegistration(admission);
    expect(registration.sourceKind).toBe(kind);
    expect(registration.source).toBe(admission.identity.defaultAlias);
    expect(registration.converter_revision).toBe(admission.revision.converter_revision);
  }
  const context: ConversionContext = { source: bangumiSourceAdmission.identity.defaultAlias };
  const bound = bindSourceRegistration(bangumiSourceAdmission);
  const input = { external_id: String(bangumi.id), record_revision: '7', record: bangumi };
  const fromRegistration = bound.convert(input, context);
  const fromConverter = convertBangumi(input, context);
  expect(fromRegistration.digest).toBe(fromConverter.digest);
});
