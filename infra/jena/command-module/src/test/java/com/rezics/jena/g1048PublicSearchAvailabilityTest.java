package com.rezics.jena;

import static org.junit.Assert.*;
import static com.rezics.jena.g1022OccurrenceLabelsTest.*;
import java.math.BigInteger;
import java.util.Map;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.document.Document;
import org.apache.lucene.document.StoredField;
import org.apache.lucene.document.Field;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Public qualification owns body documents, not the asynchronous label lag.
 * Jena 6.2.0 commits all mapped fields through the same physical text writer:
 * https://github.com/apache/jena/blob/jena-6.2.0/jena-text/src/main/java/org/apache/jena/query/text/DatasetGraphText.java
 */
public class g1048PublicSearchAvailabilityTest {
    private static final Node CONTROL = OccurrenceLabelIndex.uri(CommandPolicy.CONTROL);
    private static final Node PRODUCT = OccurrenceLabelIndex.uri("urn:rezics:dataset:product");
    private static final Node PUBLIC = OccurrenceLabelIndex.uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node UNIT = OccurrenceLabelIndex.uri("urn:rezics:match:g1048");
    private static final Node TEXT_GENERATION = OccurrenceLabelIndex.uri(
        "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111");
    private static Node number(long value) {
        return NodeFactory.createLiteralByValue(BigInteger.valueOf(value), XSDDatatype.XSDinteger);
    }
    private static final class Fixture implements AutoCloseable {
        final FilteredGraphTextIndex index;
        final DatasetGraphText data;
        Runnable duringReplay;
        long sequence;
        Fixture(int population) {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.set("publicTitle", p("publicTitle"));
            definition.set(OccurrenceTextSchema.FIELD, p("occurrenceSearchLabels"));
            definition.setUidField("uid"); definition.setLangField("lang");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
            index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            var source = new org.apache.jena.sparql.core.DatasetGraphWrapper(DatasetGraphFactory.createTxnMem()) {
                @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(Node g, Node s, Node p, Node o) {
                    return org.apache.jena.atlas.iterator.Iter.map(super.find(g, s, p, o), quad -> {
                        if (duringReplay != null) duringReplay.run();
                        return quad;
                    });
                }
            };
            data = new DatasetGraphText(source, index, new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                fixture(data, population);
                data.deleteAny(CONTROL, PRODUCT, p("textIndexGeneration"), Node.ANY);
                data.add(CONTROL, PRODUCT, p("textIndexGeneration"), TEXT_GENERATION);
                data.add(CONTROL, PRODUCT, p("dataEpoch"), text("epoch"));
                data.add(CONTROL, PRODUCT, p("routingEpoch"), text("routing"));
                data.add(CONTROL, PRODUCT, p("sequence"), number(0));
                data.add(PUBLIC, OccurrenceLabelIndex.uri(CommandPolicy.PUBLIC_ANCHOR),
                    RDF.type.asNode(), p("SearchGraphAnchor"));
                data.add(PUBLIC, UNIT, RDF.type.asNode(), p("MatchUnit"));
                data.add(PUBLIC, UNIT, p("searchBody"), NodeFactory.createLiteralLang("Current public reunion", "en"));
                data.add(PUBLIC, UNIT, p("publicTitle"), NodeFactory.createLiteralLang("Current public reunion", "en"));
                data.add(OccurrenceLabelIndex.uri("urn:rezics:search:probe"), id(90000),
                    p("searchBody"), NodeFactory.createLiteralLang("中文检索验证", "zh"));
                for (int at = 0; at < population; at++) placement(data, at, "重逢 " + at, "yue");
                OccurrenceLabelIndex.queue(data, GENERATION, false);
                SearchDeltaJournal.initialize(data);
                data.commit();
            } finally { data.end(); }
            assertTrue(SearchDeltaJournal.qualifyAtStartup(data));
        }
        void project(boolean reset) {
            synchronized (data) {
                data.begin(ReadWrite.WRITE);
                try {
                    SearchDeltaJournal.fenceBeforeWrite(data);
                    var delta = new SearchDeltaJournal.Capture(data);
                    if (reset) OccurrenceLabelIndex.queue(data, GENERATION, true);
                    else OccurrenceLabelIndex.project(data, GENERATION, REVISION);
                    data.delete(CONTROL, PRODUCT, p("sequence"), number(sequence));
                    data.add(CONTROL, PRODUCT, p("sequence"), number(++sequence));
                    SearchDeltaJournal.append(data, delta, sequence * 2);
                    // Pending deletes/adds are invisible to committed Lucene
                    // readers until the complete writer transaction commits.
                    assertPublicDocuments();
                    data.commit();
                } finally { data.end(); }
                assertPublicQualified(TEXT_GENERATION);
            }
        }
        void assertPublicDocuments() {
            assertEquals(1, index.query(p("searchBody"), "reunion", CommandPolicy.PUBLIC_SEARCH, null).size());
            assertEquals(1, index.query(p("publicTitle"), "reunion", CommandPolicy.PUBLIC_SEARCH, null).size());
            assertEquals(1, index.query(p("searchBody"), "中文检索", "urn:rezics:search:probe", null).size());
        }
        void assertPublicQualified(Node generation) {
            Map<String, Object> proof = SearchDeltaJournal.qualifiedProof(data, -1, sequence * 2);
            assertEquals(true, proof.get("available"));
            assertEquals("1", proof.get("qualifiedPopulation"));
            assertEquals(generation.getURI(), proof.get("generation"));
            assertEquals(1, SearchDeltaJournal.auditPopulation(data, index.lucene()));
            assertPublicDocuments();
        }
        boolean current() {
            data.begin(ReadWrite.READ);
            try { return OccurrenceLabelIndex.ready(data, GENERATION, REVISION); }
            finally { data.end(); }
        }
        @Override public void close() {
            synchronized (data) { SearchDeltaJournal.stopRecovery(data); data.close(); }
        }
    }

