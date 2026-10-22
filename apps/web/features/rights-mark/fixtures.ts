import type { DisplayObligations } from './rights-mark.tsx';
import type { MediaImageMetadata } from '@rezics/ui/media-image';

/** Recorded cover provenance, without a text licence or an inferred holder. */
export const knownCoverCredit: NonNullable<MediaImageMetadata['coverCredit']> = {
  kind: 'copyright', text: '© 海辺書房', holder: '海辺書房',
  source: { name: 'Example archive', href: 'https://example.test/records/cover',
    identity: { record: 'https://rezics.com/id/00000000-0000-4000-8000-000000000031',
      observation: 'https://rezics.com/id/00000000-0000-4000-8000-000000000032',
      component: '/images/cover', fieldLocator: '/cover/url' } },
  permittedRole: 'cover',
};

export const unknownCoverCredit: NonNullable<MediaImageMetadata['coverCredit']> = {
  ...knownCoverCredit, text: '(c) rights holder via Example archive', holder: null,
};

export const mixedScriptCoverCredit: NonNullable<MediaImageMetadata['coverCredit']> = {
  ...knownCoverCredit,
  text: '© دار الكتب 海辺書房 — Éditions de la rivière',
  holder: 'دار الكتب 海辺書房 — Éditions de la rivière',
  source: { ...knownCoverCredit.source, name: 'مكتبة الأرشيف — 海辺書房 InternationalCoverArchive'.repeat(3) },
};

/** A Creative Commons deed, the shape a licence instrument has on the read. */
export const ccBySa = 'https://creativecommons.org/licenses/by-sa/3.0/';
export const sourceUrl = 'https://example.test/records/1';

/** Credit plus share-alike, as an assessed wiki-display read returns them. */
export const attributed: DisplayObligations = {
  status: 'assessed',
  use: 'wiki_display',
  instrument: ccBySa,
  obligations: [
    { kind: 'attribution', instrument: ccBySa, appliesTo: 'display', notice: `Example, ${sourceUrl}` },
    { kind: 'share_alike', instrument: ccBySa, appliesTo: 'all', notice: null },
  ],
};

/** Equal credit and licence text do not erase different assessed materials. */
export const distinctMaterials = [
  { ...attributed, identity: { assessmentId: '00000000-0000-4000-8000-000000000011',
    materialId: '00000000-0000-4000-8000-000000000012', component: 'record',
    sourceRecordId: '00000000-0000-4000-8000-000000000013', wikiEvidenceId: null } },
  { ...attributed, identity: { assessmentId: '00000000-0000-4000-8000-000000000021',
    materialId: '00000000-0000-4000-8000-000000000022', component: 'synopsis',
    sourceRecordId: '00000000-0000-4000-8000-000000000023',
    wikiEvidenceId: 'https://rezics.com/id/00000000-0000-4000-8000-000000000024' } },
  { ...attributed, identity: { assessmentId: '00000000-0000-4000-8000-000000000041',
    materialId: '00000000-0000-4000-8000-000000000042', component: 'synopsis',
    sourceRecordId: null, wikiEvidenceId: null } },
] satisfies readonly DisplayObligations[];

/** An attribution whose notice is only an address, so the visible name is the host. */
export const hostOnly: DisplayObligations = {
  status: 'assessed',
  use: 'wiki_display',
  instrument: ccBySa,
  obligations: [
    { kind: 'attribution', instrument: ccBySa, appliesTo: 'display', notice: sourceUrl },
  ],
};

/** A licence and no further duties. */
export const instrumentOnly: DisplayObligations = {
  status: 'assessed', use: 'wiki_display', instrument: ccBySa, obligations: [],
};

export const unassessed: DisplayObligations = { status: 'unassessed' };

/** A second assessed read, so a later row can start a new run. */
export const creditedOnly: DisplayObligations = {
  status: 'assessed',
  use: 'wiki_display',
  instrument: 'https://creativecommons.org/licenses/by/4.0/',
  obligations: [
    { kind: 'attribution', instrument: 'https://creativecommons.org/licenses/by/4.0/', appliesTo: 'display',
      notice: 'Archive, https://archive.example/works/2' },
  ],
};
