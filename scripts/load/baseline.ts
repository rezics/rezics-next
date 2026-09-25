import type { PracticalCorpus } from './corpus.ts';
import { uniqueToken } from './corpus.ts';

export interface LoadBaseline {
  version: 1;
  runId: string;
  works: number;
  corpus: PracticalCorpus;
  actor: string;
  graphSequence: string;
  contentPosition: { dataEpoch: string; sequence: string };
  indexGeneration: string;
  baselineGrantsExpired: true;
}

const id = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const decimal = /^(0|[1-9][0-9]*)$/;

/** Reject a stale or malformed manifest before any mutable clone operation. */
export function validateLoadBaseline(value: unknown, runId: string, works: number): LoadBaseline {
  const baseline = value as Partial<LoadBaseline>;
  const corpus = baseline?.corpus;
  if (!baseline || baseline.version !== 1 || baseline.runId !== runId
    || baseline.works !== works || !Number.isInteger(works) || works < 10 || works > 9_990
    || !corpus || !Array.isArray(corpus.works) || corpus.works.length !== works
    || corpus.mainUnits !== works + 1 || corpus.contentUnits !== 1
    || !id.test(corpus.realm) || !id.test(corpus.ratingContext)
    || !id.test(baseline.actor ?? '') || baseline.baselineGrantsExpired !== true
    || !decimal.test(baseline.graphSequence ?? '')
    || !decimal.test(baseline.contentPosition?.sequence ?? '')
    || !/^[0-9a-f-]{36}$/.test(baseline.contentPosition?.dataEpoch ?? '')
    || !/^urn:rezics:text-index-generation:[0-9a-f-]{36}$/.test(baseline.indexGeneration ?? '')
    || !Array.isArray(corpus.cases) || corpus.cases.length !== 7) {
    throw new Error('load baseline manifest is incompatible or incomplete');
  }
  const workIds = new Set<string>();
  const mainIds = new Set<string>();
  const receipts = new Set<string>();
  for (const [index, item] of corpus.works.entries()) {
    if (!item || !id.test(item.work) || !id.test(item.main)
      || !id.test(item.head) || !id.test(item.selection)
      || !item.createReceipt?.startsWith('urn:rezics:receipt:')
      || !item.selectionReceipt?.startsWith('urn:rezics:receipt:')
      || item.token !== uniqueToken(index)
      || item.language !== (index % 101 === 7 ? 'zh' : index % 137 === 9 ? 'ja' : 'en')
      || workIds.has(item.work) || mainIds.has(item.main)
      || receipts.has(item.createReceipt) || receipts.has(item.selectionReceipt)) {
      throw new Error(`load baseline Work ${index} is malformed or duplicated`);
    }
    workIds.add(item.work);
    mainIds.add(item.main);
    receipts.add(item.createReceipt);
    receipts.add(item.selectionReceipt);
  }
  const expectedCases = ['hot-main', 'other-main', 'chinese-main', 'realm-adoption',
    'realm-fallback', 'rejected-candidate', 'content'];
  if (corpus.cases.some((item, index) => item.name !== expectedCases[index]
    || item.expectedWork !== null && !workIds.has(item.expectedWork))) {
    throw new Error('load baseline query cases differ from its Works');
  }
  return baseline as LoadBaseline;
}

/** Fresh Works straddle the hot boundary; background Works remain read-only. */
export function combineLoadCorpus(background: PracticalCorpus, fresh: PracticalCorpus,
  totalWorks: number): PracticalCorpus {
  if (background.works.length + fresh.works.length !== totalWorks
    || fresh.works.length < 10 || totalWorks > 10_000) {
    throw new Error('load baseline and fresh cohort do not cover the requested Work count');
  }
  const hotFresh = Math.ceil(fresh.works.length / 2);
  const works = [
    ...fresh.works.slice(0, hotFresh), ...background.works,
    ...fresh.works.slice(hotFresh),
  ];
  const writableIndices = [
    ...Array.from({ length: hotFresh }, (_, index) => index),
    ...Array.from({ length: fresh.works.length - hotFresh },
      (_, index) => hotFresh + background.works.length + index),
  ];
  return { realm: fresh.realm, ratingContext: fresh.ratingContext,
    works, writableIndices, mainUnits: background.mainUnits + fresh.mainUnits,
    contentUnits: background.contentUnits + fresh.contentUnits,
    cases: fresh.cases };
}
