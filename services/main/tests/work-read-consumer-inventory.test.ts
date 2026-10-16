import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
interface AstMatch {
  ruleId: string; file: string; text: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number } };
  metaVariables?: { single?: Record<string, { text: string }> };
}
interface DirectRead { site: string; count: number; lines: number[]; fingerprint: string }
interface OwnerRead { count: number; reason: string; fingerprint: string }

/** Each exception names one callable/receiver and its delivery owner. Counts
 * pin the reviewed call sites: adding another query still requires review. */
const ownerReads: Record<string, OwnerRead> = {
  "modules/classification/resolve.ts::resolveClassifications.query::env.fuseki": {"count": 1, "fingerprint": "b0ff4a812480efe4aa9bf34fb4080ba32968f6a1285a1c83093d69cee7151b59", "reason": "Independent matching-cut classification adapter; selected-session branch uses session.query and excludes only dataset sequence from its token."},
  "modules/discovery/source.ts::DiscoveryRefreshInputs.read::this.pool": {"count": 1, "fingerprint": "3ad75b942ab99964d5046c715ae682af4eb6b095b3b8bb4a95ece688b930911e", "reason": "Bounded retained Main relay envelopes are refresh input evidence, not response payload; source boundary validity and stream coverage gate the rebuild."},
  "modules/export/personal-evidence.ts::readPersonalRatingEvidenceBatch.flush.readBatch::session.deps.environment.fuseki": {"count": 1, "fingerprint": "c36ef186d07dbd9866f49fd797bb4dd4a10073fceefd68c8aeb338ad2d88d03c", "reason": "Private batching helper runs only inside readPersonalRatingEvidence session.selection; parent fences the delivered rating/context evidence and probe closes authority."},
  "modules/export/readers.ts::readExportPlanUnchecked::deps.env.fuseki": {"count": 1, "fingerprint": "b7af78e9ea633cc30f804d4f401113fee2d6e8852dd92642efee51b1e24ca3f1", "reason": "Composition seal selection binds an exact immutable seal and requested owner position; owner mapping only admits export authority, not a live displayed draft head."},
  "modules/feed/target-index.ts::FeedTargetIndex.project::client": {"count": 6, "fingerprint": "306a2fd257b701109c2d84bc7c6a1b912892191613fb52f8d464a9e5e5698ded", "reason": "Projection transaction replaces exact reference target keys and checkpoint revision together; reader delivery uses maintained membership and its own frame close."},
  "modules/feed/target-index.ts::FeedTargetIndex.tick::client": {"count": 2, "fingerprint": "7a3ae9054691eb582ceccb0a453e61e8ad446429be7594279125ae7eef0958c9", "reason": "Projection transaction dirties selected changed Works and advances the retained Main relay cursor atomically; these are worker inputs and writes, not hydrated cards."},
  "modules/feed/target-index.ts::FeedTargetIndex.tick::this.access": {"count": 6, "fingerprint": "435f9792aed3cccfc8735cca92b88bcad9a740e6fc8a8d9b165c9ac412a3af96", "reason": "Bounded pending references and author-dirty keys drive the target projector; project publishes its target index revision atomically before readers use it."},
  "modules/feed/target-index.ts::FeedTargetIndex.tick::this.relay": {"count": 1, "fingerprint": "8ddf4f8df7bbf09c56347ae5428b6722f18872dcf7c0aa47a1f8173c11b534bd", "reason": "Immutable delivered Main stream events are projector input; exact stream/epoch/sequence cursor controls the worker rather than shown-unit response delivery."},
  "modules/identity-merge/resolution.ts::readMergedIdentity::env.fuseki": {"count": 1, "fingerprint": "934b30405dc2205c8da921ef458bd9e8f2f0d08014a5abc322155a9c5a83aa44", "reason": "Independent redirect adapter opens a matching graph cut only when no selected session or requested position exists; selected history supplies its session position and uses edge row witnesses."},
  "modules/identity-merge/resolution.ts::redirectOf::env.fuseki": {"count": 1, "fingerprint": "3db239a801e0d9bd1718d49c688036fd678dadd5c2eee90deff1d6d141c84151", "reason": "Independent matching-cut redirect fallback; selected session branch registers each visited edge via session.query, removing only dataset diagnostic sequence from tokens."},
  "modules/library-export/bundle.ts::LibraryBundleExporter.fence::this.access": {"count": 1, "fingerprint": "d087e0e74620b0810ba3c84f1597798acce9f21b6473785a031b5db8c2faec2c", "reason": "LibraryBundleExporter.page compares the principal's maintained library_rating_version before and after every archive page; mutations of either rating-head inventory advance this owner version."},
  "modules/library-export/bundle.ts::LibraryBundleExporter.fence::this.content": {"count": 1, "fingerprint": "d6e4238a8b6af810b4a72c64b976d6b1936270d9e92c88757680cac3d24ac9a9", "reason": "LibraryBundleExporter.page closes its own Content epoch/version/expiry owner fence before returning selected archive rows and retaining its snapshot cursor."},
  "modules/library-export/bundle.ts::LibraryBundleExporter.phase::this.access": {"count": 2, "fingerprint": "3853b8acd04105517230b28286753253feade60cdbfff1d1b70e3084d017cfb8", "reason": "Selected reader rating/evidence pages use indexed context/target tuple seeks and are enclosed by LibraryBundleExporter.page opening/closing principal rating version and reader authority checks; graph evidence uses the session owner."},
  "modules/library-export/bundle.ts::LibraryBundleExporter.phase::this.content": {"count": 6, "fingerprint": "68497a3b1a6229479ad56e258b126a7e6a307f6782ca32ebd5b316f3caddfe47", "reason": "Bounded private archive phase rows are enclosed by LibraryBundleExporter.page Content owner fence, including expiry; changed selected reader records invalidate the archive snapshot."},
  "modules/notification-producers/feed-subjects.ts::feedNotificationSubjectReader.eligible::access": {"count": 1, "fingerprint": "742c955d332db4a32687acbf5ab1f936b36fdf3d29fa224659c37a09469d2f48", "reason": "Dispatcher resolve repeats the exact recipient relationship/vote-author eligibility after reading the selected subject; no durable event grants delivery authority."},
  "modules/notification-producers/feed-subjects.ts::feedNotificationSubjectReader.resolve::access": {"count": 2, "fingerprint": "79ca686b2b92bab423af2f326d1281df9edfb5d5db8bbe78342dcd2f6ed88b66", "reason": "Exact immutable notification event custody identifies the author; resolve repeats current source identity and recipient eligibility before delivering any fields."},
  "modules/notification-producers/feed-subjects.ts::feedNotificationSubjectReader.source.query::env.fuseki": {"count": 1, "fingerprint": "ac911aea40bf79a69efff8136ac0a8ed9c06bd7398275f63eeb3b29280650202", "reason": "Independent notification adapter bounds one subject and checks restore admission; resolve owns its selected two-read source token plus closing recipient relationship."},
  "modules/notification-producers/feed-subjects.ts::feedNotificationSubjectReader.source::access": {"count": 1, "fingerprint": "05bf935184a0318b564a29aad4516cc9dc1f1405cb813072f29352b057b0dc60", "reason": "Exact review identity selects one subject adapter; resolve reads source twice and compares selected author/content/Work/occurrence before dispatcher delivery."},
  "modules/notification-producers/saved-views.ts::SavedViewNotifications.run::client": {"count": 12, "fingerprint": "0d6477ba11637a3e75b2349a0add19035e491aa13b606896650e767daf5b9ba4", "reason": "Worker recipient seek/progress transaction creates notification work, not delivered payload; dispatcher resolution rechecks saved-view and subject owners separately."},
  "modules/public-report/owners.ts::authorAndRealm::content": {"count": 2, "fingerprint": "6285bfdf782044a5dbcd805853ff20d89fd4e45f6c7d480b4a2be5545cb76ee8", "reason": "media.asset.owner and content.reply_author author/origin are immutable custody tuples; Content core rejects changed reply authorship/origin, while graph attribution uses session.query."},
  "modules/public-report/owners.ts::publicReportOwners.resolve::contentPool": {"count": 1, "fingerprint": "6474fbb6ea74057c081ff02f689c50ec1432df8b97776c058f5e39b7b817666d", "reason": "Exact media.use ID maps to its immutable asset revision; this lookup only translates the cover selection. capture.admitted with requireServedAvatar rechecks the selected cover's live availability and authority before evidence delivery."},
  "modules/public-report/owners.ts::reportOwnerTargets.readMedia::content": {"count": 1, "fingerprint": "408131b52322214d9e46df4c70f7b6369a401ca3e0866c5b19b9287ad0807bd4", "reason": "Bounded selected media IDs and exact draft heads are registered as report-media-targets; closing owner reread repeats live lifecycle, disclosure and revision availability predicates before report delivery."},
  "modules/query/template-read.ts::executeTemplate.operation::index.pool": {"count": 1, "fingerprint": "951bc44ae44efa43b123bc7d11b0de962444838ed481f45daf40ba62ae6a25aa", "reason": "Exact accepted term revisions plus active discovery generation are registered as template-membership and reread before the selected template page returns."},
  "modules/rankings/realm-threads.ts::RealmThreadRankingProjection.projectPopulation::client": {"count": 6, "fingerprint": "e4ed20416ca82e5a421a07af0a591efe14936c178b1830c8db74b8f4ccc088c3", "reason": "Bounded population rebuild locks exact reference rows and copies their concept-aware order into private populations while advancing readiness and revision atomically; it does not deliver response payload."},
  "modules/rankings/realm-threads.ts::RealmThreadRankingProjection.projectPopulation::this.access": {"count": 3, "fingerprint": "50983bfb25d6e218f8f9ac1ce5fe4355ffdf9eeb92d970766b4d0f559c46243a", "reason": "Worker pending population jobs and checkpoints drive bounded rebuilds; projectPopulation publishes the population revision used by independently fenced reader pages."},
  "modules/rankings/realm-threads.ts::RealmThreadRankingProjection.tick::client": {"count": 4, "fingerprint": "16c652ab11901693f3e85b3df870c39a2923c0749f5db819a1fce6a15fa81ce3", "reason": "Worker dirtiness/checkpoint transaction advances only acknowledged owner events; reader delivery depends on the maintained population revision and live disclosure close."},
  "modules/rankings/realm-threads.ts::RealmThreadRankingProjection.tick::this.access": {"count": 10, "fingerprint": "232f96c7358b1fb6b7bdac60a132312f1300182b9af73c8e0a6fddae195f07f0", "reason": "Bounded worker jobs, delta references and exact legacy keys lacking board classification drive rebuilds; project publishes the ranking cut and readers close its selected revision."},
  "modules/rankings/realm-threads.ts::RealmThreadRankingProjection.tick::this.relay": {"count": 1, "fingerprint": "854c2a8c09a5ed0b07f44540184739bd289eaf6ba0feb615405cb82dbf016c4c", "reason": "Immutable Main relay envelopes bounded by stream epoch/checkpoint feed only the ranking projector; successful board vocabulary changes are non-removals. realm-ranking-scoped-admission.test.ts board vocabulary replay witnesses preserved cuts and fail-closed outcomes; reader delivery separately closes the ranking revision."},
  "modules/rankings/realm-threads.ts::contentPosition::session.deps.realmReplyThreads!.rankingContent": {"count": 1, "fingerprint": "51e4183bf346e72e5da0b8064edbbb20a9a8e22156297711df740d126cb70ccf", "reason": "Content owner position supplies ranking projection readiness; realmRankPage uses coherent population cut, and thread-read closes selected ranking revision before delivery."},
  "modules/rankings/realm-threads.ts::realmRankPage::access": {"count": 1, "fingerprint": "f7afcb96682c9d0d20d4f4e260c92beff914fc34652e1d1ed866e57bf04a4fba", "reason": "Unfiltered rank-cut SQL returns readiness, selected rows and revision atomically; thread-read selectedOwnerRead registers ranked-page and repeats this owner read before delivery."},
  "modules/rankings/realm-threads.ts::realmRankPage::client": {"count": 2, "fingerprint": "2219b1057acf4ecf4a9b1990b93b78373a1763b2effc4ca285b6f3a5fe044c10", "reason": "Concept-filtered rank cut applies local seek planner settings and returns coherent readiness, selected rows and revision on the control read transaction; thread-read selectedOwnerRead registers ranked-page including concept and repeats the owner read before delivery."},
  "modules/rankings/retirement.ts::retireRealmPopulation::client": {"count": 8, "fingerprint": "21c44d87184d375646d9595406afa33747df423d18bc579a021753597c4cea4e", "reason": "Retirement is an owner transaction with exact population CAS and locked readiness; it changes the published ranking revision rather than delivering any card payload."},
  "modules/reading-position/boundary.ts::readReadingComposition::session.deps.environment.fuseki": {"count": 1, "fingerprint": "dc3f2ccae035632fdcf92b28bca33f86e129d6f24c8548b067a1fd30b948750b", "reason": "Diagnostic whole-composition conformance inventory only: callers are community-read-guards.test.ts and integration g-847; product reads use exact ReadingBoundary locations, not this inventory."},
  "modules/reading-position/read.ts::readingPositionRead.position::deps.environment.fuseki": {"count": 1, "fingerprint": "489107f1b0c6a543f1146e2fd99ce6839caae3df86e956ae8a4bc66be07cda24", "reason": "Independent reading envelope checks epoch/routing/restore hold at opening and closing; boundedReadingPositionRead retries admission and closes selected session dependencies/authority."},
  "modules/realm-directory/index.ts::RealmDirectoryIndex.page::client": {"count": 9, "fingerprint": "e978087ee3e52f9566bf49766ed6e43754564b09fa8fe379bea351b08af3102c", "reason": "Published SQL directory page is one repeatable-read snapshot, including the current UTC growth-day readiness check; callers realm-directory/read and query/resources close the directory/count membership owner via index.fence."},
  "modules/realm-directory/index.ts::RealmDirectoryIndex.refresh::client": {"count": 14, "fingerprint": "89c8e6abc2eba0dc4247078242dfe41a7a9480ba5b484c0341614862df44a5af", "reason": "Worker rebuild copies rows into the inactive generation, bounds stale growth-row deletion, and atomically publishes its position; raw transaction rows do not form a reader's displayed dependency inventory."},
  "modules/realm-directory/index.ts::RealmDirectoryIndex.refresh::this.pool": {"count": 2, "fingerprint": "95af47c0f73145d805ecffa93faa23a040dc862a685514f20fb8c369ec06e80c", "reason": "Worker recovery/prior-generation CAS controls directory rebuild admission; the published directory owner is fenced separately by each page consumer."},
  "modules/realm-reply/thread-store.ts::RealmReplyThreadStore.assertThreadProjection::this.access": {"count": 1, "fingerprint": "cd4a5ebbf6e11887e504e3f3a825041170ad6d83ea972cf0083b84f4664b9ce1", "reason": "Exact selected thread keys close the bounded page and ancestor window; maintained Main/Content checkpoint and recovery gate admission, not a generic dataset head token."},
  "modules/realm-reply/thread-store.ts::RealmReplyThreadStore.assertThreadProjection::this.content": {"count": 1, "fingerprint": "90693c2c8a6dec66cdad864951c6e60e7507b3eb743a16ca39baec43256b160c", "reason": "Content owner readiness supplies the exact thread projection coverage assertion; selected reply pages separately close current content/graph owners and ranking revision."},
  "modules/recipe/work-page.ts::readRecipeWorkPage.readType::session.deps.environment.fuseki": {"count": 1, "fingerprint": "a28c42c5f4860f18b87e8926bf1be67f8e1a0ad8474884c96f8cfe588d79aeb2", "reason": "Boolean Recipe type ASK is registered as recipe-type and reread by the selected session before returning the page; raw ASK result has a dedicated owner witness."},
  "modules/search/typeahead.ts::queryTypeaheadCandidates.query::env.fuseki": {"count": 1, "fingerprint": "b0ff4a812480efe4aa9bf34fb4080ba32968f6a1285a1c83093d69cee7151b59", "reason": "Independent matching-cut fallback only; ordinary selected calls take the session.query branch, while search snapshot/cursor owners retain matching-cut admission."},
  "modules/statement/read.ts::readPublicStatementsAt::env.fuseki": {"count": 1, "fingerprint": "f6b5af41988d6673851d6b97c4ed22091358098c29e53689669b009bf245616a", "reason": "Independent exact-cut Statement adapter only; selected public Statement reads take session.query with diagnostic dataset sequence removed from the selected token."},
  "modules/target/resolve.ts::targetRead.query::environment.fuseki": {"count": 1, "fingerprint": "cfdc566d6982d5599257ce65bf5bac19fd71627003f42035ff93f109078eee21", "reason": "Independent TargetReadSession adapter owns bounded graph envelope opening/closing checks and preserves each caller's byte ceiling; product WorkReadSession callers use resourceTargetReader or bridge selected result witnesses."},
  "modules/wiki/history-read.ts::readWikiHistoryUnchecked::work.environment.fuseki": {"count": 1, "fingerprint": "24692ff24595d8a1e23d47f34d926ab1e55fa63f1c6fa9daab233367af640218", "reason": "Private history helper runs inside readWikiHistory session.selection; its delivered exact pin/erasure/rights/evidence and merged identity results are reread and probe authority closes before delivery."},
  "modules/work/read-session.ts::WorkReadSession.fenceDependencies::this": {"count": 1, "fingerprint": "3d397f99efe23d55e61b638da6d474a427f4c7fd52502bfb975812ff7e11c829", "reason": "The session rereads registered row tokens with their original byte ceilings and shared HTTP budget."},
  "modules/work/read-session.ts::WorkReadSession.query::graph": {"count": 1, "fingerprint": "19b7918bb3cd036192fc86e5be9378c0fad8e7989f431694f2500eeda8c8fc59", "reason": "Canonical bounded graph adapter runs graph.query through fencedGraphQuery, records selected row tokens, preserves the caller's byte ceiling and charges the shared attempt budget; delivery rereads registered dependencies."},
  "modules/work/search-facets.ts::phraseWorkTypes::env.fuseki": {"count": 1, "fingerprint": "f0cc4e624a0b3b8394ae3e889c2183f094e31c9f2019411026f7d26e0a0c5637", "reason": "Independent matching-cut search facet adapter only; selected-session branch uses session.query, so selected types are closed before response delivery."},
  "modules/work/search-supports.ts::readSearchDecisionSupports::env.fuseki": {"count": 1, "fingerprint": "f6b5af41988d6673851d6b97c4ed22091358098c29e53689669b009bf245616a", "reason": "Independent exact-cut search decision support adapter only; selected-session branch registers support rows through session.query and projects only global diagnostic sequence."},
  "modules/zone/route.ts::RouteRead.ask.read::this.work.environment.fuseki": {"count": 1, "fingerprint": "304d8200cf188bcbfb3ea40f57dd5a8003df457a88c7b9603e1c594b672a4b2e", "reason": "Selected Zone population ASK is registered as zone-population on scopeSession and reread before the Zone route owner closes delivery."},
  "modules/zone/route.ts::RouteRead.zone::this": {"count": 1, "fingerprint": "19edd7d28ed2b55d38936c6aa46061d5be9bf48a1cd872ffc0da4d5fdde9f341", "reason": "RouteRead.query delegates to scopeSession.query at the original policy ceiling, captures selected public Zone Space disclosure rows and closes their dependency fence before route delivery."},
  "modules/zone/route.ts::indexItems::read": {"count": 1, "fingerprint": "795fa135444f4fad303e2f4fe301722fe3ebb8839245681998761b575283ae61", "reason": "RouteRead.query observes selected rows through scopeSession at the original Work-type batch ceiling; the Zone owner closes all card sessions, its selected dependency fence and authority before route delivery."},
  "routes/studio.ts::studioRoutes::work.environment.fuseki": {"count": 1, "fingerprint": "0eec01538c04028f9af5b84571f459a5a66f0f5d3e2ad5a8d74e0b65707bf618", "reason": "Chapter creation write preflight selects the Book composition for changeAdmittedComposition; the mutation owner checks expectedCompositionHead and performs admission CAS, not read-response delivery."},
};

