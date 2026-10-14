package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.graph.*;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.expr.NodeValue;
import org.apache.jena.sparql.function.FunctionEnvBase;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** The same three independent owners, one-slot pages and word/phrase inputs
 * at four catalogue sizes. Counters include nested native weights, not distinct
 * documents, Main submissions or elapsed-time estimates. */
public class CatalogueRankIteratorWorkTest {
    private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final String WORD = "Closuregarden", PHRASE = WORD + " Lanterns";
    private static final long NEXT_LIMIT = 128, ADVANCE_LIMIT = 512;
    private static Node p(String name) { return NodeFactory.createURI("https://rezics.com/vocab/" + name); }
    private static Node id(int n) { return NodeFactory.createURI(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", n)); }
    private static Node label() { return NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label"); }
    private record Moves(long next, long advance, long bitsets, long matches, long nanos) {}
    private record Scan(List<String> keys, List<String> units, List<Float> scores, List<Moves> work, int pages) {}

    private static RealmSearchSeekTest.Owner add(RealmSearchSeekTest.Fixture fixture, int n,
            boolean realm, String title, String body) throws Exception {
        var owner = fixture.owner(n, realm, false, body, null);
        Node name = NodeFactory.createLiteralLang(title, "fr");
        fixture.data.add(CURRENT, owner.work(), label(), name);
        fixture.data.add(CURRENT, owner.contribution(), p("author"), id(3));
        PublicNameProjection.refresh(fixture.data, owner.work());
        assertTrue("each added Work must grow the real name projection", fixture.data.contains(
            PUBLIC, PublicNameProjection.nameUnit(owner.work(), "work"), p("publicTitle"), name));
        fixture.index.refreshRankSubject(fixture.data, owner.unit().getURI());
        return owner;
    }

    private static Scan scan(RealmSearchSeekTest.Fixture fixture, String phrase, boolean realm) {
        var keys = new ArrayList<String>(); var units = new ArrayList<String>();
        var scores = new ArrayList<Float>(); var measured = new ArrayList<Moves>();
        String after = ""; int pages = 0;
        JsonObject scope = new JsonObject(); scope.put("catalogue", true);
        if (realm) scope.put("realm", id(1).getURI());
        fixture.data.begin(ReadWrite.READ);
        try {
            // Exercise the actual ARQ function -> ranked -> RankSearcher path.
            var env = new FunctionEnvBase(fixture.data.getContext(), fixture.data.getDefaultGraph(), fixture.data);
            for (;;) {
                JsonObject page;
                try (var work = new CommandWork()) {
                    long started = System.nanoTime();
                    page = JSON.parse(new FilteredGraphTextIndex.RankedFunction().exec(List.of(
                        NodeValue.makeNode(p("searchBody")), NodeValue.makeString(phrase), NodeValue.makeInteger(1),
                        NodeValue.makeString(after), NodeValue.makeString(scope.toString())), env).asString());
                    measured.add(new Moves(CommandWork.currentCount("rank_lucene_iterator_next_calls"),
                        CommandWork.currentCount("rank_lucene_iterator_advance_calls"),
                        CommandWork.currentCount("rank_lucene_iterator_bitset_calls"),
                        CommandWork.currentCount("rank_lucene_two_phase_matches"), System.nanoTime() - started));
                }
                assertFalse("an unchanged read basis must not restart", page.hasKey("restart"));
                JsonArray hits = page.get("hits").getAsArray();
                assertTrue("native page bound", hits.size() <= 1);
                for (var value : hits) {
                    var hit = value.getAsObject();
                    assertFalse("non-Work names must not consume native slots", hit.get("id").getAsString().value().startsWith(PublicNameProjection.PREFIX + "agent:"));
                    assertFalse("directories must not consume native slots", hit.get("id").getAsString().value().startsWith(PublicNameProjection.DIRECTORY));
                    if (!hit.get("key").isNull()) {
                        assertFalse("a body/name witness must not repeat its Work", keys.contains(hit.get("key").getAsString().value()));
                        keys.add(hit.get("key").getAsString().value());
                        units.add(hit.hasKey("unit") ? hit.get("unit").getAsString().value() : hit.get("id").getAsString().value());
                        scores.add(Float.parseFloat(hit.get("score").getAsString().value()));
                    }
                }
                assertTrue("native document continuation must finish", ++pages <= 16);
                if (!page.get("more").getAsBoolean().value()) break;
                assertEquals(1, hits.size());
                var cursor = hits.get(0).getAsObject(); cursor.put("commit", page.get("commit"));
                assertNotEquals("continuation must advance through suppressed body witnesses", after, cursor.toString());
                after = cursor.toString();
            }
        } finally { fixture.data.end(); }
        return new Scan(keys, units, scores, measured, pages);
    }

    @Test public void unrelatedWorkNamesCannotExpandNativeIteratorWork() throws Exception {
        var failures = new ArrayList<String>();
        for (boolean realm : List.of(false, true)) try (var fixture = new RealmSearchSeekTest.Fixture()) {
            fixture.data.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, fixture.index);
            var titleOnly = add(fixture, 10000, realm, PHRASE, "Unrelated article");
            var both = add(fixture, 10010, realm, PHRASE, PHRASE);
            var bodyOnly = add(fixture, 10020, realm, "Different title", PHRASE);
            // Matching non-Work names/directories must never consume a page.
            for (String unit : List.of(PublicNameProjection.PREFIX + "agent:control", PublicNameProjection.DIRECTORY + "control"))
                fixture.data.add(PUBLIC, NodeFactory.createURI(unit), p("publicTitle"), NodeFactory.createLiteralLang(PHRASE, "fr"));
            fixture.committed();
            var expected = List.of(titleOnly.main().getURI(), both.main().getURI(), bodyOnly.main().getURI());
            var expectedUnits = List.of(titleOnly.unit().getURI(), both.unit().getURI(), bodyOnly.unit().getURI());
            var baseline = new HashMap<String, Moves>();
            var page26 = new HashMap<String, Moves>();
            int population = 3;
            for (int size : new int[] {10, 26, 74, 200}) {
                while (population < size) {
                    fixture.data.begin(ReadWrite.WRITE);
                    add(fixture, 20000 + population * 10, realm, "Other catalogue title " + population, "Other catalogue passage");
                    fixture.committed(); population++;
                }
                // These expectations come from the fixture's owners, never
                // from another search query or its returned count.
                fixture.data.begin(ReadWrite.READ);
                try {
                    for (var owner : List.of(titleOnly, both, bodyOnly)) {
                        assertTrue(fixture.data.contains(CURRENT, owner.work(), RDF.type.asNode(), NodeFactory.createURI("https://schema.org/CreativeWork")));
                        assertTrue(fixture.data.contains(CURRENT, owner.contribution(), p("author"), id(3)));
                    }
                } finally { fixture.data.end(); }
                for (String phrase : List.of(WORD, PHRASE)) {
                    // Warm the actual function and retain the median of seven
                    // native first-page times, separate from HTTP served time.
                    scan(fixture, phrase, realm);
                    long[] times = new long[7];
                    for (int sample = 0; sample < times.length; sample++)
                        times[sample] = scan(fixture, phrase, realm).work().getFirst().nanos();
                    Arrays.sort(times);
                    System.out.printf("catalogue native first-page size=%d realm=%s query=%s medianMs=%.3f%n",
                        size, realm, phrase, times[times.length / 2] / 1_000_000d);
                    // A fixed 100 ms ceiling tolerates shared-host scheduling;
                    // iterator deltas below remain the causal growth assertion.
                    bounded(failures, "native first-page time at size " + size, times[times.length / 2], 100_000_000L);
                    var result = scan(fixture, phrase, realm);
                    assertEquals(expected, result.keys()); assertEquals(expectedUnits, result.units());
                    assertEquals(2_000_000f, result.scores().get(0), 0f);
                    assertEquals(2_000_000f, result.scores().get(1), 0f);
                    assertTrue("complete Work names outrank body hits", result.scores().get(2) < result.scores().get(1));
                    assertTrue("page one cannot exhaust this inventory", result.pages() >= 3);
                    for (int page = 0; page < result.work().size(); page++) {
                        Moves moves = result.work().get(page);
                        assertTrue("native iterator measurement must be present", moves.next() + moves.advance() > 0);
                        bounded(failures, "fixed nested next-call ceiling at size " + size, moves.next(), NEXT_LIMIT);
                        bounded(failures, "fixed nested advance-call ceiling at size " + size, moves.advance(), ADVANCE_LIMIT);
                        String control = phrase + ":" + page;
                        if (size == 10) baseline.put(control, moves);
                        if (size == 26) page26.put(control, moves);
                        Moves fixed = baseline.get(control); assertNotNull("same continuation inventory", fixed);
                        System.out.printf("catalogue rank size=%d realm=%s query=%s page=%d next=%d advance=%d bitsets=%d matches=%d%n",
                            size, realm, phrase, page, moves.next(), moves.advance(), moves.bitsets(), moves.matches());
                        // Fix the ceiling at size ten. Small allowance permits
                        // segment/lead-iterator choices; it never scales with
                        // catalogue size. The old word prefix clause exceeds it.
                        String context = "size=" + size + " realm=" + realm + " query=" + phrase + " page=" + page;
                        bounded(failures, "nested next calls " + context, moves.next(), fixed.next() + 8);
                        bounded(failures, "nested advance calls " + context, moves.advance(), fixed.advance() + 16);
                        bounded(failures, "bitset work " + context, moves.bitsets(), fixed.bitsets() + 2);
                        bounded(failures, "two-phase checks " + context, moves.matches(), fixed.matches() + 4);
                        if (size == 200) {
                            Moves at26 = page26.get(control);
                            bounded(failures, "size 200 next calls over 26 " + context, moves.next(), at26.next() + 8);
                            bounded(failures, "size 200 advance calls over 26 " + context, moves.advance(), at26.advance() + 16);
                        }
                    }
                }
            }
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }

    private static void bounded(List<String> failures, String label, long actual, long ceiling) {
        if (actual > ceiling) failures.add(label + ": " + actual + " > " + ceiling);
    }

    @Test public void matchingTitleTiesStopAtTheNativePageBound() throws Exception {
        var failures = new ArrayList<String>();
        for (boolean realm : List.of(false, true)) try (var fixture = new RealmSearchSeekTest.Fixture()) {
            RealmSearchSeekTest.Owner first = null;
            long baselineNext = 0, baselineAdvance = 0;
            int population = 0;
            for (int size : new int[] {10, 26, 74, 200}) {
                while (population < size) {
                    if (!fixture.data.isInTransaction()) fixture.data.begin(ReadWrite.WRITE);
                    var owner = add(fixture, 30000 + population * 10, realm, PHRASE, "Unrelated article");
                    if (first == null) first = owner;
                    fixture.committed(); population++;
                }
                fixture.data.begin(ReadWrite.READ);
                try (var work = new CommandWork()) {
                    var page = fixture.index.ranked(p("searchBody"), WORD, 1, null, fixture.data,
                        new FilteredGraphTextIndex.RankScope(realm ? id(1).getURI() : null, null, null, true));
                    assertEquals(1, page.hits().size()); assertTrue(page.more());
                    assertEquals(first.main().getURI(), page.hits().getFirst().key());
                    assertEquals(2_000_000f, page.hits().getFirst().score(), 0f);
                    long next = CommandWork.currentCount("rank_lucene_iterator_next_calls");
                    long advance = CommandWork.currentCount("rank_lucene_iterator_advance_calls");
                    System.out.printf("catalogue matching titles size=%d realm=%s next=%d advance=%d%n", size, realm, next, advance);
                    if (size == 10) { baselineNext = next; baselineAdvance = advance; }
                    bounded(failures, "matching-title next calls size=" + size + " realm=" + realm, next, baselineNext + 8);
                    bounded(failures, "matching-title advance calls size=" + size + " realm=" + realm, advance, baselineAdvance + 16);
                } finally { fixture.data.end(); }
            }
        }
        assertTrue(String.join("\n", failures), failures.isEmpty());
    }
}
