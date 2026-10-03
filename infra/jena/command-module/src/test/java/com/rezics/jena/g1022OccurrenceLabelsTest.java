package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class g1022OccurrenceLabelsTest {
    static Node id(int value) { return OccurrenceLabelIndex.uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    static Node p(String value) { return OccurrenceLabelIndex.p(value); }
    static Node text(String value) { return NodeFactory.createLiteralString(value); }
    static final Node CURRENT = OccurrenceLabelIndex.uri(CommandPolicy.CURRENT), GENERATION = id(1), STRUCTURE = id(2), GROUP = id(3);
    private static final class Measured extends DatasetGraphWrapper implements DatasetGraphWrapperView {
        long quads;
        Measured(DatasetGraph source) { super(source); }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            return org.apache.jena.atlas.iterator.Iter.map(super.find(graph, subject, predicate, object), quad -> { quads++; return quad; });
        }
        @Override public Iterator<Quad> findNG(Node graph, Node subject, Node predicate, Node object) {
            return org.apache.jena.atlas.iterator.Iter.map(super.findNG(graph, subject, predicate, object), quad -> { quads++; return quad; });
        }
        @Override public org.apache.jena.graph.Graph getGraph(Node graph) {
            return new org.apache.jena.sparql.graph.GraphWrapper(super.getGraph(graph)) {
                @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(org.apache.jena.graph.Triple pattern) {
                    return super.find(pattern).mapWith(triple -> { quads++; return triple; });
                }
                @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(Node subject, Node predicate, Node object) {
                    return super.find(subject, predicate, object).mapWith(triple -> { quads++; return triple; });
                }
            };
        }
    }
    static void fixture(DatasetGraph data, int count) {
        data.add(CURRENT, STRUCTURE, p("structureProfile"), p("BookComposition"));
        data.add(CURRENT, GENERATION, RDF.type.asNode(), p("StructureGeneration"));
        data.add(CURRENT, GENERATION, p("structure"), STRUCTURE);
        data.add(CURRENT, GENERATION, p("placementCount"), text(Integer.toString(count)));
    }
    static Node placement(DatasetGraph data, int index, String label, String language) {
        Node placement = id(10_000 + index), segment = id(30_000 + index);
        data.add(CURRENT, segment, p("parent"), STRUCTURE);
        data.add(CURRENT, segment, p("segmentKey"), text(String.format("%08d", index)));
        data.add(CURRENT, placement, RDF.type.asNode(), p("OccurrencePlacement"));
        data.add(CURRENT, placement, p("generation"), GENERATION);
        data.add(CURRENT, placement, p("occurrence"), id(50_000 + index));
        data.add(CURRENT, placement, p("orderSegment"), segment);
        data.add(CURRENT, placement, p("orderKey"), text("a"));
        data.add(CURRENT, placement, p("occurrenceRole"), p("ChapterRole"));
        data.add(CURRENT, placement, p("occurrenceLabel"), NodeFactory.createLiteralLang(label, language));
        return placement;
    }
    static void index(DatasetGraph data, Node... placements) {
        OccurrenceLabelIndex.refreshPlacements(data, List.of(placements), new LinkedHashSet<>(Set.of(GENERATION)));
    }
    static List<String> found(DatasetGraph data, Node parent, String query) {
        List<String> result = new ArrayList<>();
        for (var item : OccurrenceLabelIndex.search(data, GENERATION, parent, query, "", 101).get("items").getAsArray())
            result.add(item.getAsObject().get("occurrence").getAsString().value());
        return result;
    }
    @Test public void foldsEveryCarriedLanguageAndDisplayNumberWithoutChangingOriginals() {
        var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            fixture(data, 3);
            Node first = placement(data, 0, "魔法禁書目錄", "yue"), second = placement(data, 1, "ｶﾞﾗｽ ＲＵＳＴ", "ja"), third = placement(data, 2, "Cafe\u0301", "fr");
            Node qualifier = id(90_000);
            data.add(CURRENT, first, p("qualifier"), qualifier);
            data.add(CURRENT, qualifier, p("displayLabel"), text("第十二卷"));
            data.add(CURRENT, qualifier, p("number"), text("１２"));
            index(data, first, second, third);
            assertEquals(List.of(id(50_000).getURI()), found(data, STRUCTURE, "禁书目录"));
            assertEquals(List.of(id(50_001).getURI()), found(data, STRUCTURE, "がらす"));
            assertEquals(List.of(id(50_001).getURI()), found(data, STRUCTURE, "Rust"));
            assertEquals(List.of(id(50_002).getURI()), found(data, STRUCTURE, "CAFÉ"));
            assertEquals(List.of(id(50_000).getURI()), found(data, STRUCTURE, "十二"));
            assertEquals(List.of(id(50_000).getURI()), found(data, STRUCTURE, "12"));
            assertTrue(data.contains(CURRENT, first, p("occurrenceLabel"), NodeFactory.createLiteralLang("魔法禁書目錄", "yue")));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void renameMoveRemoveAndAbortedWriteRetainExactTransactionalCoverage() {
        var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        Node first;
        try { fixture(data, 2); first = placement(data, 0, "old label", "en"); Node second = placement(data, 1, "other", "en"); index(data, first, second); data.commit(); }
        finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            data.deleteAny(CURRENT, first, p("occurrenceLabel"), Node.ANY);
            data.add(CURRENT, first, p("occurrenceLabel"), NodeFactory.createLiteralLang("new label", "en"));
            data.deleteAny(CURRENT, id(30_000), p("parent"), Node.ANY); data.add(CURRENT, id(30_000), p("parent"), GROUP);
            index(data, first);
            assertEquals(List.of(), found(data, STRUCTURE, "old"));
            assertEquals(List.of(id(50_000).getURI()), found(data, GROUP, "new"));
            data.abort();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            assertEquals(List.of(id(50_000).getURI()), found(data, STRUCTURE, "old"));
            data.add(CURRENT, first, p("removedBy"), id(99_999));
            data.deleteAny(CURRENT, GENERATION, p("placementCount"), Node.ANY); data.add(CURRENT, GENERATION, p("placementCount"), text("1"));
            index(data, first);
            assertEquals(List.of(), found(data, STRUCTURE, "old"));
            assertEquals(List.of(id(50_001).getURI()), found(data, STRUCTURE, "other"));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void partialBackfillFailsClosedAndRecoversFromDurableDescriptors() {
        var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        Node first, second;
        try {
            fixture(data, 2); first = placement(data, 0, "shared", "en"); second = placement(data, 1, "shared", "en");
            index(data, first);
            assertThrows(IllegalStateException.class, () -> found(data, STRUCTURE, "shared"));
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.WRITE);
        try {
            index(data, first, second); // repeated first descriptor must not inflate coverage
            assertEquals(List.of(id(50_000).getURI(), id(50_001).getURI()), found(data, STRUCTURE, "shared"));
            data.commit();
        } finally { data.end(); }
        data.begin(ReadWrite.READ);
        try { assertEquals(2, found(data, STRUCTURE, "shared").size()); }
        finally { data.end(); data.close(); }
    }
    @Test public void nativeMonitorTracksQualifierAndSegmentWritesAndActivationCannotExposePartialBuild() {
        var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
        try {
            fixture(data, 1); Node placement = placement(data, 0, "chapter", "en"), qualifier = id(90_000);
            data.add(CURRENT, placement, p("qualifier"), qualifier); data.add(CURRENT, qualifier, p("displayLabel"), text("Old"));
            index(data, placement);
            var capture = new OccurrenceLabelIndex.Capture(data);
            org.apache.jena.update.UpdateAction.parseExecute("PREFIX rv: <https://rezics.com/vocab/> DELETE { GRAPH <" + CommandPolicy.CURRENT + "> {"
                + " <" + qualifier.getURI() + "> rv:displayLabel \"Old\" . <" + id(30_000).getURI() + "> rv:parent <" + STRUCTURE.getURI() + "> } }"
                + " INSERT { GRAPH <" + CommandPolicy.CURRENT + "> { <" + qualifier.getURI() + "> rv:displayLabel \"New\" ."
                + " <" + id(30_000).getURI() + "> rv:parent <" + GROUP.getURI() + "> } } WHERE {}", DatasetFactory.wrap(capture.observed(data)));
            capture.refresh("urn:ordinary");
            assertEquals(List.of(), found(data, STRUCTURE, "old"));
            assertEquals(List.of(id(50_000).getURI()), found(data, GROUP, "new"));
            data.deleteAny(OccurrenceLabelIndex.STATE, GENERATION, p("indexedCount"), Node.ANY);
            data.add(OccurrenceLabelIndex.STATE, GENERATION, p("indexedCount"), text("0"));
            var activation = new OccurrenceLabelIndex.Capture(data); activation.selected.add(GENERATION);
            assertThrows(IllegalStateException.class, () -> activation.refresh("urn:activation"));
        } finally { data.abort(); data.end(); data.close(); }
    }
    @Test public void maintenancePolicyAcceptsOnlyDerivedOccurrenceRequestsWithoutProductWrites() {
        String receipt = "urn:rezics:receipt:chapter-search-index:" + "c".repeat(64);
        String update = "PREFIX rv: <https://rezics.com/vocab/> DELETE { GRAPH <" + CommandPolicy.CONTROL
            + "> { <urn:rezics:dataset:product> rv:sequence ?n } } INSERT { GRAPH <" + CommandPolicy.CONTROL
            + "> { <urn:rezics:dataset:product> rv:sequence ?next } GRAPH <" + CommandPolicy.RECEIPTS
            + "> { <" + receipt + "> rv:occurrenceSearchPlacement <" + id(10_000).getURI() + "> } GRAPH <"
            + CommandPolicy.OUTBOX + "> { <urn:test:batch> a rv:OutboxBatch } } WHERE {}";
        CommandPolicy.parse(update, receipt);
        assertThrows(IllegalArgumentException.class, () -> CommandPolicy.parse(update.replace("rv:sequence ?next", "rv:hold ?next"), receipt));
    }
    @Test public void readerWorkScopeNeverWalksChapterPlacementsToDiscoverBookLeaves() throws Exception {
        String where;
        try (var stream = getClass().getResourceAsStream("/g1022-reading-scope.json")) {
            where = org.apache.jena.atlas.json.JSON.parse(new String(stream.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
                .get("where").getAsString().value();
        }
        String edge = "rv:mainVersion/^rv:structureOf/rv:selectedGeneration/^rv:generation/rv:composedWork";
        for (int count : new int[]{100, 1000, 10000}) {
            var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
            try {
                fixture(data, count);
                data.add(CURRENT, id(6), p("mainVersion"), id(7));
                data.add(CURRENT, STRUCTURE, p("structureOf"), id(7));
                data.add(CURRENT, STRUCTURE, p("selectedGeneration"), GENERATION);
                data.add(CURRENT, GENERATION, p("generationState"), p("Active"));
                for (int at = 0; at < count; at++) placement(data, at, "chapter", "en");
                Measured before = new Measured(data), after = new Measured(data);
                for (String expression : List.of("<" + id(6).getURI() + "> (" + edge + ")* ?work", where)) {
                    Measured source = expression.equals(where) ? after : before;
                    try (var query = QueryExecution.create("PREFIX rv: <https://rezics.com/vocab/> SELECT DISTINCT ?work WHERE { GRAPH <"
                        + CommandPolicy.CURRENT + "> { " + expression + " } }", DatasetFactory.wrap(source))) {
                        var rows = query.execSelect(); assertTrue(rows.hasNext()); assertEquals(id(6).getURI(), rows.next().getResource("work").getURI());
                        assertFalse(rows.hasNext());
                    }
                }
                assertTrue(before.quads >= count); assertTrue("work scope quads=" + after.quads, after.quads <= 64);
                System.out.println("G1022 work scope " + count + " beforeQuads=" + before.quads + " afterQuads=" + after.quads);
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
    @Test public void sparseCommonAbsentAndContinuationSearchCostIsBoundedAtEveryScale() {
        for (int count : new int[]{100, 1000, 10000}) {
            var data = DatasetGraphFactory.createTxnMem(); data.begin(ReadWrite.WRITE);
            try {
                fixture(data, count);
                long build = System.nanoTime();
                for (int at = 0; at < count; at += 30) {
                    List<Node> placements = new ArrayList<>();
                    for (int index = at; index < Math.min(count, at + 30); index++)
                        placements.add(placement(data, index, index == count - 1 ? "重逢" : "Chapter " + index, "yue"));
                    OccurrenceLabelIndex.refreshPlacements(data, placements, new LinkedHashSet<>(Set.of(GENERATION)));
                }
                double buildMs = (System.nanoTime() - build) / 1e6;
                for (String query : List.of("重逢", "chapter", "absent")) {
                    Measured observed = new Measured(data);
                    long beforeStarted = System.nanoTime();
                    String baseline = "PREFIX rv: <https://rezics.com/vocab/> SELECT ?occurrence WHERE { GRAPH <" + CommandPolicy.CURRENT + "> {"
                        + " ?placement rv:generation <" + GENERATION.getURI() + "> ; rv:occurrence ?occurrence ; rv:occurrenceLabel ?label ; rv:orderSegment ?segment ; rv:orderKey ?key ."
                        + " ?segment rv:parent <" + STRUCTURE.getURI() + "> ; rv:segmentKey ?segmentKey ."
                        + " FILTER(CONTAINS(LCASE(STR(?label)), \"" + query + "\")) } } ORDER BY ?segmentKey ?key LIMIT 2";
                    int beforeSize;
                    try (var execution = QueryExecution.create(baseline, DatasetFactory.wrap(observed))) { beforeSize = 0; var rows = execution.execSelect(); while (rows.hasNext()) { rows.next(); beforeSize++; } }
                    double beforeMs = (System.nanoTime() - beforeStarted) / 1e6;
                    long beforeQuads = observed.quads; observed.quads = 0;
                    long started = System.nanoTime();
                    var page = OccurrenceLabelIndex.search(observed, GENERATION, STRUCTURE, query, "", 2);
                    int reads = page.get("reads").getAsNumber().value().intValue();
                    assertTrue(reads < 40);
                    assertEquals(query.equals("absent") ? 0 : query.equals("重逢") ? 1 : 2, page.get("items").getAsArray().size());
                    assertEquals(beforeSize, page.get("items").getAsArray().size());
                    assertTrue("indexed quads=" + observed.quads, observed.quads < 50); assertTrue("baseline quads=" + beforeQuads, beforeQuads >= count);
                    System.out.println("G1022 native scale " + count + " " + query + " beforeMs=" + beforeMs + " beforeQuads=" + beforeQuads
                        + " afterMs=" + (System.nanoTime() - started) / 1e6 + " afterQuads=" + observed.quads + " reads=" + reads + " buildMs=" + buildMs);
                }
                String after = String.format("%08d", count - 4) + "\u0001a\u0001" + id(50_000 + count - 4).getURI();
                var tail = OccurrenceLabelIndex.search(data, GENERATION, STRUCTURE, "chapter", after, 101).get("items").getAsArray();
                assertEquals(2, tail.size());
                assertEquals(id(50_000 + count - 3).getURI(), tail.get(0).getAsObject().get("occurrence").getAsString().value());
            } finally { data.abort(); data.end(); data.close(); }
        }
    }
}
