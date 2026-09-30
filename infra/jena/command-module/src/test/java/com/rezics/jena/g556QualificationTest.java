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
        final DatasetGraphText data;
        Fixture(int count) {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY);
            definition.set("privateBody", iri(RV + "privateSearchBody"));
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            FilteredGraphTextIndex filtered = new FilteredGraphTextIndex(index);
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), filtered, new TextDocProducerTriples(filtered));
            data.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, filtered);
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, iri(RV + "dataEpoch"), literal("epoch"));
                data.add(CONTROL, PRODUCT, iri(RV + "routingEpoch"), literal("routing"));
                data.add(CONTROL, PRODUCT, iri(RV + "sequence"), NodeFactory.createLiteralByValue(
                    java.math.BigInteger.ZERO, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.add(CONTROL, PRODUCT, iri(RV + "textIndexGeneration"), iri(GENERATION));
                SearchDeltaJournal.initialize(data);
                // Bootstrap always seeds the analyzer probe, including an empty catalogue.
                data.add(iri("urn:rezics:text-index:probe"), iri("urn:rezics:text-index:probe:unit"),
                    BODY, NodeFactory.createLiteralLang("中文检索验证", "zh"));
                for (int n = 0; n < count; n++) {
                    Node unit = iri("urn:rezics:match:g556:" + n);
                    Node main = iri("https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", n));
                    Node selection = iri("urn:rezics:selection:g556:" + n);
                    data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    data.add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("common catalogue phrase " + n, "en"));
                    data.add(PUBLIC, unit, iri(RV + "mainVersion"), main);
                    data.add(PUBLIC, unit, iri(RV + "context"), main);
                    data.add(PUBLIC, unit, iri(RV + "selection"), selection);
                    data.add(PUBLIC, unit, iri(RV + "language"), literal("en"));
                    data.add(PUBLIC, unit, iri(RV + "disclosure"), iri(RV + "Public"));
                    data.add(iri(CommandPolicy.CURRENT), main, iri(RV + "selectionHead"), selection);
                }
                data.commit();
            } finally { data.end(); }
        }
        @Override public void close() { data.close(); index.close(); }
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
            FilteredGraphTextIndex ranked = new FilteredGraphTextIndex(fixture.index);
            FilteredGraphTextIndex.RankAfter after = null;
            java.util.List<String> traversed = new java.util.ArrayList<>();
            for (int pageNumber = 0; pageNumber < 10; pageNumber++) {
                FilteredGraphTextIndex.RankPage page = ranked.ranked(BODY, "common catalogue phrase", 20, after);
                assertEquals(20, page.hits().size());
                assertEquals("lower-bound", page.precision());
                assertEquals(1000, page.count());
                assertTrue(page.more());
                for (var hit : page.hits()) traversed.add(hit.id());
                var last = page.hits().getLast();
                after = new FilteredGraphTextIndex.RankAfter(last.id(), last.score(), page.commit());
            }
            java.util.List<String> expected = new java.util.ArrayList<>();
            for (int n = 0; n < 20_005; n++) expected.add("urn:rezics:match:g556:" + n);
            expected.sort(String::compareTo);
            assertEquals(expected.subList(0, 200), traversed);
            assertEquals(200, new java.util.HashSet<>(traversed).size());
            fixture.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.RankAfter groupedAfter = null;
                java.util.List<String> groups = new java.util.ArrayList<>();
                for (int n = 0; n < 10; n++) {
                    var page = ranked.ranked(BODY, "common catalogue phrase", 20, groupedAfter,
                        fixture.data, new FilteredGraphTextIndex.RankScope(null, null, null));
                    assertEquals("lower-bound", page.precision());
                    assertEquals(20, page.hits().size());
                    for (var hit : page.hits()) groups.add(hit.key());
                    var last = page.hits().getLast();
                    groupedAfter = new FilteredGraphTextIndex.RankAfter(last.key(), last.score(), page.commit());
                }
                java.util.List<String> expectedGroups = new java.util.ArrayList<>();
                for (int n = 0; n < 200; n++) expectedGroups.add("https://rezics.com/id/00000000-0000-4000-8000-"
                    + String.format("%012d", n));
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

    @Test public void unindexedAndTokenlessUnitsCannotQualify() {
        try (Fixture fixture = new Fixture(1)) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                Node unit = iri("urn:rezics:match:g556:missing");
                fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                fixture.data.add(PUBLIC, unit, BODY, literal("   "));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertFalse(SearchDeltaJournal.qualify(fixture.data));
            assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
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
                for (int number = 0; number < 500; number++) {
                    Node main = iri("https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", number));
                    Node unit = iri("urn:rezics:match:g556:realm:" + number);
                    Node selection = iri("urn:rezics:selection:g556:realm:" + number);
                    Node slot = iri("urn:rezics:slot:g556:realm:" + number);
                    fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    fixture.data.add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("common catalogue phrase " + number, "en"));
                    fixture.data.add(PUBLIC, unit, iri(RV + "mainVersion"), main);
                    fixture.data.add(PUBLIC, unit, iri(RV + "context"), iri(realm));
                    fixture.data.add(PUBLIC, unit, iri(RV + "selection"), selection);
                    fixture.data.add(PUBLIC, unit, iri(RV + "language"), literal("en"));
                    fixture.data.add(PUBLIC, unit, iri(RV + "disclosure"), iri(RV + "Public"));
                    Node current = iri(CommandPolicy.CURRENT);
                    fixture.data.add(current, slot, RDF.type.asNode(), iri(RV + "RealmPublicationSlot"));
                    fixture.data.add(current, slot, iri(RV + "selectionHead"), selection);
                    fixture.data.add(current, slot, iri(RV + "realm"), iri(realm));
                    fixture.data.add(current, slot, iri(RV + "mainVersion"), main);
                }
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            fixture.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex ranked = new FilteredGraphTextIndex(fixture.index);
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
                    after = new FilteredGraphTextIndex.RankAfter(last.key(), last.score(), page.commit());
                }
                java.util.List<String> expected = new java.util.ArrayList<>();
                for (int number = 0; number < 500; number++) expected.add("https://rezics.com/id/00000000-0000-4000-8000-"
                    + String.format("%012d", number));
                assertEquals(expected, traversed);
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
            FilteredGraphTextIndex ranked = new FilteredGraphTextIndex(fixture.index);
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
                assertTrue(page.hits().isEmpty());
                assertEquals(0, page.count());
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
