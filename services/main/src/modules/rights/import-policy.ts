import { resourceFactMaterial, rightsExportUseScope, workDescriptionMaterial, type UseKey } from './store.ts';

export const BANGUMI_LICENSE = 'https://creativecommons.org/licenses/by-sa/3.0/';
export const VNDB_LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/';
export const VNDB_CONTENTS_LICENSE = 'https://opendatacommons.org/licenses/dbcl/1-0/';
export const OPEN_LIBRARY_LICENSE = 'https://creativecommons.org/publicdomain/zero/1.0/';
export const GUTENBERG_LICENSE = 'https://www.gutenberg.org/policy/license.html';

export interface ImportedSource {
  provider: 'bangumi' | 'vndb' | 'open-library' | 'project-gutenberg';
  url: string;
  /** Recorded author credit, when the source supplies one. */
  credit?: string;
}

/** Platform imports assess each delivered material/use in the existing rights
 * owner. Artwork is a different material and never inherits a database licence.
 * VNDB descriptions have field-specific exceptions, so this policy covers facts. */
export function importedRightsAssessments(source: ImportedSource, work: string, description = false) {
  const instrument = { bangumi: BANGUMI_LICENSE, vndb: VNDB_LICENSE,
    'open-library': OPEN_LIBRARY_LICENSE, 'project-gutenberg': GUTENBERG_LICENSE }[source.provider];
  const name = { bangumi: 'Bangumi contributors', vndb: 'VNDB contributors',
    'open-library': 'Open Library contributors', 'project-gutenberg': 'Project Gutenberg' }[source.provider];
  const notice = `${source.credit ? `${source.credit}; ` : ''}${name}, ${source.url}`
    + (source.provider === 'project-gutenberg' ? `; ${GUTENBERG_LICENSE}` : '');
  const obligations: Array<{ kind: 'attribution' | 'share_alike'; instrument: string;
    appliesTo: 'all'; notice: string }> = [{ kind: 'attribution', instrument, appliesTo: 'all', notice }];
  if (source.provider === 'bangumi' || source.provider === 'vndb') {
    obligations.push({ kind: 'share_alike', instrument, appliesTo: 'all', notice });
  }
  if (source.provider === 'vndb') obligations.push({ kind: 'attribution',
    instrument: VNDB_CONTENTS_LICENSE, appliesTo: 'all', notice: `${notice}; ${VNDB_CONTENTS_LICENSE}` });
  const materials = [resourceFactMaterial(work),
    ...(description && source.provider !== 'vndb' ? [workDescriptionMaterial(work)] : [])];
  const uses: UseKey[] = [{ family: 'data_rights', useKind: 'wiki_display', useScope: 'rezics:wiki' },
    ...(['full', 'excerpt', 'quotation', 'evaluation'] as const).map(scope =>
      ({ family: 'data_rights' as const, useKind: scope === 'excerpt' || scope === 'quotation'
        ? 'quotation' as const : 'export' as const, useScope: rightsExportUseScope(scope) })),
    { family: 'data_rights', useKind: 'redistribution', useScope: 'rezics:imports' }];
  return materials.flatMap(material => uses.map(use => ({ material,
    expressionKind: material.component === 'synopsis' ? 'expression' as const : 'compilation' as const,
    ...use,
    basis: source.provider === 'project-gutenberg' ? 'public_domain' as const : 'license' as const,
    outcome: source.provider === 'project-gutenberg' ? 'supported' as const : 'conditional' as const,
    licenseInstrument: source.provider === 'project-gutenberg' ? null : instrument,
    exceptionKind: null, rationale: null, extent: {},
    evidence: { provider: source.provider, sourceUrl: source.url }, obligations,
    expectedAssessment: null })));
}
