package com.rezics.jena;

import static org.junit.Assert.*;

import java.util.Map;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** One corpus per test, beyond the former whole-catalogue request bound. */
public class g556QualificationTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static Node iri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private static final Node PUBLIC = iri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = iri(CommandPolicy.CONTROL);
    private static final Node PRODUCT = iri("urn:rezics:dataset:product");
    private static final Node BODY = iri(RV + "searchBody");
    private static final Node MATCH = iri(RV + "MatchUnit");
    private static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";

    private static final class Fixture implements AutoCloseable {
        final TextIndexLucene index;
        final FilteredGraphTextIndex filtered;
        final DatasetGraphText data;
        Fixture(int count) {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY);
            definition.set("publicTitle", iri(RV + "publicTitle"));
            definition.set("privateBody", iri(RV + "privateSearchBody"));
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(new ByteBuffersDirectory(), config) {
                @Override public org.apache.lucene.store.Directory getDirectory() {
                    if (failDirectoryOnce.getAndSet(false)) throw new IllegalStateException("injected transient index read");
                    return super.getDirectory();
                }
            };
            filtered = new FilteredGraphTextIndex(index);
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), filtered, new TextDocProducerTriples(filtered));
            data.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, filtered);
            filtered.bindRankData(data);
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, iri(RV + "dataEpoch"), literal("epoch"));
                data.add(CONTROL, PRODUCT, iri(RV + "routingEpoch"), literal("routing"));
                data.add(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.add(CONTROL, PRODUCT, iri(RV + "textIndexGeneration"), iri(GENERATION));
                SearchDeltaJournal.initialize(data);
                data.add(PUBLIC, iri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), iri(RV + "SearchGraphAnchor"));
                // Bootstrap always seeds the analyzer probe, including an empty catalogue.
                data.add(iri("urn:rezics:text-index:probe"), iri("urn:rezics:text-index:probe:unit"),
                    BODY, NodeFactory.createLiteralLang("中文检索验证", "zh"));
                for (int n = 0; n < count; n++) {
                    Node unit = iri("urn:rezics:match:g556:" + n);
                    Node main = iri("https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", n));
                    Node selection = iri("urn:rezics:selection:g556:" + n);
                    data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    // Jena stores different mapped fields as separate docs
                    // sharing the unit ID. Cursor resolution must bind its query.
                    data.add(PUBLIC, unit, iri(RV + "mainVersion"), main);
                    data.add(PUBLIC, unit, iri(RV + "context"), main);
                    data.add(PUBLIC, unit, iri(RV + "selection"), selection);
                    data.add(PUBLIC, unit, iri(RV + "language"), literal("en"));
                    data.add(PUBLIC, unit, iri(RV + "disclosure"), iri(RV + "Public"));
                    data.add(iri(CommandPolicy.CURRENT), main, iri(RV + "selectionHead"), selection);
                    data.add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("common catalogue phrase " + n, "en"));
                    data.add(PUBLIC, unit, iri(RV + "publicTitle"), NodeFactory.createLiteralLang("catalogue heading", "en"));
                }
                data.commit();
            } finally { data.end(); }
        }
        final java.util.concurrent.atomic.AtomicBoolean failDirectoryOnce = new java.util.concurrent.atomic.AtomicBoolean();
        @Override public void close() {
            synchronized (data) { SearchDeltaJournal.stopRecovery(data); data.close(); index.close(); }
        }
    }

    @Test public void generationBeyondTwentyThousandQualifiesAndNeverNeedsARequestInventory() {
        try (Fixture fixture = new Fixture(20_005)) {
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            for (int n = 0; n < 4; n++) {
                Map<String, Object> proof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0);
                assertEquals(true, proof.get("available"));
                assertEquals("20005", proof.get("qualifiedPopulation"));
                assertEquals(GENERATION, proof.get("generation"));
            }
            FilteredGraphTextIndex ranked = fixture.filtered;
            FilteredGraphTextIndex.RankAfter after = null;
            java.util.List<String> traversed = new java.util.ArrayList<>();
            for (int pageNumber = 0; pageNumber < 10; pageNumber++) {
                FilteredGraphTextIndex.RankPage page = ranked.ranked(BODY, "common catalogue phrase", 20, after);
                assertEquals(20, page.hits().size());
                assertEquals("lower-bound", page.precision());
                assertTrue(page.count() >= 1000);
                assertTrue(page.more());
                for (var hit : page.hits()) traversed.add(hit.id());
                var last = page.hits().getLast();
                after = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit());
            }
            // The pinned Lucene commit supplies a total tie order. Replaying
            // each cursor must retain it, independently of IRI insertion order.
            java.util.List<String> replayed = new java.util.ArrayList<>();
            FilteredGraphTextIndex.RankAfter replayAfter = null;
            for (int n = 0; n < 10; n++) {
                var page = ranked.ranked(BODY, "common catalogue phrase", 20, replayAfter);
                for (var hit : page.hits()) replayed.add(hit.id());
                var last = page.hits().getLast();
                replayAfter = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit());
            }
            assertEquals(traversed, replayed);
            assertEquals(200, new java.util.HashSet<>(traversed).size());
            fixture.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.RankAfter groupedAfter = null;
                java.util.List<String> groups = new java.util.ArrayList<>();
                java.util.concurrent.atomic.AtomicInteger graphReads = new java.util.concurrent.atomic.AtomicInteger();
                var counted = new org.apache.jena.sparql.core.DatasetGraphWrapper(fixture.data) {
                    @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(Node g, Node s, Node p, Node o) {
                        graphReads.incrementAndGet();
                        return super.find(g, s, p, o);
                    }
                    @Override public boolean contains(Node g, Node s, Node p, Node o) {
                        graphReads.incrementAndGet();
                        return super.contains(g, s, p, o);
                    }
                };
                for (int n = 0; n < 10; n++) {
                    graphReads.set(0);
                    var page = ranked.ranked(BODY, "common catalogue phrase", 20, groupedAfter,
                        counted, new FilteredGraphTextIndex.RankScope(null, null, null));
                    assertTrue("RDF admission must be page-sized, not 20,005 matching units", graphReads.get() < 1200);
                    assertEquals("lower-bound", page.precision());
                    assertEquals(20, page.hits().size());
                    for (var hit : page.hits()) groups.add(hit.key());
                    var last = page.hits().getLast();
                    groupedAfter = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit());
                }
                java.util.List<String> expectedGroups = new java.util.ArrayList<>();
                for (var id : traversed) expectedGroups.add("https://rezics.com/id/00000000-0000-4000-8000-"
                    + String.format("%012d", Integer.parseInt(id.substring(id.lastIndexOf(':') + 1))));
                assertEquals(expectedGroups, groups);
            } finally { fixture.data.end(); }
            // A Lucene mutation that has no native journal entry cannot retain
            // the old qualification, even when graph generation did not move.
            var removed = new org.apache.jena.query.text.Entity("urn:rezics:match:g556:0",
                CommandPolicy.PUBLIC_SEARCH, "en", null);
            removed.put("body", "common catalogue phrase 0");
            fixture.index.deleteEntity(removed);
            fixture.index.commit();
            try {
                ranked.ranked(BODY, "common catalogue phrase", 20, after);
                fail("an index write must restart a ranked continuation");
            } catch (org.apache.jena.query.text.TextIndexException expectedRestart) {
                assertTrue(expectedRestart.getMessage().contains("requires restart"));
            }
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            assertFalse(SearchDeltaJournal.qualify(fixture.data));
        }
    }

    @Test public void tokenlessUnitsQualifyButMissingStoredDocumentsDoNot() {
        try (Fixture fixture = new Fixture(1)) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                Node unit = iri("urn:rezics:match:g556:missing");
                fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                fixture.data.add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("... !!!", "en"));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            assertEquals("2", SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("qualifiedPopulation"));
            var removed = new org.apache.jena.query.text.Entity("urn:rezics:match:g556:missing",
                CommandPolicy.PUBLIC_SEARCH, "en", null);
            removed.put("body", "... !!!");
            fixture.index.deleteEntity(removed);
            fixture.index.commit();
            assertFalse(SearchDeltaJournal.qualify(fixture.data));
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
        }
    }

    @Test public void transientFenceFailureRecoversInBackgroundWithoutARebuild() throws Exception {
        try (Fixture fixture = new Fixture(3)) {
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            synchronized (fixture.data) {
                fixture.failDirectoryOnce.set(true);
                SearchDeltaJournal.fenceBeforeWrite(fixture.data);
                assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
                // Also fail the first background audit. Repeated invalidations
                // must retain one flight and recover on its next retry.
                fixture.failDirectoryOnce.set(true);
                for (int n = 0; n < 10; n++) SearchDeltaJournal.invalidate(fixture.data);
            }
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"))
                && System.nanoTime() < deadline) Thread.sleep(20);
            assertEquals("3", SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("qualifiedPopulation"));
        }
    }

    @Test public void backgroundRecoveryCannotQualifyAQuarantinedRebuild() throws Exception {
        try (Fixture fixture = new Fixture(3)) {
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            synchronized (fixture.data) {
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    fixture.data.deleteAny(PUBLIC, iri(CommandPolicy.PUBLIC_ANCHOR), Node.ANY, Node.ANY);
                    fixture.data.commit();
                } finally { fixture.data.end(); }
                SearchDeltaJournal.invalidate(fixture.data);
            }
            Thread.sleep(400);
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.add(PUBLIC, iri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), iri(RV + "SearchGraphAnchor"));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"))
                && System.nanoTime() < deadline) Thread.sleep(20);
            assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
        }
    }

    @Test public void startupQualifiesAnOlderRestoredDatasetWithoutARequestTimeScan() {
        try (Fixture fixture = new Fixture(3)) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.deleteAny(iri("urn:rezics:graph:search-delta"), Node.ANY, Node.ANY, Node.ANY);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertFalse(SearchDeltaJournal.qualify(fixture.data));
            assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
            var proof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0);
            assertEquals(true, proof.get("available"));
            assertEquals("3", proof.get("qualifiedPopulation"));
            assertEquals("0", proof.get("ordinal"));
        }
    }

    @Test public void qualifiedWritesSurviveJournalRolloverAndRebuildInvalidation() {
        try (Fixture fixture = new Fixture(0)) {
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            for (int number = 1; number <= SearchDeltaJournal.MAX_ENTRIES + 8; number++) {
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                    Node unit = iri("urn:rezics:match:g556:journal:" + number);
                    capture.observed().add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    capture.observed().add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("common catalogue phrase", "en"));
                    fixture.data.delete(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                        java.math.BigInteger.valueOf(number - 1), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                    fixture.data.add(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                        java.math.BigInteger.valueOf(number), org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                    SearchDeltaJournal.append(fixture.data, capture, number * 2L);
                    fixture.data.commit();
                } finally { fixture.data.end(); }
                // CommandService keeps the native writer monitor and odd epoch
                // until this bounded update, before another write can commit.
                var proof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, number * 2L);
                assertEquals(true, proof.get("available"));
                assertEquals(Integer.toString(number), proof.get("qualifiedPopulation"));
            }
            assertEquals(false, SearchDeltaJournal.proof(fixture.data, 0,
                (SearchDeltaJournal.MAX_ENTRIES + 8) * 2L).get("available"));
            assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1,
                (SearchDeltaJournal.MAX_ENTRIES + 8) * 2L).get("available"));
            SearchDeltaJournal.invalidate(fixture.data);
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 160).get("available"));
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            assertEquals("72", SearchDeltaJournal.qualifiedProof(fixture.data, -1, 160).get("qualifiedPopulation"));
        }
    }

    @Test public void realmRankTraversalIncludesEveryAdoptionAndNoGlobalFallback() {
        String realm = "https://rezics.com/id/11111111-1111-4111-8111-111111111111";
        try (Fixture fixture = new Fixture(500)) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                Node current = iri(CommandPolicy.CURRENT);
                Node realmNode = iri(realm);
                Node space = iri("https://rezics.com/id/22222222-2222-4222-8222-222222222222");
                fixture.data.add(current, realmNode, RDF.type.asNode(), iri(RV + "Realm"));
                fixture.data.add(current, realmNode, iri(RV + "realmState"), iri(RV + "Active"));
                fixture.data.add(current, realmNode, iri(RV + "space"), space);
                fixture.data.add(current, realmNode, iri(RV + "disclosure"), iri(RV + "Public"));
                fixture.data.add(current, space, RDF.type.asNode(), iri(RV + "Space"));
                fixture.data.add(current, space, iri(RV + "disclosure"), iri(RV + "Public"));
                for (int number = 0; number < 500; number++) {
                    Node main = iri("https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", number));
                    Node work = iri("https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", 1000 + number));
                    Node unit = iri("urn:rezics:match:g556:realm:" + number);
                    Node selection = iri("urn:rezics:selection:g556:realm:" + number);
                    Node slot = CanonicalPolicy.realmOwner(realmNode, main);
                    fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    fixture.data.add(PUBLIC, unit, iri(RV + "mainVersion"), main);
                    fixture.data.add(PUBLIC, unit, iri(RV + "work"), work);
                    fixture.data.add(PUBLIC, unit, iri(RV + "context"), iri(realm));
                    fixture.data.add(PUBLIC, unit, iri(RV + "selection"), selection);
                    fixture.data.add(PUBLIC, unit, iri(RV + "language"), literal("en"));
                    fixture.data.add(PUBLIC, unit, iri(RV + "disclosure"), iri(RV + "Public"));
                    fixture.data.add(current, slot, RDF.type.asNode(), iri(RV + "RealmPublicationSlot"));
                    fixture.data.add(current, slot, iri(RV + "selectionHead"), selection);
                    fixture.data.add(current, slot, iri(RV + "realm"), iri(realm));
                    fixture.data.add(current, slot, iri(RV + "mainVersion"), main);
                    fixture.data.add(current, slot, iri(RV + "work"), work);
                    fixture.data.add(iri(CommandPolicy.REVISIONS), selection, iri(RV + "slot"), slot);
                    fixture.data.add(iri(CommandPolicy.REVISIONS), selection, iri(RV + "context"), realmNode);
                    fixture.data.add(iri(CommandPolicy.REVISIONS), selection, iri(RV + "mainVersion"), main);
                    fixture.data.add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("common catalogue phrase " + number, "en"));
                }
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            fixture.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex ranked = fixture.filtered;
                FilteredGraphTextIndex.RankAfter after = null;
                java.util.List<String> traversed = new java.util.ArrayList<>();
                for (int number = 0; number < 25; number++) {
                    var page = ranked.ranked(BODY, "common catalogue phrase", 20, after, fixture.data,
                        new FilteredGraphTextIndex.RankScope(realm, "en", null));
                    assertEquals(500, page.count());
                    assertEquals("exact", page.precision());
                    assertEquals(number < 24, page.more());
                    for (var hit : page.hits()) {
                        assertTrue(hit.id().startsWith("urn:rezics:match:g556:realm:"));
                        traversed.add(hit.key());
                    }
                    var last = page.hits().getLast();
                    after = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit());
                }
                java.util.List<String> expected = new java.util.ArrayList<>();
                for (int number = 0; number < 500; number++) expected.add("https://rezics.com/id/00000000-0000-4000-8000-"
                    + String.format("%012d", number));
                assertEquals(new java.util.HashSet<>(expected), new java.util.HashSet<>(traversed));
            } finally { fixture.data.end(); }
        }
    }

    @Test public void journalRefreshesRankFactsButCurrentSelectionAdmissionIsNeverCached() {
        try (Fixture fixture = new Fixture(1)) {
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            Node unit = iri("urn:rezics:match:g556:0");
            Node main = iri("https://rezics.com/id/00000000-0000-4000-8000-000000000000");
            Node book = iri("https://rezics.com/id/00000000-0000-4000-8000-000000000001");
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                capture.observed().add(PUBLIC, unit, iri(RV + "searchResultMain"), book);
                fixture.data.delete(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                fixture.data.add(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ONE, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 2).get("available"));
            FilteredGraphTextIndex ranked = fixture.filtered;
            fixture.data.begin(ReadWrite.READ);
            try {
                var page = ranked.ranked(BODY, "common catalogue phrase", 20, null, fixture.data,
                    new FilteredGraphTextIndex.RankScope(null, null, null));
                assertEquals(book.getURI(), page.hits().getFirst().key());
            } finally { fixture.data.end(); }
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.deleteAny(iri(CommandPolicy.CURRENT), main, iri(RV + "selectionHead"), Node.ANY);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            fixture.data.begin(ReadWrite.READ);
            try {
                var page = ranked.ranked(BODY, "common catalogue phrase", 20, null, fixture.data,
                    new FilteredGraphTextIndex.RankScope(null, null, null));
                assertEquals(1, page.hits().size());
                assertNull(page.hits().getFirst().key());
            } finally { fixture.data.end(); }
        }
    }

    @Test public void privateFieldCommitKeepsPublicQualificationButCannotHideAnUnjournaledMutation() {
        try (Fixture fixture = new Fixture(1)) {
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.fenceBeforeWrite(fixture.data);
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                capture.observed().add(iri(CommandPolicy.PRIVATE_SEARCH), iri("urn:rezics:private:g556"),
                    iri(RV + "privateSearchBody"), NodeFactory.createLiteralLang("private selected paragraph", "en"));
                fixture.data.delete(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                fixture.data.add(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ONE, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            var proof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, 2);
            assertEquals(true, proof.get("available"));
            assertEquals("1", proof.get("qualifiedPopulation"));
            var entry = ((java.util.List<?>) proof.get("deltas")).getFirst();
            assertTrue(((java.util.List<?>) ((Map<?, ?>) entry).get("changes")).isEmpty());
            var removed = new org.apache.jena.query.text.Entity("urn:rezics:match:g556:0",
                CommandPolicy.PUBLIC_SEARCH, "en", null);
            removed.put("body", "common catalogue phrase 0");
            fixture.index.deleteEntity(removed);
            fixture.index.commit();
            SearchDeltaJournal.fenceBeforeWrite(fixture.data);
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 2).get("available"));
        }
    }

    @Test public void arqReturnsBoundedRankEnvelopeAndAuditKeepsTheReadTransactionOpen() {
        CommandModule.registerTextAssembler();
        try (Fixture fixture = new Fixture(3)) {
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            fixture.data.begin(ReadWrite.READ);
            try (var query = org.apache.jena.query.QueryExecutionFactory.create(
                "PREFIX rv: <" + RV + "> SELECT ?page ?population WHERE {"
                + " BIND(rv:rankedText(rv:searchBody, \"common catalogue phrase\", 2, \"\", \"{}\") AS ?page)"
                + " BIND(rv:publicTextInventory() AS ?population) }",
                org.apache.jena.query.DatasetFactory.wrap(fixture.data))) {
                var row = query.execSelect().next();
                var envelope = org.apache.jena.atlas.json.JSON.parse(row.getLiteral("page").getString());
                assertEquals(2, envelope.get("hits").getAsArray().size());
                assertTrue(envelope.get("more").getAsBoolean().value());
                assertEquals(3, row.getLiteral("population").getLong());
                assertTrue(fixture.data.isInTransaction());
            } finally { fixture.data.end(); }
            assertEquals("a bypass audit must not install a production qualification", false,
                SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
        }
    }
}