const receiverOf = (query: AstMatch) => query.metaVariables?.single?.RECEIVER?.text
  ?? query.text.match(/^(?:await\s+)?([\w$.!]+(?:\s*\.\s*[\w$!]+)*)\s*\.query\s*(?:<|\()/)?.[1]?.replace(/\s+/g, '') ?? '';
const sessionReceiver = (receiver: string) => /(?:^|\.)(?:session|[\w$]*Session|probe)!?$/.test(receiver);

function symbol(node: AstMatch, source: Buffer): string | undefined {
  const named = node.text.match(/^\s*(?:(?:async|private|public|protected|static|override|get|set|export)\s+)*(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/)?.[1];
  if (named && named !== 'async') return named;
  if (/^\s*(?:export\s+)?class\s/.test(node.text)) return node.text.match(/\bclass\s+([\w$]+)/)?.[1];
  const before = source.subarray(Math.max(0, node.range.byteOffset.start - 400), node.range.byteOffset.start).toString();
  return before.match(/(?:\b(?:const|let|var)\s+)([\w$]+)(?:\s*:[^;=]+)?\s*=\s*(?:<[^>]+>\s*)?$/)?.[1]
    ?? before.match(/([\w$]+)\s*:\s*$/)?.[1];
}

function inventory(matches: readonly AstMatch[], sources: ReadonlyMap<string, Buffer>): DirectRead[] {
  const functions = matches.filter(match => match.ruleId === 'read-functions');
  const queries = matches.filter(match => match.ruleId === 'query-calls');
  const entries = new Map<string, DirectRead>();
  const reviewed = new Map<string, string[]>();
  for (const query of queries) {
    const receiver = receiverOf(query);
    // Inventory every non-session receiver, so aliasing a graph/pool as `db`
    // cannot bypass the guard. Session query itself registers selected rows.
    if (sessionReceiver(receiver)) continue;
    const parents = functions.filter(fn => fn.file === query.file
      && fn.range.byteOffset.start <= query.range.byteOffset.start
      && fn.range.byteOffset.end >= query.range.byteOffset.end);
    const scoped = parents.some(fn => (!/^\s*(?:export\s+)?class\s/.test(fn.text)
      || symbol(fn, sources.get(fn.file)!) === 'WorkReadSession') && (/\b(?:WorkReadSession|TargetReadSession)\b/.test(fn.text)
      || /\b(?:session|[\w$]*Session|probe)\s*\.\s*(?:observeDependency|selection|fenceDependencies|fenceAuthority)\s*\(/.test(fn.text)
      || queries.some(call => call.file === fn.file && call.range.byteOffset.start >= fn.range.byteOffset.start
        && call.range.byteOffset.end <= fn.range.byteOffset.end
        && sessionReceiver(receiverOf(call)))));
    if (!scoped) continue;
    const source = sources.get(query.file)!;
    const names = parents.sort((a, b) => b.range.byteOffset.end - b.range.byteOffset.start
      - (a.range.byteOffset.end - a.range.byteOffset.start)).flatMap(fn => symbol(fn, source) ?? []);
    const site = `${query.file.replace('services/main/src/', '')}::${names.join('.') || '<anonymous>'}::${receiver}`;
    const held = entries.get(site) ?? { site, count: 0, lines: [], fingerprint: '' };
    held.count++; held.lines.push(query.range.start.line + 1); entries.set(site, held);
    reviewed.set(site, [...reviewed.get(site) ?? [], query.text.replace(/\s+/g, ' ')]);
  }
  for (const [site, entry] of entries) entry.fingerprint = createHash('sha256')
    .update(JSON.stringify(reviewed.get(site))).digest('hex');
  return [...entries.values()].sort((a, b) => a.site.localeCompare(b.site));
}

function scan(path = 'services/main/src'): DirectRead[] {
  const rules = [
    { id: 'query-calls', language: 'TypeScript', severity: 'info', rule: {
      kind: 'call_expression', regex: '^(?:await\\s+)?[A-Za-z_$][\\w$.!]*(?:\\s*\\.\\s*[\\w$!]+)*\\s*\\.query\\s*(?:<|\\()',
    } },
    { id: 'read-functions', language: 'TypeScript', severity: 'info', rule: { any: [
      { kind: 'function_declaration' }, { kind: 'function_expression' }, { kind: 'arrow_function' },
      { kind: 'method_definition' }, { kind: 'class_declaration' },
    ] } },
  ].map(rule => JSON.stringify(rule)).join('\n---\n');
  const scanned = Bun.spawnSync(['task', 'ast-grep', '--', 'scan', '--inline-rules', rules,
    '--json=stream', path], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  if (scanned.exitCode !== 0) throw new Error(`Read inventory AST scan failed: ${scanned.stderr.toString()}`);
  const matches = scanned.stdout.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as AstMatch);
  const sources = new Map([...new Set(matches.map(match => match.file))]
    .map(file => [file, readFileSync(resolve(root, file))] as const));
  return inventory(matches, sources);
}

if (process.argv.includes('--inventory')) {
  // Read-only inventory discovery, without invoking the test runner.
  for (const read of scan()) console.info(JSON.stringify(read));
} else {
  test('resource summary and preview routes hydrate through the session that closes their delivery', () => {
    const source = readFileSync(resolve(root, 'services/main/src/routes/resources.ts'), 'utf8');
    expect(source).not.toMatch(/\breadResourceSummaries\s*\(/);
    expect(source).toContain('session.summaryBatch(');
  });
  test('every session consumer routes direct graph and SQL reads through a named delivery owner', () => {
    const actual = scan();
    const uncovered = actual.filter(read => ownerReads[read.site]?.count !== read.count
      || ownerReads[read.site]?.fingerprint !== read.fingerprint);
    expect(uncovered, JSON.stringify(uncovered.map(read => ({ ...read,
      blocker: 'New direct read needs a selected owner witness or an exact immutable/independent-owner reason',
    })), null, 2)).toEqual([]);
    expect(Object.keys(ownerReads).filter(site => !actual.some(read => read.site === site))).toEqual([]);
    for (const owner of Object.values(ownerReads)) expect(owner.reason.length).toBeGreaterThan(30);
  });
  test('session inventory includes generic SQL and aliases, excludes comments and unrelated callables', () => {
    mkdirSync(resolve(root, '.temp'), { recursive: true });
    const directory = mkdtempSync(resolve(root, '.temp/read-consumer-inventory-'));
    try {
      const file = join(directory, 'fixture.ts');
      writeFileSync(file, `
        async function typed(session: WorkReadSession) { await db.query<{ value: string }>('selected'); }
        async function consumer(session: OtherType) { await session.query('selected'); await renamed.query('unguarded'); }
        async function unrelated() { await pool.query('outside read scope'); }
        // async function comment(session: WorkReadSession) { env.fuseki.query('fake'); }
        const text = "session.query('fake'); pool.query('fake')";
      `);
      const found = scan(file);
      expect(found.map(read => read.site.split('::').slice(1).join('::'))).toEqual(['consumer::renamed', 'typed::db']);
      expect(found.map(read => read.count)).toEqual([1, 1]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
