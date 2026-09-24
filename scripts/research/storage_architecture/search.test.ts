import { expect, test } from "bun:test";
import { batches, budgetedFilter, cjkDocuments, cjkQueries, compileLucene, earlyRealmNonmatches, initialTopK, scanToCompletion, sortedUnique, targetCount, workloadDocument } from "./search-support";

test("CJK fixture oracle is explicit and normalized substring based", () => {
  expect(cjkQueries).toHaveLength(11);
  for (const query of cjkQueries) {
    const terms = query.input.toLowerCase().normalize("NFKC").split(/\s+/u);
    const expected = cjkDocuments
      .filter((doc) => terms.every((term) => doc.body.toLowerCase().normalize("NFKC").includes(term)))
      .map((doc) => doc.id);
    expect(sortedUnique(expected)).toEqual(sortedUnique(query.expected));
  }
  expect(compileLucene("中文 功能")).toBe('"中文" AND "功能"');
  expect(compileLucene('搜索" OR *')).toBe('"搜索\\"" AND "OR" AND "\\*"');
});

test("a selective Realm after initial topK cannot turn truncation into an exact empty answer", () => {
  for (const total of [10_000, 50_000]) {
    const candidates = Array.from({ length: total - earlyRealmNonmatches }, (_, i) => i + earlyRealmNonmatches + 1);
    const realm = new Set(Array.from({ length: total }, (_, i) => i + 1).filter((id) => workloadDocument(id, total).realm));
    expect(realm.size).toBe(earlyRealmNonmatches + targetCount);
    const page = budgetedFilter(candidates, realm, initialTopK, 10);
    expect(page).toEqual({ ids: [], lastScanned: earlyRealmNonmatches + initialTopK, complete: false });
    const exact = scanToCompletion(candidates, realm, 128);
    expect(exact.ids).toEqual(candidates.slice(-targetCount));
    expect(exact.scanned).toBe(total - earlyRealmNonmatches);
  }
});

test("batch boundaries preserve all candidate IDs and reject unstable continuation", () => {
  const ids = Array.from({ length: 257 }, (_, i) => i + 1);
  expect(batches(ids, 128).map((batch) => batch.length)).toEqual([128, 128, 1]);
  expect(scanToCompletion(ids, new Set([128, 129, 257]), 128).ids).toEqual([128, 129, 257]);
  expect(() => scanToCompletion([1, 2, 2, 3], new Set(), 2)).toThrow();
  expect(() => scanToCompletion([1, 3, 2], new Set(), 2)).toThrow();
});
