package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.document.Field;
import org.apache.lucene.document.FieldType;
import org.apache.lucene.index.IndexOptions;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.store.Directory;
import org.apache.lucene.store.FilterDirectory;
import org.apache.lucene.store.IOContext;
import org.apache.lucene.store.IndexInput;
import org.junit.Test;

/** Startup qualification names why it refused, and never writes a document body into that line. */
public class SearchDeltaJournalStartupTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = NodeFactory.createURI(CommandPolicy.CONTROL);
    private static final Node PRODUCT = NodeFactory.createURI("urn:rezics:dataset:product");
    private static final Node UNIT = NodeFactory.createURI("urn:rezics:match:test");
    private static final Node ANCHOR = NodeFactory.createURI(CommandPolicy.PUBLIC_ANCHOR);
    private static final Node BODY = NodeFactory.createURI(RV + "searchBody");
    private static final Node MATCH = NodeFactory.createURI(RV + "MatchUnit");
    private static final String RDF_BODY = "alpha-body-must-stay-out-of-the-log";
    private static final String INDEX_BODY = "beta-body-must-stay-out-of-the-log";
    private static final String CONTENT = "urn:rezics:content:match-unit:" + "d".repeat(64);
    private static final String CONTENT_BODY = "legacy-body-must-stay-out-of-the-log";
    private static final String CONTENT_INDEX_BODY = "legacy-index-body-must-stay-out-of-the-log";
    private static final String VARIANT = "urn:test:content:variant";
    private static final String RESOURCE = "urn:test:content:work";
    private static final String PUBLICATION = "urn:test:content:publication";
    private static final String ELIGIBILITY = "urn:test:content:eligibility";
    private static final String REVISION = "urn:rezics:content:revision:00000000-0000-4000-8000-000000000001";
    private static final String PROJECTION = "urn:test:content:projection:1";
    private static final String RECEIPT = "urn:test:content:receipt:1";
    private static final String DIGEST = "b".repeat(64);
    private static final String OWNER_EPOCH = "00000000-0000-4000-8000-000000000002";

    private static Node property(String name) { return NodeFactory.createURI(RV + name); }
    private static Node integer(String value) {
        return NodeFactory.createLiteralByValue(new BigInteger(value), XSDDatatype.XSDinteger);
    }

    private static final class Fixture implements AutoCloseable {
        final TextIndexLucene index;
        final DatasetGraphText data;
        Fixture() { this(new ByteBuffersDirectory()); }
        Fixture(Directory directory) { this(directory, false); }
        Fixture(boolean ranked) { this(new ByteBuffersDirectory(), ranked); }
        Fixture(Directory directory, boolean ranked) {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY);
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(directory, config);
            org.apache.jena.query.text.TextIndex text = ranked ? new FilteredGraphTextIndex(index) : index;
            data = new DatasetGraphText(org.apache.jena.sparql.core.DatasetGraphFactory.createTxnMem(), text,
                new TextDocProducerTriples(text));
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, property("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(CONTROL, PRODUCT, property("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(CONTROL, PRODUCT, property("sequence"), integer("0"));
                data.add(CONTROL, PRODUCT, property("textIndexGeneration"), NodeFactory.createURI(GENERATION));
                SearchDeltaJournal.initialize(data);
                data.commit();
            } finally { data.end(); }
        }
        void anchor() {
            data.begin(ReadWrite.WRITE);
            try {
                data.add(PUBLIC, ANCHOR, RDF.type.asNode(), property("SearchGraphAnchor"));
                data.commit();
            } finally { data.end(); }
        }
        @Override public void close() { data.close(); index.close(); }
    }

    private static final class BlockedReaderDirectory extends FilterDirectory {
        final AtomicBoolean armed = new AtomicBoolean();
        final CountDownLatch entered = new CountDownLatch(1);
        final CountDownLatch released = new CountDownLatch(1);

        BlockedReaderDirectory() { super(new ByteBuffersDirectory()); }

        @Override public IndexInput openInput(String name, IOContext context) throws IOException {
            if (name.startsWith("segments_") && armed.compareAndSet(true, false)) {
                entered.countDown();
                try {
                    if (!released.await(5, TimeUnit.SECONDS)) throw new IOException("reader release timed out");
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IOException("reader interrupted", interrupted);
                }
            }
            return super.openInput(name, context);
        }
    }

    private static void seedLegacyContent(DatasetGraph data, String body, String pinnedSource, boolean commit) {
        data.begin(ReadWrite.WRITE);
        try {
            String current = CommandPolicy.CURRENT, revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            iri(data, current, VARIANT, RDF.type.getURI(), RV + "ContentVariant");
            iri(data, current, VARIANT, RV + "resource", RESOURCE);
            iri(data, current, VARIANT, RV + "contentPublicationHead", PUBLICATION);
            iri(data, current, VARIANT, RV + "publicSearchEligibilityHead", ELIGIBILITY);
            iri(data, revisions, PUBLICATION, RDF.type.getURI(), RV + "ContentPublicationDecision");
            iri(data, revisions, PUBLICATION, RV + "component", VARIANT);
            iri(data, revisions, PUBLICATION, RV + "resource", RESOURCE);
            iri(data, revisions, PUBLICATION, RV + "contentRevision", REVISION);
            data.add(uri(revisions), uri(PUBLICATION), uri(RV + "byteDigest"), NodeFactory.createLiteralString(DIGEST));
            data.add(uri(revisions), uri(PUBLICATION), uri(RV + "ownerDataEpoch"), NodeFactory.createLiteralString(OWNER_EPOCH));
            iri(data, revisions, ELIGIBILITY, RDF.type.getURI(), RV + "ContentSearchEligibilityDecision");
            iri(data, revisions, ELIGIBILITY, RV + "variant", VARIANT);
            iri(data, revisions, ELIGIBILITY, RV + "resource", RESOURCE);
            iri(data, revisions, ELIGIBILITY, RV + "publicationDecision", PUBLICATION);
            iri(data, revisions, ELIGIBILITY, RV + "disclosure", RV + "Public");
            iri(data, revisions, PROJECTION, RDF.type.getURI(), RV + "ContentProjection");
            iri(data, revisions, PROJECTION, RV + "matchUnit", CONTENT);
            iri(data, revisions, PROJECTION, RV + "component", VARIANT);
            iri(data, revisions, PROJECTION, RV + "resource", RESOURCE);
            iri(data, revisions, PROJECTION, RV + "contentRevision", REVISION);
            iri(data, revisions, PROJECTION, RV + "publicationDecision", PUBLICATION);
            iri(data, revisions, PROJECTION, RV + "eligibility", ELIGIBILITY);
            iri(data, revisions, PROJECTION, RV + "modelRevision", "https://rezics.com/definition/content-match-unit-v1");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RDF.type.getURI(), RV + "MatchUnit");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "field", RV + "Body");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "disclosure", RV + "Public");
            data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CONTENT), uri(RV + "language"), NodeFactory.createLiteralString("en"));
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "variant", VARIANT);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "resource", RESOURCE);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "revision", REVISION);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "publicationDecision", PUBLICATION);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "eligibility", ELIGIBILITY);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "projection", PROJECTION);
            data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CONTENT), uri(RV + "searchBody"),
                NodeFactory.createLiteralLang(body, "en"));
            iri(data, receipts, RECEIPT, RDF.type.getURI(), RV + "OperationReceipt");
            iri(data, receipts, RECEIPT, RV + "outcome", RV + "Succeeded");
            iri(data, receipts, RECEIPT, RV + "variant", VARIANT);
            iri(data, receipts, RECEIPT, RV + "resource", RESOURCE);
            iri(data, receipts, RECEIPT, RV + "publicationDecision", PUBLICATION);
            iri(data, receipts, RECEIPT, RV + "eligibility", ELIGIBILITY);
            iri(data, receipts, RECEIPT, RV + "projection", PROJECTION);
            iri(data, receipts, RECEIPT, RV + "matchUnit", CONTENT);
            iri(data, receipts, RECEIPT, RV + "contentRevision", REVISION);
            if (pinnedSource != null) data.add(uri(receipts), uri(RECEIPT), uri(RV + "searchDeltaContentSource"),
                NodeFactory.createLiteralString(pinnedSource));
            if (commit) data.commit();
        } finally { data.end(); }
    }
    private static void iri(DatasetGraph data, String graph, String subject, String predicate, String object) {
        data.add(uri(graph), uri(subject), uri(predicate), uri(object));
    }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static void markRankSchemaOnAnotherDocument(Fixture fixture) {
        FieldType keyword = new FieldType();
        keyword.setTokenized(false);
        keyword.setStored(true);
        keyword.setIndexOptions(IndexOptions.DOCS);
        keyword.setOmitNorms(false);
        keyword.freeze();
        FieldType unstored = new FieldType(keyword);
        unstored.setStored(false);
        unstored.freeze();
        var neighbor = new org.apache.lucene.document.Document();
        neighbor.add(new Field("uri", "urn:rezics:rank-schema-neighbor", keyword));
        neighbor.add(new Field("graph", CommandPolicy.PUBLIC_SEARCH, keyword));
        neighbor.add(new Field(FilteredGraphTextIndex.RANK_SCHEMA, "1", unstored));
        try { fixture.index.getIndexWriter().addDocument(neighbor); }
        catch (java.io.IOException unavailable) { throw new IllegalStateException(unavailable); }
        fixture.index.commit();
    }

    private List<String> capture() {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        SearchDeltaJournal.logged = lines::add;
        return lines;
    }
    private void release(org.apache.jena.sparql.core.DatasetGraph data) {
        SearchDeltaJournal.logged = null;
        SearchDeltaJournal.stopRecovery(data);
    }

    @Test public void absentAnchorNamesTheRefusalAndInstallsNoBaseline() {
        try (Fixture fixture = new Fixture()) {
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains("startup-audit failed: public anchor absent"));
                assertTrue(lines.contains("journal invalidated: startup audit returned no baseline [qualify]"));
                assertFalse(lines.stream().anyMatch(line -> line.startsWith("search journal baseline installed:")));
                assertEquals(false, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void bodyMismatchNamesTheSubjectAndOmitsBothBodies() {
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            // Write RDF under the text wrapper so the producer does not index the real body.
            var base = ((org.apache.jena.sparql.core.DatasetGraphWrapper) fixture.data).getWrapped();
            base.begin(ReadWrite.WRITE);
            try {
                base.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                base.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang(RDF_BODY, "en"));
                base.commit();
            } finally { base.end(); }
            Entity stored = new Entity(UNIT.getURI(), CommandPolicy.PUBLIC_SEARCH, "en", null);
            stored.put("body", INDEX_BODY);
            fixture.index.addEntity(stored);
            fixture.index.commit();
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains(
                    "startup-audit failed: public index differs from RDF [" + UNIT.getURI() + "]"));
                assertFalse(lines.stream().anyMatch(line -> line.contains(RDF_BODY) || line.contains(INDEX_BODY)));
            } finally { release(fixture.data); }
        }
    }

    @Test public void qualifiedBaselineLogsEpochGenerationPopulationAndLuceneGeneration() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                var observed = capture.observed();
                observed.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                observed.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang("same selected body", "en"));
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            fixture.anchor();
            List<String> lines = capture();
            try {
                assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.stream().anyMatch(line -> line.matches(
                    "search journal baseline installed: epoch=epoch generation=" + GENERATION
                        + " population=1 luceneGeneration=[0-9]+")));
                assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void unpinnedContentReceiptQualifiesWhenTheStoredBodyMatchesRdf() {
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            seedLegacyContent(fixture.data, CONTENT_BODY, null, true);
            markRankSchemaOnAnotherDocument(fixture);
            List<String> lines = capture();
            try {
                assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.stream().anyMatch(line -> line.startsWith("search journal baseline installed:")));
                assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
                assertEquals("1", SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("qualifiedPopulation"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void unpinnedContentReceiptRefusesAStoredBodyThatDiffersFromRdf() {
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            seedLegacyContent(((org.apache.jena.sparql.core.DatasetGraphWrapper) fixture.data).getWrapped(),
                CONTENT_BODY, null, true);
            Entity stored = new Entity(CONTENT, CommandPolicy.PUBLIC_SEARCH, "en", null);
            stored.put("body", CONTENT_INDEX_BODY);
            fixture.index.addEntity(stored);
            fixture.index.commit();
            markRankSchemaOnAnotherDocument(fixture);
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains(
                    "startup-audit failed: public index differs from RDF [" + CONTENT + "]"));
                assertFalse(lines.stream().anyMatch(line ->
                    line.contains(CONTENT_BODY) || line.contains(CONTENT_INDEX_BODY)));
            } finally { release(fixture.data); }
        }
    }

    @Test public void contentReceiptPinThatDiffersFromCurrentAuthorityStaysClosed() {
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            seedLegacyContent(fixture.data, CONTENT_BODY, "stale-pin", true);
            List<String> lines = capture();
            try {
                assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
                assertTrue(lines.contains("startup-audit failed: original Content receipt source differs from current authority ["
                    + CONTENT + "]"));
            } finally { release(fixture.data); }
        }
    }

    private static void seedMigrationContent(Fixture fixture, String storedBody, boolean modern) {
        fixture.anchor();
        seedLegacyContent(fixture.data.getWrapped(), CONTENT_BODY, null, true);
        Entity stored = new Entity(CONTENT, CommandPolicy.PUBLIC_SEARCH, "en", null);
        stored.put("body", storedBody);
        if (modern) {
            var filtered = (FilteredGraphTextIndex) fixture.data.getTextIndex();
            filtered.bindRankData(fixture.data);
            // Rank context marks a modern document even without an external key.
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.add(PUBLIC, uri(CONTENT), property("context"), uri("urn:test:realm"));
                fixture.data.add(PUBLIC, uri(CONTENT), property("mainVersion"), uri("urn:test:main"));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            filtered.addEntity(stored);
        } else fixture.index.addEntity(stored);
        fixture.index.commit();
    }

    @Test public void rankSchemaMigrationPinsOnlyAVerifiedHistoricalBodyBeforeReplacingIt() {
        for (boolean journal : List.of(false, true)) try (Fixture fixture = new Fixture(true)) {
            seedMigrationContent(fixture, CONTENT_BODY, false);
            if (!journal) {
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    fixture.data.deleteAny(uri("urn:rezics:graph:search-delta"), Node.ANY, Node.ANY, Node.ANY);
                    fixture.data.commit();
                } finally { fixture.data.end(); }
            }
            assertTrue(OccurrenceTextSchema.rebuildIfIncompatible(fixture.data));
            assertFalse(OccurrenceTextSchema.incompatible((FilteredGraphTextIndex) fixture.data.getTextIndex()));
            fixture.data.begin(ReadWrite.READ);
            try {
                assertTrue(fixture.data.contains(uri(CommandPolicy.RECEIPTS), uri(RECEIPT),
                    property("searchDeltaContentSource"), Node.ANY));
                assertTrue(fixture.data.contains(uri(CommandPolicy.RECEIPTS), uri(RECEIPT),
                    property("searchDeltaContentBodyDigest"), Node.ANY));
            } finally { fixture.data.end(); }
            try { assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data)); }
            finally { release(fixture.data); }
        }
    }

    @Test public void rankSchemaMigrationRefusesACorruptHistoricalBodyWithoutPinningIt() {
        try (Fixture fixture = new Fixture(true)) {
            seedMigrationContent(fixture, CONTENT_INDEX_BODY, false);
            assertThrows(IllegalStateException.class, () -> OccurrenceTextSchema.rebuildIfIncompatible(fixture.data));
            fixture.data.begin(ReadWrite.READ);
            try {
                assertFalse(fixture.data.contains(uri(CommandPolicy.RECEIPTS), uri(RECEIPT),
                    property("searchDeltaContentSource"), Node.ANY));
            } finally { fixture.data.end(); }
            try { assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data)); }
            finally { release(fixture.data); }
        }
    }

    @Test public void rankSchemaRebuildCannotInventPinsForAnUnpinnedModernBody() {
        try (Fixture fixture = new Fixture(true)) {
            seedMigrationContent(fixture, CONTENT_BODY, true);
            OccurrenceTextSchema.rebuild(fixture.data,
                System.nanoTime() + TimeUnit.SECONDS.toNanos(10));
            fixture.data.begin(ReadWrite.READ);
            try {
                assertFalse(fixture.data.contains(uri(CommandPolicy.RECEIPTS), uri(RECEIPT),
                    property("searchDeltaContentSource"), Node.ANY));
            } finally { fixture.data.end(); }
            try { assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data)); }
            finally { release(fixture.data); }
        }
    }

    @Test public void directInvalidationNamesItsCaller() {
        try (Fixture fixture = new Fixture()) {
            List<String> lines = capture();
            try {
                SearchDeltaJournal.invalidate(fixture.data);
                assertTrue(lines.contains("journal invalidated: qualification withdrawn ["
                    + "SearchDeltaJournalStartupTest.directInvalidationNamesItsCaller]"));
            } finally { release(fixture.data); }
        }
    }

    @Test public void blockedStartupAuditPublishesQualificationAuditAndReaderOpening() throws Exception {
        BlockedReaderDirectory directory = new BlockedReaderDirectory();
        PublicSearchPhaseEvidence evidence = new PublicSearchPhaseEvidence(System::nanoTime, ignored -> {}, false);
        evidence.install();
        try (Fixture fixture = new Fixture(directory)) {
            fixture.anchor();
            directory.armed.set(true);
            CompletableFuture<Boolean> result = CompletableFuture.supplyAsync(() -> SearchDeltaJournal.qualifyAtStartup(fixture.data));
            try {
                assertTrue("startup reader did not block", directory.entered.await(2, TimeUnit.SECONDS));
                List<String> active = evidence.backgroundPhases();
                assertTrue(active.contains("QUALIFICATION"));
                assertTrue(active.contains("AUDIT"));
                assertTrue(active.contains("READER_OPEN"));
            } finally {
                directory.released.countDown();
                try { assertTrue(result.get(3, TimeUnit.SECONDS)); }
                finally { release(fixture.data); }
            }
            assertTrue(evidence.backgroundPhases().isEmpty());
        } finally { evidence.destroy(); }
    }

    @Test public void blockedProofPublishesProofAndReaderOpeningWithoutCommandWork() throws Exception {
        BlockedReaderDirectory directory = new BlockedReaderDirectory();
        PublicSearchPhaseEvidence evidence = new PublicSearchPhaseEvidence(System::nanoTime, ignored -> {}, false);
        evidence.install();
        try (Fixture fixture = new Fixture(directory)) {
            fixture.anchor();
            assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
            directory.armed.set(true);
            CompletableFuture<java.util.Map<String, Object>> result = CompletableFuture.supplyAsync(
                () -> SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0));
            try {
                assertTrue("proof reader did not block", directory.entered.await(2, TimeUnit.SECONDS));
                List<String> active = evidence.backgroundPhases();
                assertTrue(active.contains("PROOF"));
                assertTrue(active.contains("READER_OPEN"));
                assertFalse(active.contains("AUDIT"));
            } finally {
                directory.released.countDown();
                try { assertEquals(true, result.get(3, TimeUnit.SECONDS).get("available")); }
                finally { release(fixture.data); }
            }
            assertTrue(evidence.backgroundPhases().isEmpty());
        } finally { evidence.destroy(); }
    }

    @Test public void recoveryPublishesItsPhaseBeforeWaitingForTheWriterMonitor() throws Exception {
        PublicSearchPhaseEvidence evidence = new PublicSearchPhaseEvidence(System::nanoTime, ignored -> {}, false);
        evidence.install();
        try (Fixture fixture = new Fixture()) {
            fixture.anchor();
            try {
                synchronized (fixture.data) {
                    SearchDeltaJournal.invalidate(fixture.data);
                    long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                    while (!evidence.backgroundPhases().contains("RECOVERY") && System.nanoTime() < until)
                        Thread.sleep(10);
                    assertTrue("recovery wait was not published", evidence.backgroundPhases().contains("RECOVERY"));
                    assertFalse(evidence.backgroundPhases().contains("AUDIT"));
                }
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
                while (!evidence.backgroundPhases().isEmpty() && System.nanoTime() < until) Thread.sleep(10);
                assertTrue("recovery phases leaked", evidence.backgroundPhases().isEmpty());
                assertEquals(true, SearchDeltaJournal.qualifiedProof(fixture.data, -1, 0).get("available"));
            } finally { release(fixture.data); }
        } finally { evidence.destroy(); }
    }

}
