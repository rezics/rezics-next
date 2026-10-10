import type { DisplayObligations } from './rights-mark.tsx';

/** A Creative Commons deed, the shape a licence instrument has on the read. */
export const ccBySa = 'https://creativecommons.org/licenses/by-sa/3.0/';
const source = 'https://example.test/records/1';

/** Credit plus share-alike, as an assessed wiki-display read returns them. */
export const attributed: DisplayObligations = {
  status: 'assessed',
  use: 'wiki_display',
  instrument: ccBySa,
  obligations: [
    { kind: 'attribution', instrument: ccBySa, appliesTo: 'display', notice: `Recorded source, ${source}` },
    { kind: 'share_alike', instrument: ccBySa, appliesTo: 'all', notice: null },
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
      notice: 'Another recorded source' },
  ],
};
