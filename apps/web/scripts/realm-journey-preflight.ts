/**
 * Preflight for the VN Realm catalogue-to-community walk. The walk starts only from a visual-novel Realm that the
 * Kernel at the loopback origin lists through real discovery. Discovery lists Realms with recent public discussion,
 * so an empty listing does not prove that a quiet seeded Realm is absent; the seed result is the other authority.
 */
export {};

const kernel = 'http://127.0.0.1:4100';
const visualNovel = /visual[ -]novel|\bVN\b/i;
const pagesPerSort = 10;

type DiscoveryPage = { realms: { realmId: string; name: string }[]; next: string | null };

const listed = new Map<string, string>();
for (const sort of ['popular', 'trending'] as const) {
  let cursor: string | null = null;
  for (let page = 0; page < pagesPerSort; page += 1) {
    const url = new URL('/v1/realms/discovery', kernel);
    url.searchParams.set('sort', sort);
    url.searchParams.set('limit', '20');
    if (cursor !== null) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`realm discovery ${sort} returned HTTP ${response.status}`);
    const body = (await response.json()) as DiscoveryPage;
    for (const realm of body.realms) listed.set(realm.realmId, realm.name);
    cursor = body.next;
    if (cursor === null) break;
  }
}

const candidates = [...listed].filter(([, name]) => visualNovel.test(name)).map(([realmId]) => realmId);
console.log(`discovery: ${listed.size} Realm(s) listed across popular and trending`);
if (candidates.length === 0) {
  console.error(
    'preflight: seeded VN Realm input absent: no visual-novel Realm in real discovery; the walk cannot start',
  );
  process.exit(1);
}
console.log(`preflight: visual-novel Realm candidates ${candidates.join(', ')}; the browser walk has not run`);