    @Test public void labelProjectionAndBoundedResetNeverClosePublicQualification() {
        try (var f = new Fixture(130)) {
            assertFalse(f.current()); f.assertPublicQualified(TEXT_GENERATION);
            f.project(false); assertFalse(f.current());
            f.project(false); assertFalse(f.current());
            f.project(false); assertTrue(f.current());
            f.project(true); assertFalse(f.current());
            for (int batch = 0; batch < 6 && !f.current(); batch++) f.project(false);
            assertTrue(f.current());
        }
    }

    @Test public void legacySchemaRebuildRetainsPublicFieldsAndRequalifiesTheNewGeneration() throws Exception {
        for (boolean missingOrderOnly : java.util.List.of(false, true))
        try (var f = new Fixture(1)) {
            // Inject the legacy stored-only schema alongside authoritative label
            // RDF. This is the startup upgrade path, before HTTP admission.
            var entity = OccurrenceLabelIndex.uri(OccurrenceLabelIndex.scope(GENERATION, REVISION, STRUCTURE)
                + "00000000!a!" + id(50000).getURI().substring("https://rezics.com/id/".length()) + ":chapter");
            f.data.begin(ReadWrite.WRITE);
            try {
                f.data.getWrapped().add(OccurrenceLabelIndex.TEXT, entity, p("occurrenceSearchLabels"),
                    text("{\"labels\":[{\"value\":\"重逢\",\"language\":\"yue\"}]}"));
                var legacy = new Document();
                if (missingOrderOnly) {
                    legacy.add(new Field(OccurrenceTextSchema.FIELD, "legacy", OccurrenceTextSchema.TYPE));
                    legacy.add(new StoredField(OccurrenceTextSchema.PAYLOAD, "{\"labels\":[]}"));
                } else legacy.add(new StoredField(OccurrenceTextSchema.FIELD, "legacy"));
                f.index.lucene().getIndexWriter().addDocument(legacy);
                f.data.commit();
            } finally { f.data.end(); }
            f.assertPublicDocuments();
            assertTrue(OccurrenceTextSchema.incompatible(f.index));
            var readsDuringReplay = new java.util.concurrent.atomic.AtomicInteger();
            f.duringReplay = () -> { f.assertPublicDocuments(); readsDuringReplay.incrementAndGet(); };
            try { assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(f.data)); }
            finally { f.duringReplay = null; }
            assertTrue("committed readers remain available while the replacement is replayed", readsDuringReplay.get() > 0);
            assertTrue(SearchDeltaJournal.qualifyAtStartup(f.data));
            f.data.begin(ReadWrite.READ);
            Node rebuilt;
            try {
                rebuilt = OccurrenceLabelIndex.textGeneration(f.data);
                assertNotEquals(TEXT_GENERATION, rebuilt);
                assertFalse(OccurrenceLabelIndex.ready(f.data, GENERATION, REVISION));
            } finally { f.data.end(); }
            f.assertPublicQualified(rebuilt);
            assertFalse(OccurrenceTextSchema.rebuildIfIncompatible(f.data));
            assertEquals(1, f.index.occurrences(GENERATION, REVISION, STRUCTURE, "重逢", "", 1)
                .get("items").getAsArray().size());
        }
    }

    @Test public void partialNumbersKeepOrderAndContinuationAtEveryScaleWithoutChangingBareNumbers() {
        for (int count : new int[]{100, 1000, 10000}) try (var f = new g1022OccurrenceLabelsTest.Fixture()) {
            f.data.begin(ReadWrite.WRITE);
            try {
                fixture(f.data, count);
                for (int at = 0; at < count; at++) placement(f.data, at, "Chapter " + (at + 1), "en");
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit();
            } finally { f.data.end(); }
            f.drain();
            var first = f.page("chapter 9", "", 2);
            assertEquals(2, first.get("items").getAsArray().size());
            assertEquals(id(50008).getURI(), first.get("items").getAsArray().get(0).getAsObject().get("occurrence").getAsString().value());
            assertEquals(id(50089).getURI(), first.get("items").getAsArray().get(1).getAsObject().get("occurrence").getAsString().value());
            String after = "00000089\u0001a\u0001" + id(50089).getURI();
            var next = f.page("chapter 9", after, 2);
            assertEquals(id(50090).getURI(), next.get("items").getAsArray().get(0).getAsObject().get("occurrence").getAsString().value());
            assertEquals(id(50091).getURI(), next.get("items").getAsArray().get(1).getAsObject().get("occurrence").getAsString().value());
            assertTrue(first.get("reads").getAsNumber().value().intValue() <= 4);
            assertEquals(1, f.page("9", "", 101).get("items").getAsArray().size());
            assertEquals(2, f.page("Chapter ９", "", 2).get("items").getAsArray().size());
        }
    }

    @Test public void numericPrefixNeverCrossesLabelBoundariesOrReordersTokens() {
        try (var f = new g1022OccurrenceLabelsTest.Fixture()) {
            f.data.begin(ReadWrite.WRITE);
            try {
                fixture(f.data, 4);
                placement(f.data, 0, "Chapter 90", "en");
                Node split = placement(f.data, 1, "Chapter", "en");
                f.data.add(CURRENT, split, p("occurrenceLabel"), NodeFactory.createLiteralLang("90", "fr"));
                placement(f.data, 2, "90 Chapter", "en");
                placement(f.data, 3, "Chapter intervening 90", "en");
                OccurrenceLabelIndex.queue(f.data, GENERATION, false); f.data.commit();
            } finally { f.data.end(); }
            f.drain();
            var page = f.page("chapter 9", "", 101).get("items").getAsArray();
            assertEquals(4, page.size());
            for (int at = 0; at < page.size(); at++) assertEquals(at == 0, page.get(at).getAsObject().get("matches").getAsBoolean().value());
        }
    }
}
