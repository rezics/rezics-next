import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { releaseProfile } from '../definitions/release-v1.ts';
import { webPublicationProfile } from '../definitions/web-publication-v1.ts';
import { webSnapshotProfile } from '../definitions/web-snapshot-v1.ts';
import { workMetadataProfile } from '../definitions/work-metadata-v1.ts';
import { workMetadataV2Profile } from '../definitions/work-metadata-v2.ts';
import { workMetadataDetailsProfile } from '../definitions/work-metadata-details-v1.ts';
import { workMetadataDetailsV2Profile } from '../definitions/work-metadata-details-v2.ts';

test('v1 work and edition profiles stay free of release kinds and language lists; v2 admits them', () => {
  const workV1 = renderProfile(workMetadataProfile);
  const workV2 = renderProfile(workMetadataV2Profile);
  const detailsV1 = renderProfile(workMetadataDetailsProfile);
  const detailsV2 = renderProfile(workMetadataDetailsV2Profile);
  expect(workV1).not.toContain('rv:release');
  expect(workV2).toContain('rv:release');
  expect(workV2).toContain('sh:class rv:Release');
  expect(detailsV1).toContain('sh:path rv:editionLanguage');
  expect(detailsV1).not.toContain('rv:contentLanguages');
  expect(detailsV2).toContain('rv:contentLanguages');
  expect(detailsV2).toContain('rv:isTranslation');
  expect(detailsV2).toContain('rv:titleLanguage');
  expect(detailsV2).toContain('rv:tracklistLanguage');
  expect(detailsV2).toContain('work-metadata-details-v2');
});

test('a release profile names kind and status, and a web snapshot names bytes, time and coverage', () => {
  const release = renderProfile(releaseProfile);
  const publication = renderProfile(webPublicationProfile);
  const snapshot = renderProfile(webSnapshotProfile);
  for (const kind of ['formal', 'web', 'fixed', 'virtual']) expect(release).toContain(`"${kind}"`);
  for (const status of ['official', 'unofficial', 'virtual', 'withdrawn', 'cancelled']) {
    expect(release).toContain(`"${status}"`);
  }
  expect(publication).toContain('rv:originalUrl');
  expect(publication).toContain('"web"');
  expect(snapshot).toContain('rv:byteDigest');
  expect(snapshot).toContain('xsd:dateTime');
  expect(snapshot).toContain('rv:coverageScope');
  expect(snapshot).toContain('rv:WebSnapshot');
});
