/** Deterministic, synthetic fixtures for search architecture qualification. */
export const cjkDocuments = [
  { id: "d1", body: "我在研究中文搜索功能", category: "science" },
  { id: "d2", body: "今天討論中文搜尋方案", category: "literature" },
  { id: "d3", body: "Rust語言中文資料", category: "science" },
  { id: "d4", body: "人工智能检索教程", category: "science" },
  { id: "d5", body: "功能说明书", category: "manual" },
  { id: "d6", body: "青龍偃月刀", category: "literature" },
  { id: "d7", body: "圖書館藏書", category: "literature" },
  { id: "d8", body: "ＲＵＳＴ全角字母", category: "science" },
  { id: "d9", body: "東京の検索エンジン", category: "science" },
  { id: "d10", body: "한국어 검색 엔진", category: "science" },
] as const;

// This is only a named fixture oracle. It does not assert linguistic relevance.
export const cjkQueries = [
  { input: "搜索", expected: ["d1"] },
  { input: "搜索功能", expected: ["d1"] },
  { input: "中文搜", expected: ["d1", "d2"] },
  { input: "搜寻", expected: [] },
  { input: "龍", expected: ["d6"] },
  { input: "功", expected: ["d1", "d5"] },
  { input: "rust", expected: ["d3", "d8"] },
  { input: "検索", expected: ["d9"] },
  { input: "검색", expected: ["d10"] },
  { input: "书", expected: ["d5"] },
  { input: "中文 功能", expected: ["d1"] },
] as const;

export const targetCount = 5;
export const earlyRealmNonmatches = 512;
export const candidateBatchSize = 128;
export const initialTopK = 100;

export function workloadDocument(id: number, total: number): { id: number; body: string; realm: boolean } {
  const target = id > total - targetCount;
  const realm = id <= earlyRealmNonmatches || target;
  const body = target
    ? `中文${"这是一段很长的补充说明文字用于降低相关度评分".repeat(8)}${id}`
    : id <= earlyRealmNonmatches ? `其他内容第${id}篇` : `中文资料第${id}篇`;
  return { id, body, realm };
}

export function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function quoteSparqlLiteral(value: string): string {
  return JSON.stringify(value);
}

export function compileLucene(input: string): string {
  return input.trim().split(/\s+/u).map((word) => `"${word.replace(/[\\+\-!():^\[\]"{}~*?|&/]/gu, "\\$&")}"`).join(" AND ");
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("batch size must be positive");
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export type CandidatePage = { ids: number[]; lastScanned: number | null; complete: boolean };

/** A result is complete only if all ordered candidates have been inspected. */
export function budgetedFilter(
  orderedCandidates: readonly number[],
  eligible: ReadonlySet<number>,
  budget: number,
  wanted: number,
): CandidatePage {
  if (!Number.isInteger(budget) || budget < 1 || !Number.isInteger(wanted) || wanted < 1) {
    throw new Error("budget and wanted must be positive");
  }
  const inspected = orderedCandidates.slice(0, budget);
  const ids = inspected.filter((id) => eligible.has(id)).slice(0, wanted);
  const complete = inspected.length === orderedCandidates.length;
  return { ids, lastScanned: inspected.at(-1) ?? null, complete };
}

/** Stable ascending ID continuation. Residual filters are applied after each bounded page. */
export function scanToCompletion(
  orderedCandidates: readonly number[],
  eligible: ReadonlySet<number>,
  pageSize: number,
): { ids: number[]; scanned: number; pages: number } {
  const unique = [...new Set(orderedCandidates)];
  if (unique.length !== orderedCandidates.length || unique.some((id, i) => i > 0 && id <= unique[i - 1])) {
    throw new Error("candidate IDs must be unique and strictly ordered");
  }
  const out: number[] = [];
  let last = 0;
  let pages = 0;
  for (const page of batches(unique, pageSize)) {
    if (page[0] <= last) throw new Error("continuation did not advance");
    out.push(...page.filter((id) => eligible.has(id)));
    last = page.at(-1)!;
    pages++;
  }
  return { ids: out, scanned: unique.length, pages };
}
