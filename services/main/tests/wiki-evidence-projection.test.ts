import { describe, expect, test } from 'bun:test';
import { withholdPassage, type WikiEvidenceRow } from '../src/modules/wiki/evidence.ts';
import { projectWikiEvidence } from '../src/modules/wiki/evidence-read.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import { checkLocator } from '../../../packages/wiki-toolkit/protocol/locator.ts';

const cfi = 'epubcfi(/6/2[WITHHELD chapter]!/4,/1:0[WITHHELD^] start^,text,];s=b,/1:8[,WITHHELD^] end])';
const safeCfi = 'epubcfi(/6/2!/4,/1:0;s=b,/1:8)';
const row: WikiEvidenceRow = {
  id: 'evidence', sourceWork: 'source-work', representationSha256: 'a3'.repeat(32),
  locator: { version: 'rezics-locator-v1', source: { type: 'external',
    representationSha256: 'a3'.repeat(32), mediaType: 'application/epub+zip' },
    selector: { type: 'EpubCfiSelector', cfi } },
  quote: 'WITHHELD passage', method: { agent: 'wiki-tool', model: cfi, inference: 'local' },
  modality: 'said', submitter: 'submitter', rightsBasis: 'unknown', claim: 'claim', claimKind: 'statement',
};
const session = (withheld: readonly string[]) => ({ deps: { wikiEvidence: {
  withheld: async () => new Set(withheld),
} } }) as unknown as WorkReadSession;

describe('public wiki quotation withholding', () => {
  test('compound CFI assertions are absent from the complete answer, including method fallbacks', async () => {
    expect(checkLocator(row.locator)).toBe(true);
    const projected = await projectWikiEvidence(session([row.id]), [row]);
    expect(checkLocator(projected[0]!.locator)).toBe(true);
    expect(projected).toEqual([{ id: row.id, sourceWork: row.sourceWork,
      representationSha256: row.representationSha256,
      locator: { version: 'rezics-locator-v1', source: { type: 'external',
        representationSha256: row.representationSha256, mediaType: 'application/epub+zip' },
        selector: { type: 'EpubCfiSelector', cfi: safeCfi } },
      quote: null, quoteWithheld: true, method: { agent: 'wiki-tool', model: safeCfi, inference: 'local' },
      modality: row.modality, submitter: row.submitter, rightsBasis: row.rightsBasis }]);
    expect(JSON.stringify(projected)).not.toContain('WITHHELD');
    expect(row.quote).toBe('WITHHELD passage');
    expect((row.locator as { selector: { cfi: string } }).selector.cfi).toBe(cfi);
  });

  test('permitted quotation retains its exact locator and extraction provenance', async () => {
    const [permitted, withheld] = await projectWikiEvidence(session(['restricted']), [row, { ...row, id: 'restricted' }]);
    expect(permitted).toMatchObject({ locator: row.locator, quote: row.quote, quoteWithheld: false, method: row.method });
    expect(withheld!.quoteWithheld).toBe(true);
    expect(JSON.stringify(withheld)).not.toContain('WITHHELD');
  });

  test('missing quotation authority withholds passages and keeps safe positions and digests', async () => {
    const [projected] = await projectWikiEvidence({ deps: {} } as WorkReadSession, [row]);
    expect(projected!.quoteWithheld).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('WITHHELD');
    expect(projected!.representationSha256).toBe(row.representationSha256);
    expect(projected!.locator).toMatchObject({ selector: { cfi: safeCfi } });
  });

  test('nested selectors keep numeric locations and never use malformed CFI assertion text as a fallback', () => {
    expect(withholdPassage({ selectors: [
      { type: 'TextQuoteSelector', exact: 'WITHHELD', prefix: 'WITHHELD', suffix: 'WITHHELD' },
      { type: 'ByteRangeSelector', start: 12, end: 30 },
      { type: 'EpubCfiSelector', cfi },
      { type: 'EpubCfiSelector', cfi: 'epubcfi(/6/2!/4,/1:0[WITHHELD,/1:8)' },
    ] })).toEqual({ selectors: [
      { type: 'TextQuoteSelector', exact: null, prefix: null, suffix: null },
      { type: 'ByteRangeSelector', start: 12, end: 30 },
      { type: 'EpubCfiSelector', cfi: safeCfi },
      { type: 'EpubCfiSelector', cfi: null },
    ] });
    expect(withholdPassage({ cfi: safeCfi })).toEqual({ cfi: safeCfi });
  });
});
