package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class g1022OccurrenceLabelsTest {
    static Node id(int value) { return OccurrenceLabelIndex.uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value)); }
    static Node p(String value) { return OccurrenceLabelIndex.p(value); }
    static Node text(String value) { return NodeFactory.createLiteralString(value); }
    static final Node CURRENT = OccurrenceLabelIndex.uri(CommandPolicy.CURRENT), GENERATION = id(1), STRUCTURE = id(2), GROUP = id(3), REVISION = id(4);
    static final class Fixture implements AutoCloseable {
        final FilteredGraphTextIndex index;
        final DatasetGraphText data;
        Fixture() {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("occurrenceLabel", p("occurrenceSearchLabels"));
            definition.set("publicTitle", p("publicTitle"));
            definition.setUidField("uid"); definition.setLangField("lang");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
            index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), index, new TextDocProducerTriples(index));
        }
        void drain() {
            for (int attempt = 0; attempt < 1000; attempt++) {
                data.begin(ReadWrite.WRITE);
                boolean done;
                try { OccurrenceLabelIndex.project(data, GENERATION, REVISION); done = OccurrenceLabelIndex.ready(data, GENERATION, REVISION); data.commit(); }
                finally { data.end(); }
                if (done) return;
            }
            fail("projection did not finish");
        }
        org.apache.jena.atlas.json.JsonObject page(String query, String after, int size) {
            data.begin(ReadWrite.READ);
            try { var page = index.occurrences(GENERATION, REVISION, STRUCTURE, query, after, size);
                page.put("current", OccurrenceLabelIndex.ready(data, GENERATION, REVISION)); return page; }
            finally { data.end(); }
        }
        public void close() { data.close(); }
    }
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
        data.add(OccurrenceLabelIndex.uri(CommandPolicy.CONTROL), OccurrenceLabelIndex.uri("urn:rezics:dataset:product"), p("textIndexGeneration"), id(95000));
        data.add(CURRENT, STRUCTURE, p("structureProfile"), p("BookComposition"));
        data.add(CURRENT, STRUCTURE, p("structureHead"), REVISION);
        data.add(CURRENT, STRUCTURE, p("selectedGeneration"), GENERATION);
        data.add(CURRENT, GENERATION, RDF.type.asNode(), p("StructureGeneration"));
        data.add(CURRENT, GENERATION, p("structure"), STRUCTURE);
        data.add(CURRENT, GENERATION, p("generationState"), p("Active"));
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
    @Test public void usesExistingAnalyzerAndPreservesEveryCarriedLanguage() {
        try (var f = new Fixture()) {
            f.data.begin(ReadWrite.WRITE);
            try {
                f.data.add(OccurrenceLabelIndex.uri(CommandPolicy.PUBLIC_SEARCH), id(90001), p("publicTitle"), NodeFactory.createLiteralLang("Existing public title", "en"));
                fixture(f.data, 1); Node placement = placement(f.data, 0, "魔法禁書目錄", "yue");
                f.data.add(CURRENT, placement, p("occurrenceLabel"), NodeFactory.createLiteralLang("ｶﾞﾗｽ ＲＵＳＴ", "ja"));
                f.data.add(CURRENT, placement, p("occurrenceLabel"), NodeFactory.createLiteralLang("Cafe\u0301", "fr"));
                f.data.add(CURRENT, placement, p("occurrenceLabel"), NodeFactory.createLiteralLang("separate boundary", "de"));
                Node qualifier = id(90000); f.data.add(CURRENT, placement, p("qualifier"), qualifier);
                f.data.add(CURRENT, qualifier, p("displayLabel"), text("第十二卷"));
                f.data.add(CURRENT, qualifier, p("number"), text("１２"));
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit();
            } finally { f.data.end(); }
            assertFalse(f.page("CAFÉ", "", 1).get("current").getAsBoolean().value());
            f.drain();
            for (String query : List.of("禁书目录", "がらす", "Rust", "CAFÉ", "十二", "12"))
                assertEquals(query, 1, f.page(query, "", 1).get("items").getAsArray().size());
            assertFalse(f.page("rust café", "", 1).get("items").getAsArray().get(0).getAsObject().get("matches").getAsBoolean().value());
        }
    }
    @Test public void activationQueuesWithoutIndexingAndPartialBatchesResumeAfterRestart() {
        try (var f = new Fixture()) {
            f.data.begin(ReadWrite.WRITE);
            try { fixture(f.data, 100); for (int at=0; at<100; at++) placement(f.data, at, "shared", "en");
                OccurrenceLabelIndex.queue(f.data, GENERATION, false);
                assertFalse(f.data.contains(OccurrenceLabelIndex.TEXT, Node.ANY, Node.ANY, Node.ANY)); f.data.commit(); }
            finally { f.data.end(); }
            f.data.begin(ReadWrite.WRITE);
            try { OccurrenceLabelIndex.project(f.data, GENERATION, REVISION); f.data.commit(); } finally { f.data.end(); }
            var page = f.page("shared", "", 2);
            assertEquals(2, page.get("items").getAsArray().size()); assertFalse(page.get("current").getAsBoolean().value());
            f.drain(); assertTrue(f.page("shared", "", 2).get("current").getAsBoolean().value());
            f.data.begin(ReadWrite.WRITE);
            try {
                f.data.deleteAny(OccurrenceLabelIndex.uri(CommandPolicy.CONTROL), OccurrenceLabelIndex.uri("urn:rezics:dataset:product"), p("textIndexGeneration"), Node.ANY);
                f.data.add(OccurrenceLabelIndex.uri(CommandPolicy.CONTROL), OccurrenceLabelIndex.uri("urn:rezics:dataset:product"), p("textIndexGeneration"), id(95001));
                assertFalse(OccurrenceLabelIndex.ready(f.data, GENERATION, REVISION));
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit();
            } finally { f.data.end(); }
            f.drain(); assertTrue(f.page("shared", "", 2).get("current").getAsBoolean().value());
            f.data.begin(ReadWrite.WRITE);
            try { OccurrenceLabelIndex.queue(f.data, GENERATION, true); f.data.abort(); } finally { f.data.end(); }
            assertTrue(f.page("shared", "", 2).get("current").getAsBoolean().value());
        }
    }
    @Test public void staleRevisionCannotWriteAndResetClearsInBoundedBatches() {
        try (var f = new Fixture()) {
            f.data.begin(ReadWrite.WRITE);
            try { fixture(f.data, 160); for (int at=0; at<160; at++) placement(f.data, at, "old", "en");
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit(); } finally { f.data.end(); }
            f.drain();
            f.data.begin(ReadWrite.WRITE);
            try { OccurrenceLabelIndex.queue(f.data, GENERATION, true);
                assertThrows(IllegalStateException.class, () -> OccurrenceLabelIndex.project(f.data, GENERATION, id(5)));
                OccurrenceLabelIndex.project(f.data, GENERATION, REVISION);
                var remaining = f.data.find(OccurrenceLabelIndex.STATE, Node.ANY, p("indexedGeneration"), GENERATION);
                int count = 0; try { while (remaining.hasNext()) { remaining.next(); count++; } } finally { org.apache.jena.atlas.iterator.Iter.close(remaining); }
                assertEquals(96, count); f.data.commit(); } finally { f.data.end(); }
            f.drain(); assertEquals(2, f.page("old", "", 2).get("items").getAsArray().size());
        }
    }
    @Test public void maintenancePolicyAcceptsOnlyDerivedOccurrenceRequestsWithoutProductWrites() {
        String receipt = "urn:rezics:receipt:chapter-search-index:" + "c".repeat(64);
        String update = "PREFIX rv: <https://rezics.com/vocab/> DELETE { GRAPH <" + CommandPolicy.CONTROL
            + "> { <urn:rezics:dataset:product> rv:sequence ?n } } INSERT { GRAPH <" + CommandPolicy.CONTROL
            + "> { <urn:rezics:dataset:product> rv:sequence ?next } GRAPH <" + CommandPolicy.RECEIPTS
            + "> { <" + receipt + "> rv:occurrenceSearchGeneration <" + id(10_000).getURI() + "> } GRAPH <"
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
    @Test public void sparseCommonAbsentAndContinuationHaveFixedNativeBudgetsAtEveryScale() {
        for (int count : new int[]{100, 1000, 10000}) try (var f = new Fixture()) {
            long build = System.nanoTime();
            f.data.begin(ReadWrite.WRITE);
            try { fixture(f.data, count); for (int at=0; at<count; at++) placement(f.data, at, at == count-1 ? "重逢" : "Chapter " + at, "yue");
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit(); } finally { f.data.end(); }
            f.drain(); double buildMs = (System.nanoTime()-build)/1e6;
            for (String query : List.of("重逢", "chapter", "absent")) {
                f.data.begin(ReadWrite.READ); Measured observed = new Measured(f.data); long start=System.nanoTime(); int beforeSize=0;
                String baseline = "PREFIX rv: <https://rezics.com/vocab/> SELECT ?occurrence WHERE { GRAPH <" + CommandPolicy.CURRENT + "> {"
                    + " ?placement rv:generation <" + GENERATION.getURI() + "> ; rv:occurrence ?occurrence ; rv:occurrenceLabel ?label ; rv:orderSegment ?segment ; rv:orderKey ?key ."
                    + " ?segment rv:parent <" + STRUCTURE.getURI() + "> ; rv:segmentKey ?segmentKey ."
                    + " FILTER(CONTAINS(LCASE(STR(?label)), \"" + query + "\")) } } ORDER BY ?segmentKey ?key LIMIT 2";
                try (var execution = QueryExecution.create(baseline, DatasetFactory.wrap(observed))) { var rows=execution.execSelect(); while(rows.hasNext()) {rows.next(); beforeSize++;} }
                finally { f.data.end(); }
                double beforeMs=(System.nanoTime()-start)/1e6; start=System.nanoTime();
                var page=f.page(query,"",2); int reads=page.get("reads").getAsNumber().value().intValue();
                assertEquals(beforeSize,page.get("items").getAsArray().size()); assertTrue(reads<=FilteredGraphTextIndex.OCCURRENCE_VISITS);
                assertEquals(query.equals("absent") ? 1 : query.equals("重逢") ? 3 : 5, reads);
                System.out.println("G1022 native scale " + count + " " + query + " beforeMs=" + beforeMs + " beforeQuads=" + observed.quads
                    + " afterMs=" + (System.nanoTime()-start)/1e6 + " reads=" + reads + " buildMs=" + buildMs);
            }
            assertEquals(Math.min(101, count-1), f.page("chapter", "", 101).get("items").getAsArray().size());
            String after=String.format("%08d",count-4)+"\u0001a\u0001"+id(50000+count-4).getURI();
            assertEquals(2,f.page("chapter",after,101).get("items").getAsArray().size());
        }
    }
}
