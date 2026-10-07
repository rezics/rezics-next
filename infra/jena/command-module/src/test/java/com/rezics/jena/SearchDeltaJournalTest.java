package com.rezics.jena;

import static org.junit.Assert.*;

import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.fuseki.server.DataService;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.apache.jena.update.UpdateAction;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.apache.lucene.store.FSDirectory;
import org.junit.Test;

public class SearchDeltaJournalTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CONTROL = NodeFactory.createURI(CommandPolicy.CONTROL);
    private static final Node PRODUCT = NodeFactory.createURI("urn:rezics:dataset:product");
    private static final Node UNIT = NodeFactory.createURI("urn:rezics:match:test");
    private static final Node BODY = NodeFactory.createURI(RV + "searchBody");
    private static final Node MATCH = NodeFactory.createURI(RV + "MatchUnit");
    private static final Node LITERAL = NodeFactory.createLiteralLang("same selected body", "en");
    private static Node property(String name) { return NodeFactory.createURI(RV + name); }
    private static Node integer(String value) {
        return NodeFactory.createLiteralByValue(new BigInteger(value), XSDDatatype.XSDinteger);
    }

    private static final class Fixture implements AutoCloseable {
        final TextIndexLucene index;
        final DatasetGraphText data;
        Fixture() {
            EntityDefinition definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY);
            definition.setLangField("lang");
            definition.setUidField("uid");
            TextIndexConfig config = new TextIndexConfig(definition);
            config.setValueStored(true);
            index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            data = new DatasetGraphText(DatasetGraphFactory.createTxnMem(), index,
                new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, property("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(CONTROL, PRODUCT, property("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(CONTROL, PRODUCT, property("sequence"), integer("0"));
                data.add(CONTROL, PRODUCT, property("textIndexGeneration"),
                    NodeFactory.createURI("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
                SearchDeltaJournal.initialize(data);
                data.commit();
            } finally { data.end(); }
        }
        void sequence(String oldValue, String newValue) {
            data.delete(CONTROL, PRODUCT, property("sequence"), integer(oldValue));
            data.add(CONTROL, PRODUCT, property("sequence"), integer(newValue));
        }
        @Override public void close() { data.close(); index.close(); }
    }

    @Test public void admittedContentBodyKeepsUtf16AndUtf8BudgetsAndLanguageEquality() {
        Node language = NodeFactory.createLiteralString("zh-Hans-u-nu-hanidec");
        assertTrue(CommandService.admittedContentBody(
            NodeFactory.createLiteralLang("中".repeat(65_536), "zh-Hans-u-nu-hanidec"), language));
        assertFalse(CommandService.admittedContentBody(
            NodeFactory.createLiteralLang("中".repeat(65_537), "zh-Hans-u-nu-hanidec"), language));
        Node english = NodeFactory.createLiteralString("en-x-reader");
        assertTrue(CommandService.admittedContentBody(
            NodeFactory.createLiteralLang("😀".repeat(32_768), "en-x-reader"), english));
        assertFalse(CommandService.admittedContentBody(
            NodeFactory.createLiteralLang("😀".repeat(32_769), "en-x-reader"), english));
        assertFalse(CommandService.admittedContentBody(NodeFactory.createLiteralLang("... !!!", "en"), language));
    }

    @Test public void actualBeforeAfterAndExactLuceneDocuments() {
        try (Fixture fixture = new Fixture()) {
            DatasetGraphText data = fixture.data;
            assertEquals(true, SearchDeltaJournal.proof(data, -1, 0).get("available"));
            data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(data);
                DatasetGraph observed = capture.observed();
                observed.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                observed.add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("0", "1");
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT.getURI(), false, true)),
                    capture.changes());
                SearchDeltaJournal.append(data, capture, 2);
                data.commit();
            } finally { data.end(); }
            Map<String, Object> first = SearchDeltaJournal.proof(data, 0, 2);
            assertEquals(true, first.get("available"));
            assertEquals("1", first.get("ordinal"));

            data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(data);
                DatasetGraph observed = capture.observed();
                observed.add(PUBLIC, UNIT, BODY, LITERAL); // no-op add is not a delta
                observed.delete(PUBLIC, UNIT, BODY, LITERAL);
                observed.add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("1", "2");
                assertEquals(List.of(new SearchDeltaJournal.Change(UNIT.getURI(), true, true)),
                    capture.changes());
                SearchDeltaJournal.append(data, capture, 4);
                data.commit();
            } finally { data.end(); }
            assertEquals(true, SearchDeltaJournal.proof(data, 1, 4).get("available"));

            // Jena's TextIndex.get(uri) sees only the first document. The exact
            // reader must reject an extra document for the same unit and graph.
            Entity duplicate = new Entity(UNIT.getURI(), CommandPolicy.PUBLIC_SEARCH, "en", null);
            duplicate.put("body", LITERAL.getLiteralLexicalForm());
            fixture.index.addEntity(duplicate);
            fixture.index.commit();
            assertEquals(false, SearchDeltaJournal.proof(data, 1, 4).get("available"));
        }
    }

    @Test public void storedBodyWithoutIndexedTermsQualifiesByIdentity() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                DatasetGraph observed = capture.observed();
                observed.add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                observed.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang("... !!!", "en"));
                fixture.sequence("0", "1");
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue("the full body:* inventory cannot find a tokenless body",
                fixture.index.query(BODY, "body:*", CommandPolicy.PUBLIC_SEARCH, null, 10).isEmpty());
            assertEquals(true, SearchDeltaJournal.proof(fixture.data, 0, 2).get("available"));
            assertEquals(1, SearchDeltaJournal.auditPopulation(fixture.data, fixture.index));
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.add(PUBLIC, NodeFactory.createURI(CommandPolicy.PUBLIC_ANCHOR),
                    RDF.type.asNode(), property("SearchGraphAnchor"));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
            assertEquals("1", SearchDeltaJournal.qualifiedProof(fixture.data, -1, 2).get("qualifiedPopulation"));
        }
    }

    @Test public void actualSubjectOverflowAndCallerClaimMismatchReject() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                DatasetGraph observed = capture.observed();
                for (int i = 0; i < SearchDeltaJournal.MAX_UNITS; i++)
                    observed.add(PUBLIC, NodeFactory.createURI("urn:rezics:match:" + i),
                        RDF.type.asNode(), MATCH);
                try {
                    observed.add(PUBLIC, NodeFactory.createURI("urn:rezics:match:overflow"),
                        RDF.type.asNode(), MATCH);
                    fail("actual 65th subject must reject before commit");
                } catch (IllegalArgumentException expected) {
                    assertTrue(expected.getMessage().contains("64 units"));
                }
                fixture.data.abort();
            } finally { fixture.data.end(); }
        }
        List<SearchDeltaJournal.Change> changed = List.of(
            new SearchDeltaJournal.Change("urn:rezics:match:old", true, false),
            new SearchDeltaJournal.Change("urn:rezics:match:new", false, true));
        assertTrue(SearchDeltaJournal.matchesClaim(changed, "urn:rezics:match:new"));
        assertFalse(SearchDeltaJournal.matchesClaim(changed, null));
        assertFalse(SearchDeltaJournal.matchesClaim(changed, "urn:rezics:match:extra"));
        assertFalse(SearchDeltaJournal.matchesClaim(List.of(
            new SearchDeltaJournal.Change("urn:rezics:match:new", false, true),
            new SearchDeltaJournal.Change("urn:rezics:match:extra", false, true)),
            "urn:rezics:match:new"));

        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                DatasetGraph observed = capture.observed();
                for (String id : List.of("urn:rezics:match:new", "urn:rezics:match:extra")) {
                    Node unit = NodeFactory.createURI(id);
                    observed.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    observed.add(PUBLIC, unit, BODY, LITERAL);
                }
                assertEquals(2, capture.changes().size());
                assertFalse(SearchDeltaJournal.matchesClaim(capture.changes(), "urn:rezics:match:new"));
                fixture.data.abort();
            } finally { fixture.data.end(); }
        }
    }

    @Test public void rollbackAndBoundedJournalFailClosed() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                capture.observed().add(PUBLIC, UNIT, RDF.type.asNode(), MATCH);
                capture.observed().add(PUBLIC, UNIT, BODY, LITERAL);
                fixture.sequence("0", "1");
                SearchDeltaJournal.append(fixture.data, capture, 2);
                fixture.data.abort();
            } finally { fixture.data.end(); }
            assertEquals("0", SearchDeltaJournal.proof(fixture.data, -1, 2).get("ordinal"));
            assertFalse(fixture.data.contains(PUBLIC, UNIT, BODY, LITERAL));

            for (int i = 1; i <= SearchDeltaJournal.MAX_ENTRIES + 1; i++) {
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    fixture.sequence(Integer.toString(i - 1), Integer.toString(i));
                    SearchDeltaJournal.append(fixture.data,
                        new SearchDeltaJournal.Capture(fixture.data), i * 2L);
                    fixture.data.commit();
                } finally { fixture.data.end(); }
            }
            assertEquals(false, SearchDeltaJournal.proof(fixture.data, 0,
                (SearchDeltaJournal.MAX_ENTRIES + 1) * 2L).get("available"));
            assertEquals(true, SearchDeltaJournal.proof(fixture.data, 1,
                (SearchDeltaJournal.MAX_ENTRIES + 1) * 2L).get("available"));
        }
    }

    @Test public void variableSubjectUpdateCannotExceedActualUnitCap() {
        try (Fixture fixture = new Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                for (int i = 0; i <= SearchDeltaJournal.MAX_UNITS; i++) {
                    Node unit = NodeFactory.createURI("urn:rezics:match:variable:" + i);
                    fixture.data.add(PUBLIC, unit, RDF.type.asNode(), MATCH);
                    fixture.data.add(PUBLIC, unit, BODY, LITERAL);
                }
                fixture.data.commit();
            } finally { fixture.data.end(); }
            fixture.data.begin(ReadWrite.WRITE);
            try {
                SearchDeltaJournal.Capture capture = new SearchDeltaJournal.Capture(fixture.data);
                try {
                    UpdateAction.parseExecute("DELETE { GRAPH <" + CommandPolicy.PUBLIC_SEARCH + "> {"
                        + " ?unit <" + RV + "searchBody> ?body } } WHERE { GRAPH <"
                        + CommandPolicy.PUBLIC_SEARCH + "> { ?unit <" + RV
                        + "searchBody> ?body } }", DatasetFactory.wrap(capture.observed()));
                    fail("variable template touched more than 64 actual subjects");
                } catch (IllegalArgumentException expected) {
                    assertTrue(expected.getMessage().contains("64 units"));
                }
                fixture.data.abort();
            } finally { fixture.data.end(); }
            assertTrue(fixture.data.contains(PUBLIC,
                NodeFactory.createURI("urn:rezics:match:variable:64"), BODY, LITERAL));
        }
    }

    @Test public void onlyQueryAndNativeCommandAdmitDeltaReplay() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        Operation command = Operation.alloc("https://rezics.com/fuseki/command", "command", "native command");
        DataService product = DataService.newBuilder(data)
            .addEndpoint(Operation.Query).addEndpoint(command).build();
        assertTrue(CommandService.deltaExclusive(product));
        for (Operation bypass : List.of(Operation.Update, Operation.GSP_RW,
            Operation.GSP_Direct_RW, Operation.Upload, Operation.Patch,
            Operation.alloc("urn:rezics:unknown-writer", "unknown", "unknown"))) {
            DataService qa = DataService.newBuilder(data)
                .addEndpoint(Operation.Query).addEndpoint(command).addEndpoint(bypass).build();
            assertFalse("bypass operation " + bypass, CommandService.deltaExclusive(qa));
        }
    }

    /** Persistent native writer, configured analyzer and real admission profiles. */
    private static final class ContentFixture implements AutoCloseable {
        static final String UNIT_ID = "urn:rezics:content:match-unit:" + "a".repeat(64);
        static final String WORK = "urn:test:content:work", VARIANT = "urn:test:content:variant";
        static final String PUBLICATION = "urn:test:content:publication", ELIGIBILITY = "urn:test:content:eligibility";
        static final String REVISION = "urn:rezics:content:revision:00000000-0000-4000-8000-000000000001";
        static final String MODEL = "https://rezics.com/definition/content-match-unit-v1";
        final Path root;
        final ProfileRegistry profiles = ProfileRegistry.load(Files.isRegularFile(Path.of("profiles/manifest.json"))
            ? Path.of("profiles") : Path.of("../../../generated/model"));
        final CommandService service = new CommandService(profiles, "1".repeat(64).getBytes(),
            "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
        TextIndexConfig config;
        TextIndexLucene index;
        FilteredGraphTextIndex filtered;
        DatasetGraphText data;
        DatasetGraph storage;
        boolean closed;
        boolean rejectBodyReads;
        int receiptProjectionLookups;
        Runnable afterJournalSource;
        int journalSourceWrites;
        int journalEntriesWritten;
        int quadAddDepth;
        ContentFixture(Path existing) throws Exception { root = existing; open(); }
        ContentFixture() throws Exception {
            Files.createDirectories(Path.of(".temp"));
            root = Files.createTempDirectory(Path.of(".temp"), "content-native-delivery-");
            open();
            data.begin(ReadWrite.WRITE);
            try {
                UpdateAction.parseExecute("""
                    PREFIX rv: <https://rezics.com/vocab/>
                    INSERT DATA {
                      GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product>
                        rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:routingEpoch "routing" ; rv:sequence 0 ;
                        rv:textIndexGeneration <urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111> . }
                      GRAPH <urn:rezics:graph:current> {
                        <%s> a <https://schema.org/CreativeWork> .
                        <%s> a rv:ContentVariant ; rv:resource <%s> ;
                          rv:contentPublicationHead <%s> ; rv:publicSearchEligibilityHead <%s> . }
                      GRAPH <urn:rezics:graph:revisions> {
                        <%s> a rv:ContentPublicationDecision, rv:RevisionAnchor ;
                          rv:component <%s> ; rv:resource <%s> ;
                          rv:operation <urn:rezics:operation:%s> ; rv:contentRevision <%s> ;
                          rv:contentPreparation "prepared" ; rv:byteDigest "%s" ;
                          rv:contentFormat "rezics-content-json-v1" ; rv:contentModel "rezics-content-json-v1" ;
                          rv:contentLanguageKind "missing" ; rv:contentDirection "none" ;
                          rv:ownerDataEpoch "00000000-0000-4000-8000-000000000002" ; rv:ownerSequence "1" ;
                          rv:modelRevision <https://rezics.com/definition/content-publication-v1> ;
                          rv:shapeRevision <https://rezics.com/definition/content-publication-v1> ;
                          rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:sequence 1 .
                        <%s> a rv:ContentSearchEligibilityDecision, rv:RevisionAnchor ;
                          rv:component <%s> ; rv:variant <%s> ; rv:resource <%s> ;
                          rv:publicationDecision <%s> ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public ;
                          rv:admissionId "00000000-0000-4000-8000-000000000003" ; rv:authorityEpoch "0" ;
                          rv:admittedScope "content:search-eligibility:%s" ; rv:actingSubject <urn:test:actor> ;
                          rv:modelRevision <https://rezics.com/definition/content-search-eligibility-v1> ;
                          rv:shapeRevision <https://rezics.com/definition/content-search-eligibility-v1> ;
                          rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:sequence 1 . }
                    }
                    """.formatted(WORK, VARIANT, WORK, PUBLICATION, ELIGIBILITY, PUBLICATION,
                        VARIANT, WORK, "a".repeat(64), REVISION, "b".repeat(64), ELIGIBILITY,
                        VARIANT, VARIANT, WORK, PUBLICATION, VARIANT), DatasetFactory.wrap(data));
                SearchDeltaJournal.initialize(data);
                data.add(PUBLIC, NodeFactory.createURI(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), property("SearchGraphAnchor"));
                data.commit();
            } finally { data.end(); }
            assertTrue(SearchDeltaJournal.qualifyAtStartup(data));
        }
        void open() throws Exception {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY); definition.set("publicTitle", property("publicTitle"));
            definition.set("privateBody", property("privateSearchBody"));
            definition.set("occurrenceLabel", property("occurrenceSearchLabels"));
            definition.setUidField("uid"); definition.setLangField("lang");
            config = new TextIndexConfig(definition); config.setValueStored(true);
            config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
            index = new TextIndexLucene(FSDirectory.open(root.resolve("lucene")), config);
            filtered = new FilteredGraphTextIndex(index);
            storage = TDB2Factory.connectDataset(root.resolve("tdb2").toString()).asDatasetGraph();
            data = new DatasetGraphText(storage, filtered, new TextDocProducerTriples(filtered), true) {
                @Override public void add(Quad quad) {
                    quadAddDepth++;
                    try { super.add(quad); } finally { quadAddDepth--; }
                    if (quadAddDepth == 0 && Thread.currentThread() instanceof CancellationWorker worker) worker.afterCopy(quad);
                }
                @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                    super.add(graph, subject, predicate, object);
                    Quad quad = new Quad(graph, subject, predicate, object);
                    observeJournalSource(quad);
                    if (quadAddDepth == 0 && Thread.currentThread() instanceof CancellationWorker worker) worker.afterCopy(quad);
                }
                @Override public java.util.Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
                    if (NodeFactory.createURI(CommandPolicy.RECEIPTS).equals(graph) && Node.ANY.equals(subject)
                        && property("projection").equals(predicate) && !Node.ANY.equals(object)) receiptProjectionLookups++;
                    checkBodyRead(graph, predicate); return super.find(graph, subject, predicate, object);
                }
                @Override public java.util.Iterator<Quad> find(Quad quad) {
                    checkBodyRead(quad.getGraph(), quad.getPredicate()); return super.find(quad);
                }
                @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                    checkBodyRead(graph, predicate); return super.contains(graph, subject, predicate, object);
                }
                @Override public boolean contains(Quad quad) {
                    checkBodyRead(quad.getGraph(), quad.getPredicate()); return super.contains(quad);
                }
            };
            filtered.bindRankData(data);
            closed = false;
        }
        void checkBodyRead(Node graph, Node predicate) {
            if (rejectBodyReads && BODY.equals(predicate) && (PUBLIC.equals(graph) || Node.ANY.equals(graph)))
                throw new AssertionError("receipt-bound Content verification read RDF searchBody");
        }
        Node receiptField(int version, String name) {
            data.begin(ReadWrite.READ);
            try {
                var rows = data.find(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(receipt(version)), property(name), Node.ANY);
                try { assertTrue(rows.hasNext()); Node value = rows.next().getObject(); assertFalse(rows.hasNext()); return value; }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            } finally { data.end(); }
        }
        void removeBodyCopy() {
            storage.begin(ReadWrite.WRITE);
            try { storage.deleteAny(PUBLIC, NodeFactory.createURI(UNIT_ID), BODY, Node.ANY); storage.commit(); }
            finally { storage.end(); }
        }
        void observeJournalSource(Quad quad) {
            if (quad.getGraph().equals(NodeFactory.createURI("urn:rezics:graph:search-delta"))
                && quad.getPredicate().equals(property("searchDeltaWriteEpoch"))) journalEntriesWritten++;
            if (!quad.getGraph().equals(NodeFactory.createURI("urn:rezics:graph:search-delta"))
                || !quad.getPredicate().equals(property("searchDeltaContentSource"))) return;
            journalSourceWrites++;
            if (afterJournalSource != null) {
                Runnable action = afterJournalSource; afterJournalSource = null; action.run();
            }
        }
        String receipt(int version) { return "urn:test:content:receipt:" + version; }
        String projection(int version) { return "urn:test:content:projection:" + version; }
        String update(int version, String body, String language) {
            return """
                PREFIX rv: <https://rezics.com/vocab/>
                DELETE {
                  GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n }
                  GRAPH <urn:rezics:search:public> { <%s> ?p ?o }
                }
                INSERT {
                  GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
                  GRAPH <urn:rezics:graph:revisions> {
                    <%s> a rv:ContentProjection, rv:RevisionAnchor ; rv:component <%s> ; rv:resource <%s> ;
                      rv:contentRevision <%s> ; rv:publicationDecision <%s> ; rv:eligibility <%s> ;
                      rv:matchUnit <%s> ; rv:ownerDataEpoch "00000000-0000-4000-8000-000000000002" ; rv:ownerSequence "7" ;
                      rv:modelRevision <%s> ; rv:shapeRevision <%s> ; rv:datasetId <urn:rezics:dataset:product> ;
                      rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:sequence ?next . }
                  GRAPH <urn:rezics:search:public> {
                    <%s> a rv:MatchUnit ; rv:resource <%s> ; rv:variant <%s> ; rv:revision <%s> ;
                      rv:publicationDecision <%s> ; rv:eligibility <%s> ; rv:projection <%s> ;
                      rv:context <urn:test:content:work> ; rv:mainVersion <urn:test:content:work> ;
                      rv:language "%s" ; rv:field rv:Body ; rv:disclosure rv:Public ; rv:searchBody "%s"@%s . }
                  GRAPH <urn:rezics:graph:receipts> {
                    <%s> a rv:OperationReceipt ; rv:requestDigest "%s" ; rv:outcome rv:Succeeded ;
                      rv:resource <%s> ; rv:variant <%s> ; rv:ownerDataEpoch "00000000-0000-4000-8000-000000000002" ; rv:ownerSequence "7" ;
                      rv:contentRevision <%s> ; rv:publicationDecision <%s> ; rv:eligibility <%s> ;
                      rv:matchUnit <%s> ; rv:projection <%s> ; rv:datasetId <urn:rezics:dataset:product> ;
                      rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:sequence ?next . }
                  GRAPH <urn:rezics:graph:outbox> {
                    <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:sequence ?next ; rv:eventCount 1 ; rv:event <%s:event> .
                    <%s:event> a rv:ContentProjectionEvent ; rv:ordinal 0 ; rv:receipt <%s> . }
                }
                WHERE {
                  GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "00000000-0000-4000-8000-000000000002" ; rv:routingEpoch "routing" ; rv:sequence ?n }
                  OPTIONAL { GRAPH <urn:rezics:search:public> { <%s> ?p ?o } }
                  FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?rp ?ro } }
                  BIND(?n + 1 AS ?next)
                }
                """.formatted(UNIT_ID, projection(version), VARIANT, WORK, REVISION, PUBLICATION, ELIGIBILITY,
                    UNIT_ID, MODEL, MODEL, UNIT_ID, WORK, VARIANT, REVISION, PUBLICATION, ELIGIBILITY,
                    projection(version), language, body, language, receipt(version), receipt(version), WORK, VARIANT,
                    REVISION, PUBLICATION, ELIGIBILITY, UNIT_ID, projection(version), receipt(version), receipt(version),
                    receipt(version), receipt(version), UNIT_ID, receipt(version));
        }
        Map<String, Object> deliver(int version, String body, String language) {
            return deliver(version, body, language, System.nanoTime() + 30_000_000_000L);
        }
        Map<String, Object> deliver(int version, String body, String language, long deadline) {
            return deliverUnit(version, UNIT_ID, body, language, deadline);
        }
        Map<String, Object> deliverUnit(int version, String unit, String body, String language, long deadline) {
            var profile = profiles.get("content-match-unit-v1");
            String request = update(version, body, language).replace(UNIT_ID, unit)
                .replace("{ <" + unit + "> ?p ?o }", "{ <" + UNIT_ID + "> ?p ?o }");
            return service.runCommand(data, receipt(version), receipt(version), request, List.of(
                new CommandService.Validation("content-match-unit-v1", profile, MODEL + "/projection-shape",
                    List.of(projection(version)), List.of(CommandPolicy.REVISIONS), Map.of()),
                new CommandService.Validation("content-match-unit-v1", profile, MODEL + "/unit-shape",
                    List.of(unit), List.of(CommandPolicy.PUBLIC_SEARCH), Map.of())), deadline);
        }
        int documents(String id) throws Exception {
            try (var reader = DirectoryReader.open(index.getDirectory())) {
                return new IndexSearcher(reader).count(new TermQuery(new Term("uri", id)));
            }
        }
        int population() throws Exception {
            try (var reader = DirectoryReader.open(index.getDirectory())) { return reader.numDocs(); }
        }
        long committedGeneration() throws Exception {
            try (var reader = DirectoryReader.open(index.getDirectory())) { return reader.getIndexCommit().getGeneration(); }
        }
        Set<Quad> graphSnapshot() {
            data.begin(ReadWrite.READ);
            try { return Set.copyOf(org.apache.jena.atlas.iterator.Iter.toList(data.find())); }
            finally { data.end(); }
        }
        void legacyBody(String body, String language) throws Exception {
            index.getIndexWriter().deleteDocuments(new Term("uri", UNIT_ID));
            Entity entity = new Entity(UNIT_ID, CommandPolicy.PUBLIC_SEARCH, language, null);
            entity.put("body", body);
            var document = org.apache.jena.query.text.RezicsLuceneDocument.build(index, entity);
            FilteredGraphTextIndex.decorateRankDocument(document, WORK, WORK);
            index.getIndexWriter().addDocument(document); index.commit();
        }
        void assertPendingRepair() {
            try (var reader = DirectoryReader.open(index.getIndexWriter())) {
                assertEquals(1, new IndexSearcher(reader).count(new TermQuery(new Term("uri", UNIT_ID))));
                assertEquals(0, documents(UNIT_ID));
            } catch (Exception failure) { throw new AssertionError("repair did not reach the pending native writer", failure); }
        }
        void mutate(String graph, String subject, String predicate, Node value) {
            data.begin(ReadWrite.WRITE);
            try { data.deleteAny(NodeFactory.createURI(graph), NodeFactory.createURI(subject), property(predicate), Node.ANY);
                if (value != null) data.add(NodeFactory.createURI(graph), NodeFactory.createURI(subject), property(predicate), value);
                data.commit();
            } finally { data.end(); }
        }
        void closeForCrash() {
            synchronized (data) { if (!closed) {
                SearchDeltaJournal.stopRecovery(data); data.close(); config.getAnalyzer().close();
                // TDB2's cached switchable close leaves its process locks held.
                // Expel this fixture's container and storage without forcing active transactions.
                org.apache.jena.tdb2.sys.TDBInternal.expel(storage);
                closed = true;
            } }
        }
        void reopen() throws Exception { closeForCrash(); open(); }
        @Override public void close() throws Exception {
            if (!closed && data.isInTransaction()) { data.abort(); data.end(); }
            closeForCrash();
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    private enum DeliveryMode { ORDINARY, SLIM, BULK }
    private enum CancellationPoint { COPY, PRECOMMIT, NONE }
    private static final String NATIVE_EPOCH = "00000000-0000-4000-8000-000000000002";
    private static String catalogueId(int item, String part) {
        return "https://rezics.com/id/00000000-0000-4000-8000-" + String.format("%012d", 100 + item * 10 +
            switch (part) { case "work" -> 1; case "main" -> 2; case "revision" -> 3; default -> 4; });
    }
    /** This is the existing catalogue import footprint: it cannot carry Content text. */
    private static CommandService.BulkItem catalogueItem(ContentFixture f, int item) {
        String receipt = "urn:rezics:receipt:catalogue-cancellation:" + item;
        String work = catalogueId(item, "work"), main = catalogueId(item, "main"),
            revision = catalogueId(item, "revision"), mainRevision = catalogueId(item, "mainRevision");
        String operation = "urn:rezics:operation:" + "f".repeat(63) + item;
        String admission = "00000000-0000-4000-8000-00000000000" + item;
        String profile = "https://rezics.com/definition/work-metadata-v1";
        String common = "GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:dataEpoch \""
            + NATIVE_EPOCH + "\" ; rv:routingEpoch \"routing\" ; rv:sequence ?n }"
            + " FILTER NOT EXISTS { GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:restoreHold true } }"
            + " FILTER NOT EXISTS { GRAPH <" + CommandPolicy.RECEIPTS + "> { <" + receipt + "> ?p ?o } } BIND(?n + 1 AS ?next)";
        String stamp = "<" + receipt + "> a rv:OperationReceipt ; rv:requestDigest \"digest\" ;"
            + " rv:admissionId \"" + admission + "\" ; rv:authorityEpoch \"0\" ; rv:admittedScope \"work:create:catalogue-import\" ;"
            + " rv:commandFamily \"work-catalogue-import-v1\" ; rv:datasetId <urn:rezics:dataset:product> ;"
            + " rv:dataEpoch \"" + NATIVE_EPOCH + "\" ; rv:sequence ?next";
        String control = "GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> rv:sequence ?next }";
        String batch = "GRAPH <" + CommandPolicy.OUTBOX + "> { <" + receipt + ":batch> a rv:OutboxBatch ;"
            + " rv:dataEpoch \"" + NATIVE_EPOCH + "\" ; rv:sequence ?next ; rv:eventCount 1 ; rv:event <" + receipt + ":event> ."
            + " <" + receipt + ":event> rv:ordinal 0 ; rv:action \"work.create\" ; rv:receipt <" + receipt + ">";
        String outbox = batch + " ; a rv:WorkCreatedEvent ; rv:operation <" + operation + "> ; rv:work <" + work + "> }";
        String cancelledOutbox = batch + " ; a rv:AdmissionCancelledEvent ; rv:admissionId \"" + admission + "\" }";
        String prefix = "PREFIX rv: <" + RV + "> DELETE { GRAPH <" + CommandPolicy.CONTROL
            + "> { <urn:rezics:dataset:product> rv:sequence ?n } } INSERT { " + control;
        String update = prefix + " GRAPH <" + CommandPolicy.CURRENT + "> { <" + work
            + "> a <https://schema.org/CreativeWork> ; rv:mainVersion <" + main + "> ;"
            + " rv:continuityProfile <https://rezics.com/definition/continuity/native-work-v1> ;"
            + " <http://www.w3.org/2000/01/rdf-schema#label> \"Catalogue title " + item + "\"@en ; rv:head <" + revision + "> ;"
            + " rv:catalogueVisible true ; rv:provisional false ; rv:declaredGrain \"new-creative-scope\" ."
            + " <" + main + "> a rv:MainVersion ; rv:work <" + work + "> ; rv:hostingPolicy rv:MetadataOnly ; rv:head <" + mainRevision + "> }"
            + " GRAPH <" + CommandPolicy.REVISIONS + "> { "
            + List.of(Map.entry(revision, work), Map.entry(mainRevision, main)).stream().map(entry ->
                "<" + entry.getKey() + "> a rv:RevisionAnchor ; rv:component <" + entry.getValue()
                + "> ; rv:operation <" + operation + "> ; rv:manifest <urn:rezics:sha256:" + "d".repeat(64) + "> ; rv:modelRevision <" + profile
                + "> ; rv:shapeRevision <" + profile + "> ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch \""
                + NATIVE_EPOCH + "\" ; rv:sequence ?next .")
                .collect(java.util.stream.Collectors.joining(" ")) + " }"
            + " GRAPH <" + CommandPolicy.RECEIPTS + "> { " + stamp + " ; rv:outcome rv:Succeeded ; rv:operation <" + operation
            + "> ; rv:work <" + work + "> ; rv:mainVersion <" + main + "> ; rv:workRevision <" + revision
            + "> ; rv:mainRevision <" + mainRevision + "> } " + outbox
            + " } WHERE { " + common
            + List.of(Map.entry(CommandPolicy.CURRENT, work), Map.entry(CommandPolicy.CURRENT, main),
                Map.entry(CommandPolicy.REVISIONS, revision), Map.entry(CommandPolicy.REVISIONS, mainRevision)).stream()
                .map(entry -> " FILTER NOT EXISTS { GRAPH <" + entry.getKey() + "> { <" + entry.getValue() + "> ?occupied ?value } }")
                .collect(java.util.stream.Collectors.joining()) + " }";
        String cancellation = prefix + " GRAPH <" + CommandPolicy.RECEIPTS + "> { " + stamp
            + " ; rv:outcome rv:Cancelled ; rv:importFailure \"candidate-failed\" } " + cancelledOutbox + " } WHERE { " + common + " }";
        var validations = List.of(
            new CommandService.Validation("work-metadata-v1", f.profiles.get("work-metadata-v1"), profile + "/work-shape",
                List.of(work), List.of(CommandPolicy.CURRENT), Map.of()),
            new CommandService.Validation("work-metadata-v1", f.profiles.get("work-metadata-v1"), profile + "/main-version-shape",
                List.of(main), List.of(CommandPolicy.CURRENT), Map.of()),
            new CommandService.Validation("work-kind-v3", f.profiles.get("work-kind-v3"),
                "https://rezics.com/definition/work-kind-v3/work-shape", List.of(work), List.of(CommandPolicy.CURRENT), Map.of()));
        var plan = CommandPolicy.parse(update, receipt);
        assertFalse(plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH));
        assertFalse(plan.graphs().contains(CommandPolicy.PRIVATE_SEARCH));
        return new CommandService.BulkItem(receipt, "digest", update, plan, validations,
            cancellation, CommandPolicy.parse(cancellation, receipt));
    }
    private static void seedSlim(ContentFixture f) {
        var seed = SlimCommandTest.dataset();
        seed.begin(ReadWrite.READ); f.data.begin(ReadWrite.WRITE);
        try {
            var rows = seed.find();
            try { rows.forEachRemaining(quad -> {
                if (!quad.getGraph().equals(CONTROL)) f.data.add(new Quad(quad.getGraph(), quad.getSubject(), quad.getPredicate(),
                    quad.getObject().equals(NodeFactory.createLiteralString("test")) ? NodeFactory.createLiteralString(NATIVE_EPOCH) : quad.getObject()));
            }); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            f.data.commit();
        } finally { f.data.end(); seed.end(); seed.close(); }
    }
    private record CancellationSnapshot(Set<Quad> rdf, List<String> documents, long generation, Map<String, Object> proof) {}
    private static CancellationSnapshot cancellationSnapshot(ContentFixture f) throws Exception {
        List<String> documents = new java.util.ArrayList<>();
        try (var reader = DirectoryReader.open(f.index.getDirectory())) {
            var hits = new IndexSearcher(reader).search(new org.apache.lucene.search.MatchAllDocsQuery(), 100);
            assertTrue(hits.totalHits.value() < 100);
            for (var hit : hits.scoreDocs) {
                var document = reader.storedFields().document(hit.doc);
                Map<String, List<String>> fields = new java.util.TreeMap<>();
                for (var field : document.getFields()) fields.put(field.name(), List.of(document.getValues(field.name())));
                documents.add(fields.toString());
            }
        }
        documents.sort(String::compareTo);
        Set<Quad> rdf = f.graphSnapshot();
        f.data.begin(ReadWrite.READ);
        try {
            var proof = SearchDeltaJournal.qualifiedProof(f.data, 0, Long.MAX_VALUE - 1);
            assertEquals(proof.toString(), true, proof.get("available"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID);
            return new CancellationSnapshot(rdf, List.copyOf(documents), f.committedGeneration(), Map.copyOf(proof));
        } finally { f.data.end(); }
    }
    /** Cancellation is injected into the worker's real guard or after a real
     * physical copy; the production classes expose no test hook. */
    private static final class CancellationWorker extends Thread {
        final ContentFixture fixture; final DeliveryMode mode; final CancellationPoint point; final boolean expire;
        final long deadline; final int priorJournalEntries;
        Map<String, Object> result; Throwable failure; boolean fired, interruptedAtExit; long commits;
        CancellationWorker(ContentFixture fixture, DeliveryMode mode, CancellationPoint point, boolean expire) {
            super("native-delivery-cancellation");
            this.fixture = fixture; this.mode = mode; this.point = point; this.expire = expire;
            deadline = System.nanoTime() + (expire ? 3_000_000_000L : 30_000_000_000L);
            priorJournalEntries = fixture.journalEntriesWritten;
        }
        void cancelAtSeam() {
            fired = true;
            if (expire) while (System.nanoTime() < deadline)
                java.util.concurrent.locks.LockSupport.parkNanos(Math.max(1, deadline - System.nanoTime()));
            else super.interrupt();
        }
        void afterCopy(Quad quad) {
            if (fired || point != CancellationPoint.COPY) return;
            boolean atCopy = switch (mode) {
                case ORDINARY -> quad.getGraph().equals(PUBLIC) && quad.getPredicate().equals(BODY)
                    && quad.getObject().equals(NodeFactory.createLiteralLang("replacement source", "en"));
                case SLIM -> Quad.isDefaultGraph(quad.getGraph()) && quad.getSubject().equals(NodeFactory.createURI(SlimCommandTest.COMPONENT))
                    && quad.getPredicate().equals(NodeFactory.createURI("https://schema.org/name"));
                case BULK -> quad.getGraph().equals(NodeFactory.createURI(CommandPolicy.CURRENT))
                    && quad.getPredicate().equals(NodeFactory.createURI("http://www.w3.org/2000/01/rdf-schema#label"));
            };
            if (atCopy) cancelAtSeam();
        }
        @Override public boolean isInterrupted() {
            if (!fired && point == CancellationPoint.PRECOMMIT && fixture.journalEntriesWritten > priorJournalEntries
                && StackWalker.getInstance().walk(frames -> frames.skip(1).findFirst().map(frame ->
                    frame.getClassName().equals(CommandService.class.getName())
                    && frame.getMethodName().equals(mode == DeliveryMode.BULK ? "runBulk" : "runSerialized")).orElse(false))) cancelAtSeam();
            return super.isInterrupted();
        }
        @Override public void run() {
            try (var work = new CommandWork()) {
                try {
                    result = switch (mode) {
                        case ORDINARY -> fixture.deliver(2, "replacement source", "en", deadline);
                        // Slim's closed metadata envelope copies edition facts,
                        // retaining the already admitted Content body and source.
                        case SLIM -> fixture.service.runSlim(fixture.data, SlimCommandTest.RECEIPT, SlimCommandTest.DIGEST,
                            SlimCommandTest.update(SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 1)
                                .replace("\"test\"", "\"" + NATIVE_EPOCH + "\"")
                                .replace("rv:routingEpoch \"0\"", "rv:routingEpoch \"routing\""),
                            new CommandService.Slim(SlimCommandTest.PAYLOAD, SlimCommandTest.COMPONENT, SlimCommandTest.NEW),
                            SlimCommandTest.validations(fixture.profiles, SlimCommandTest.NEW), deadline);
                        case BULK -> fixture.service.runBulk(fixture.data, List.of(catalogueItem(fixture, 1), catalogueItem(fixture, 2)), deadline);
                    };
                } finally {
                    for (String counter : work.counters().split(",")) if (counter.startsWith("durable_commits="))
                        commits = Long.parseLong(counter.substring("durable_commits=".length()));
                }
            } catch (Throwable thrown) { failure = thrown; }
            finally { interruptedAtExit = super.isInterrupted(); Thread.interrupted(); }
        }
    }
    private static CancellationWorker cancellationRun(ContentFixture f, DeliveryMode mode, CancellationPoint point, boolean expire) throws Exception {
        var worker = new CancellationWorker(f, mode, point, expire);
        worker.start(); worker.join(20_000);
        assertFalse("native cancellation did not finish", worker.isAlive());
        if (worker.failure != null) throw new AssertionError("native cancellation worker failed", worker.failure);
        assertNotNull(worker.result); return worker;
    }
    private static void cancellationOutcome(DeliveryMode mode, CancellationWorker worker, String expected) {
        if (mode != DeliveryMode.BULK) assertEquals(worker.result.toString(), expected, worker.result.get("status"));
        else {
            var items = (List<?>) worker.result.get("items"); assertNotNull(items); assertEquals(2, items.size());
            for (Object item : items) assertEquals(worker.result.toString(), expected, ((Map<?, ?>) item).get("status"));
            if (worker.result.containsKey("status")) assertEquals(expected, worker.result.get("status"));
        }
    }
    private static void cancellationAcrossWriters(CancellationPoint point) throws Exception {
        for (DeliveryMode mode : DeliveryMode.values()) try (var f = new ContentFixture()) {
            if (mode == DeliveryMode.SLIM) seedSlim(f);
            assertEquals("committed", f.deliver(1, "committed source", "en").get("status"));
            var before = cancellationSnapshot(f);
            for (boolean expire : List.of(true, false)) {
                var stopped = cancellationRun(f, mode, point, expire);
                assertTrue(mode + " did not reach " + point + ": " + stopped.result, stopped.fired);
                cancellationOutcome(mode, stopped, "deadline"); assertEquals(0, stopped.commits);
                if (!expire) assertTrue(stopped.interruptedAtExit);
                assertEquals("cancelled native writer changed RDF, receipt/stream, journal, body or source proof", before, cancellationSnapshot(f));
            }
            var retry = cancellationRun(f, mode, CancellationPoint.NONE, false);
            cancellationOutcome(mode, retry, "committed"); assertEquals(1, retry.commits);
            var committed = cancellationSnapshot(f);
            var replay = cancellationRun(f, mode, CancellationPoint.NONE, false);
            cancellationOutcome(mode, replay, "committed");
            assertEquals("intact receipt replay must not publish another physical commit", 0, replay.commits);
            assertEquals("lost acknowledgement replay duplicated native facts or source delivery", committed, cancellationSnapshot(f));
        }
    }
    @Test(timeout = 90_000) public void nativePhysicalCopiesCancelAcrossOrdinarySlimAndCatalogueBulkWriters() throws Exception {
        cancellationAcrossWriters(CancellationPoint.COPY);
    }
    @Test(timeout = 90_000) public void nativeFinalPrecommitCancellationRollsBackEveryBulkOutcomeAndKeepsContentProof() throws Exception {
        cancellationAcrossWriters(CancellationPoint.PRECOMMIT);
    }

    @Test public void nativeContentDeliveryReplacesOneBodyAndRetainsRdfWithConfiguredCjkQueries() throws Exception {
        try (var f = new ContentFixture()) {
            var first = f.deliver(1, "old selected body", "en");
            assertEquals(first.toString(), "committed", first.get("status"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            int originalPopulation = f.population();
            var next = f.deliver(2, "魔法禁書目錄 東京 alpha beta", "zh-Hant");
            assertEquals(next.toString(), "committed", next.get("status"));
            assertEquals(originalPopulation, f.population());
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            f.data.begin(ReadWrite.READ);
            try {
                assertTrue(f.data.contains(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), BODY,
                    NodeFactory.createLiteralLang("魔法禁書目錄 東京 alpha beta", "zh-Hant")));
                assertTrue(f.data.contains(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), property("revision"),
                    NodeFactory.createURI(ContentFixture.REVISION)));
                assertTrue(FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID) > 0);
                var cjk = f.filtered.query(BODY, "魔法禁書", CommandPolicy.PUBLIC_SEARCH, null, 64);
                assertEquals(1, cjk.size());
                assertEquals("zh-Hant", cjk.getFirst().getLiteral().getLiteralLanguage());
                assertEquals(1, f.filtered.query(BODY, "\"alpha beta\"", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
                assertFalse(f.filtered.rankMetadataMissing());
                assertEquals(ContentFixture.UNIT_ID, f.filtered.ranked(BODY, "alpha beta", 64, null).hits().getFirst().id());
                try (var query = org.apache.jena.query.QueryExecution.create(
                    "PREFIX text: <http://jena.apache.org/text#> PREFIX rv: <" + RV + "> "
                        + "ASK { GRAPH <" + CommandPolicy.PUBLIC_SEARCH + "> { <" + ContentFixture.UNIT_ID
                        + "> text:query (rv:searchBody 'alpha') } }", DatasetFactory.wrap(f.data))) {
                    assertTrue(query.execAsk());
                }
                CommandModule.registerTextAssembler();
                // ARQ expressions can receive the base TDB dataset while the
                // assembler's merged context supplies the same native index.
                try (var query = org.apache.jena.query.QueryExecution.create(
                    "PREFIX rv: <" + RV + "> SELECT ?population WHERE {"
                        + " BIND(rv:publicTextInventory() AS ?population) }", DatasetFactory.wrap(f.storage))) {
                    query.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, f.filtered);
                    var rows = query.execSelect();
                    assertTrue(rows.hasNext());
                    var row = rows.next();
                    assertTrue("base-dataset inventory must verify the receipt-bound body", row.contains("population"));
                    assertEquals(1, row.getLiteral("population").getLong());
                    assertFalse(rows.hasNext());
                    assertTrue(f.storage.isInTransaction());
                }
                assertTrue(f.filtered.query(BODY, "old", CommandPolicy.PUBLIC_SEARCH, null, 64).isEmpty());
                assertEquals(true, SearchDeltaJournal.proof(f.data, 0, 4).get("available"));
                var qualified = SearchDeltaJournal.qualifiedProof(f.data, 0, 4);
                assertEquals(qualified.toString(), true, qualified.get("available"));
                assertEquals("1", qualified.get("qualifiedPopulation"));
            } finally { f.data.end(); }
        }
    }

    @Test public void lostAcknowledgementReplayRepairsMissingCommittedDocumentAndRefusesChangedSourcePins() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "selected source", "en");
            assertEquals(result.toString(), "committed", result.get("status"));
            f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit();
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            f.reopen();
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 2).get("available"));
            assertSameReceipt(result, f.deliver(1, "selected source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            assertEquals("2", SearchDeltaJournal.proof(f.data, -1, 4).get("ordinal"));
            f.mutate(CommandPolicy.PUBLIC_SEARCH, ContentFixture.UNIT_ID, "language", NodeFactory.createLiteralString("fr"));
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 4).get("available"));
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "selected source", "en"));
            f.mutate(CommandPolicy.PUBLIC_SEARCH, ContentFixture.UNIT_ID, "language", NodeFactory.createLiteralString("en"));
            f.mutate(CommandPolicy.REVISIONS, ContentFixture.PUBLICATION, "ownerDataEpoch", null);
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "selected source", "en"));
            f.mutate(CommandPolicy.REVISIONS, ContentFixture.PUBLICATION, "ownerDataEpoch",
                NodeFactory.createLiteralString("00000000-0000-4000-8000-000000000002"));
            f.mutate(CommandPolicy.REVISIONS, f.projection(1), "modelRevision", NodeFactory.createURI("urn:test:wrong-recipe"));
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "selected source", "en"));
            f.mutate(CommandPolicy.REVISIONS, f.projection(1), "modelRevision", NodeFactory.createURI(ContentFixture.MODEL));
            f.mutate(CommandPolicy.REVISIONS, ContentFixture.PUBLICATION, "byteDigest", NodeFactory.createLiteralString("c".repeat(64)));
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 4).get("available"));
            assertThrows(RuntimeException.class, () -> f.deliver(1, "selected source", "en"));
            f.mutate(CommandPolicy.REVISIONS, ContentFixture.PUBLICATION, "byteDigest", NodeFactory.createLiteralString("b".repeat(64)));
            f.mutate(CommandPolicy.CURRENT, ContentFixture.VARIANT, "contentPublicationHead", NodeFactory.createURI("urn:test:other-publication"));
            assertThrows(RuntimeException.class, () -> f.deliver(1, "selected source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
        }
    }

    @Test public void publicationHeadCanMoveBeforeProjectionWithoutCertifyingOrReplacingOldBody() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "selected source", "en");
            assertEquals(result.toString(), "committed", result.get("status"));
            Node current = NodeFactory.createURI(CommandPolicy.CURRENT), revisions = NodeFactory.createURI(CommandPolicy.REVISIONS);
            Node variant = NodeFactory.createURI(ContentFixture.VARIANT), previous = NodeFactory.createURI(ContentFixture.PUBLICATION);
            Node next = NodeFactory.createURI("urn:test:content:next-publication");
            String oldSource, oldDigest;
            try (var reader = DirectoryReader.open(f.index.getDirectory())) {
                var found = new IndexSearcher(reader).search(new TermQuery(new Term("uri", ContentFixture.UNIT_ID)), 2);
                assertEquals(1, found.scoreDocs.length);
                var document = reader.storedFields().document(found.scoreDocs[0].doc);
                oldSource = document.get("externalTextSource"); oldDigest = document.get("externalTextDigest");
            }
            f.data.begin(ReadWrite.WRITE);
            try {
                var capture = new SearchDeltaJournal.Capture(f.data);
                // A retained new publication may precede its asynchronous search projection.
                for (var quad : org.apache.jena.atlas.iterator.Iter.toList(f.data.find(revisions, previous, Node.ANY, Node.ANY)))
                    f.data.add(revisions, next, quad.getPredicate(), quad.getObject());
                capture.observed().delete(current, variant, property("contentPublicationHead"), previous);
                capture.observed().add(current, variant, property("contentPublicationHead"), next);
                SearchDeltaJournal.append(f.data, capture, 4); f.data.commit();
            } finally { f.data.end(); }
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            try (var reader = DirectoryReader.open(f.index.getDirectory())) {
                var found = new IndexSearcher(reader).search(new TermQuery(new Term("uri", ContentFixture.UNIT_ID)), 2);
                var document = reader.storedFields().document(found.scoreDocs[0].doc);
                assertEquals(oldSource, document.get("externalTextSource"));
                assertEquals(oldDigest, document.get("externalTextDigest"));
            }
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 4).get("available"));
            assertEquals(false, SearchDeltaJournal.qualifiedProof(f.data, 1, 4).get("available"));
            SearchDeltaJournal.stopRecovery(f.data);
            assertThrows(RuntimeException.class, () -> f.deliver(1, "selected source", "en"));
            f.data.begin(ReadWrite.WRITE);
            try {
                var capture = new SearchDeltaJournal.Capture(f.data);
                capture.observed().delete(current, variant, property("contentPublicationHead"), next);
                capture.observed().add(current, variant, property("contentPublicationHead"), previous);
                SearchDeltaJournal.append(f.data, capture, 6); f.data.commit();
            } finally { f.data.end(); }
            assertTrue(SearchDeltaJournal.qualifyAtStartup(f.data));
            f.data.begin(ReadWrite.READ);
            try {
                assertTrue(f.data.contains(current, variant, property("contentPublicationHead"), previous));
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID);
                assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 6).get("available"));
                var qualified = SearchDeltaJournal.qualifiedProof(f.data, 3, 6);
                assertEquals(qualified.toString(), true, qualified.get("available"));
                assertEquals("1", qualified.get("qualifiedPopulation"));
            } finally { f.data.end(); }
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
        }
    }

    @Test public void nativeContentAbortAndReopenKeepSourceAndBodyTogether() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "committed source", "en");
            assertEquals(result.toString(), "committed", result.get("status"));
            f.data.begin(ReadWrite.WRITE);
            try {
                var capture = new SearchDeltaJournal.Capture(f.data);
                capture.observed().delete(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), BODY,
                    NodeFactory.createLiteralLang("committed source", "en"));
                capture.observed().add(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), BODY,
                    NodeFactory.createLiteralLang("aborted replacement", "en"));
                SearchDeltaJournal.append(f.data, capture, 4);
                f.data.abort();
            } finally { f.data.end(); }
            f.reopen();
            f.data.begin(ReadWrite.READ);
            try {
                assertTrue(f.data.contains(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), BODY,
                    NodeFactory.createLiteralLang("committed source", "en")));
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID);
                assertEquals("1", SearchDeltaJournal.proof(f.data, 0, 2).get("ordinal"));
                assertTrue(f.filtered.query(BODY, "aborted", CommandPolicy.PUBLIC_SEARCH, null, 64).isEmpty());
            } finally { f.data.end(); }
            assertSameReceipt(result, f.deliver(1, "committed source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
        }
    }

    /** Exit between the two existing stores' commits, without a recovery hook. */
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 2 || !arguments[0].equals("crash-after-text-commit"))
            throw new IllegalArgumentException("expected bounded native crash fixture");
        var fixture = new ContentFixture(Path.of(arguments[1]));
        fixture.data.begin(ReadWrite.WRITE);
        var capture = new SearchDeltaJournal.Capture(fixture.data);
        Node unit = NodeFactory.createURI(ContentFixture.UNIT_ID);
        capture.observed().delete(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("committed source", "en"));
        capture.observed().add(PUBLIC, unit, BODY, NodeFactory.createLiteralLang("crash replacement", "en"));
        SearchDeltaJournal.append(fixture.data, capture, 4);
        fixture.index.commit();
        Runtime.getRuntime().halt(73);
    }

    @Test public void processCrashBetweenTextAndGraphCommitRepairsOnlyFromRetainedSource() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "committed source", "en");
            assertEquals(result.toString(), "committed", result.get("status"));
            f.closeForCrash();
            var crash = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                SearchDeltaJournalTest.class.getName(), "crash-after-text-commit", f.root.toAbsolutePath().toString())
                .redirectErrorStream(true).redirectOutput(f.root.resolve("crash-child.log").toFile()).start();
            boolean exited = crash.waitFor(30, java.util.concurrent.TimeUnit.SECONDS);
            if (!exited) { crash.destroyForcibly(); crash.waitFor(5, java.util.concurrent.TimeUnit.SECONDS); }
            assertTrue("bounded native crash child timed out", exited);
            assertEquals(Files.readString(f.root.resolve("crash-child.log")), 73, crash.exitValue());
            f.open();
            f.data.begin(ReadWrite.READ);
            try {
                assertTrue(f.data.contains(PUBLIC, NodeFactory.createURI(ContentFixture.UNIT_ID), BODY,
                    NodeFactory.createLiteralLang("committed source", "en")));
                assertEquals("1", SearchDeltaJournal.proof(f.data, -1, 2).get("ordinal"));
                assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 2).get("available"));
                assertEquals(1, f.filtered.query(BODY, "crash", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
            } finally { f.data.end(); }
            assertSameReceipt(result, f.deliver(1, "committed source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            assertEquals(true, SearchDeltaJournal.proof(f.data, 1, 4).get("available"));
            f.data.begin(ReadWrite.READ);
            try { FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID);
                assertTrue(f.filtered.query(BODY, "crash", CommandPolicy.PUBLIC_SEARCH, null, 64).isEmpty());
            } finally { f.data.end(); }
        }
    }

    @Test public void replayRepairCannotCommitAfterDeadlineOrInterrupt() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "committed source", "en");
            assertEquals(result.toString(), "committed", result.get("status"));
            f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit();
            assertEquals("deadline", f.deliver(1, "committed source", "en", System.nanoTime() - 1).get("status"));
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            try {
                Thread.currentThread().interrupt();
                assertEquals("deadline", f.deliver(1, "committed source", "en").get("status"));
            } finally { Thread.interrupted(); }
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            assertEquals("1", SearchDeltaJournal.proof(f.data, -1, 6).get("ordinal"));
            assertSameReceipt(result, f.deliver(1, "committed source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
        }
    }

    @Test public void bodyReplacementAndEmptyErasurePreserveGrowingUnrelatedPhysicalDocuments() throws Exception {
        try (var f = new ContentFixture()) {
            assertEquals("committed", f.deliver(1, "retained source", "en").get("status"));
            for (int population : List.of(12, 128)) {
                f.data.begin(ReadWrite.WRITE);
                try {
                    for (int i = population == 12 ? 0 : 12; i < population; i++) {
                        for (String field : List.of("publicTitle", "privateBody", "occurrenceLabel")) {
                            String id = (field.equals("publicTitle") ? PublicNameProjection.PREFIX : "urn:test:preserved:" + field + ":") + i;
                            Entity entity = new Entity(id, field.equals("privateBody") ? CommandPolicy.PRIVATE_SEARCH
                                : field.equals("occurrenceLabel") ? CommandPolicy.CURRENT : CommandPolicy.PUBLIC_SEARCH, "en", null);
                            entity.put(field, "unrelated literal " + i); f.index.addEntity(entity);
                        }
                    }
                    f.data.commit();
                } finally { f.data.end(); }
                int before = f.population();
                assertEquals("committed", f.deliver(population, "replacement " + population, "en").get("status"));
                assertEquals(before, f.population());
                assertEquals(1, f.documents(ContentFixture.UNIT_ID));
                assertEquals(1, f.documents(PublicNameProjection.PREFIX + (population - 1)));
                assertEquals(1, f.documents("urn:test:preserved:privateBody:" + (population - 1)));
                assertEquals(1, f.documents("urn:test:preserved:occurrenceLabel:" + (population - 1)));
            }
            int beforeErasure = f.population();
            f.data.begin(ReadWrite.WRITE);
            try {
                var capture = new SearchDeltaJournal.Capture(f.data);
                var quads = org.apache.jena.atlas.iterator.Iter.toList(f.data.find(PUBLIC,
                    NodeFactory.createURI(ContentFixture.UNIT_ID), Node.ANY, Node.ANY));
                for (var quad : quads) capture.observed().delete(quad);
                f.data.add(NodeFactory.createURI(CommandPolicy.REVISIONS), NodeFactory.createURI(ContentFixture.REVISION),
                    RDF.type.asNode(), property("ErasedRevision"));
                SearchDeltaJournal.append(f.data, capture, 8); f.data.commit();
            } finally { f.data.end(); }
            assertEquals(beforeErasure - 1, f.population());
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            f.data.begin(ReadWrite.READ);
            try {
                assertNull(FilteredGraphTextIndex.contentBodySource(f.data, ContentFixture.UNIT_ID));
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID);
                assertEquals(true, SearchDeltaJournal.proof(f.data, 0, 8).get("available"));
                assertTrue(f.data.contains(NodeFactory.createURI(CommandPolicy.REVISIONS),
                    NodeFactory.createURI(ContentFixture.PUBLICATION), property("contentRevision"),
                    NodeFactory.createURI(ContentFixture.REVISION)));
            } finally { f.data.end(); }
        }
    }

    @Test(timeout = 90_000) public void trimmedContentJournalAllowsIntactReplayButNeverInfersRepairEvidence() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "retained source", "en");
            assertEquals("committed", result.get("status"));
            for (int i = 0; i < SearchDeltaJournal.MAX_ENTRIES; i++) {
                f.data.begin(ReadWrite.WRITE);
                try { SearchDeltaJournal.append(f.data, new SearchDeltaJournal.Capture(f.data), 2); f.data.commit(); }
                finally { f.data.end(); }
            }
            f.data.begin(ReadWrite.READ);
            try {
                assertFalse(f.data.contains(NodeFactory.createURI("urn:rezics:graph:search-delta"), Node.ANY,
                    property("searchDeltaContentSource"), Node.ANY));
                assertTrue(f.data.contains(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(f.receipt(1)),
                    property("searchDeltaContentSource"), Node.ANY));
            } finally { f.data.end(); }
            assertSameReceipt(result, f.deliver(1, "retained source", "en"));
            f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit();
            Set<Quad> missingGraph = f.graphSnapshot(); long missingGeneration = f.committedGeneration();
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "retained source", "en"));
            assertEquals(missingGraph, f.graphSnapshot()); assertEquals(missingGeneration, f.committedGeneration());
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            f.legacyBody("corrupt physical body", "en");
            Set<Quad> corruptGraph = f.graphSnapshot(); long corruptGeneration = f.committedGeneration();
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "retained source", "en"));
            assertEquals(corruptGraph, f.graphSnapshot()); assertEquals(corruptGeneration, f.committedGeneration());
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
            assertEquals("65", SearchDeltaJournal.proof(f.data, -1, 8).get("ordinal"));
        }
    }

    @Test(timeout = 90_000) public void originalReceiptSourceCannotBeInferredFromAnIntactCurrentDocument() throws Exception {
        try (var f = new ContentFixture()) {
            assertEquals("committed", f.deliver(1, "retained source", "en").get("status"));
            for (Node source : java.util.Arrays.asList(null, NodeFactory.createLiteralString("corrupt original source"))) {
                f.mutate(CommandPolicy.RECEIPTS, f.receipt(1), "searchDeltaContentSource", source);
                Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
                assertThrows(IllegalStateException.class, () -> f.deliver(1, "retained source", "en"));
                assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
                f.data.begin(ReadWrite.READ);
                try { FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID); }
                finally { f.data.end(); }
            }
        }
    }

    @Test(timeout = 90_000) public void repairStartedInNativeWriterRollsBackAtFinalDeadlineInterruptAndFailure() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "committed source", "en");
            assertEquals("committed", result.get("status"));
            f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit();
            Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
            for (String stop : List.of("deadline", "interrupt", "failure")) {
                int writes = f.journalSourceWrites;
                long deadline = System.nanoTime() + 1_000_000_000L;
                f.afterJournalSource = () -> {
                    f.assertPendingRepair();
                    if (stop.equals("interrupt")) Thread.currentThread().interrupt();
                    else if (stop.equals("failure")) throw new IllegalStateException("injected post-repair journal failure");
                    else while (System.nanoTime() <= deadline)
                        java.util.concurrent.locks.LockSupport.parkNanos(Math.max(1L, deadline - System.nanoTime() + 1_000_000L));
                };
                try {
                    if (stop.equals("failure")) assertThrows(IllegalStateException.class,
                        () -> f.deliver(1, "committed source", "en", deadline));
                    else {
                        assertEquals("deadline", f.deliver(1, "committed source", "en", deadline).get("status"));
                        if (stop.equals("interrupt")) assertTrue(Thread.currentThread().isInterrupted());
                    }
                } finally { Thread.interrupted(); f.afterJournalSource = null; }
                assertEquals("repair source was written before final refusal", writes + 1, f.journalSourceWrites);
                assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
                assertEquals(0, f.documents(ContentFixture.UNIT_ID));
                assertEquals("1", SearchDeltaJournal.proof(f.data, -1, 8).get("ordinal"));
            }
            assertSameReceipt(result, f.deliver(1, "committed source", "en"));
            assertEquals(1, f.documents(ContentFixture.UNIT_ID));
        }
    }

    @Test(timeout = 90_000) public void populatedLegacyRankDocumentsRequireFreshSourceAdmittedRelayAndAtomicTransition() throws Exception {
        try (var f = new ContentFixture()) {
            String body = "魔法禁書目錄 東京 alpha beta", language = "zh-Hant";
            String nextUnit = "urn:rezics:content:match-unit:" + "b".repeat(64);
            f.data.begin(ReadWrite.WRITE);
            try { UpdateAction.parseExecute(f.update(1, body, language), DatasetFactory.wrap(f.data)); f.data.commit(); }
            finally { f.data.end(); }
            f.legacyBody(body, language);
            f.data.begin(ReadWrite.WRITE);
            try {
                for (String field : List.of("publicTitle", "privateBody", "occurrenceLabel")) {
                    String id = field.equals("publicTitle") ? PublicNameProjection.PREFIX + "legacy-preserved" : "urn:test:legacy:" + field;
                    Entity entity = new Entity(id, field.equals("privateBody") ? CommandPolicy.PRIVATE_SEARCH
                        : field.equals("occurrenceLabel") ? CommandPolicy.CURRENT : CommandPolicy.PUBLIC_SEARCH, "en", null);
                    entity.put(field, "preserved legacy literal"); f.index.addEntity(entity);
                }
                f.data.commit();
            } finally { f.data.end(); }
            TextEntityDocuments.Source selectedSource;
            f.data.begin(ReadWrite.READ);
            try { selectedSource = FilteredGraphTextIndex.contentBodySource(f.data, ContentFixture.UNIT_ID); }
            finally { f.data.end(); }
            assertNotNull(selectedSource);
            assertFalse("rank-v1 alone cannot detect the populated legacy transition", f.filtered.rankMetadataMissing());
            assertFalse(SearchDeltaJournal.qualifyAtStartup(f.data));
            SearchDeltaJournal.stopRecovery(f.data);
            Set<Quad> legacy = f.graphSnapshot(); long generation = f.committedGeneration();
            assertThrows(IllegalStateException.class, () -> f.deliver(1, body, language));
            assertEquals(legacy, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
            for (String stop : List.of("failure", "interrupt")) {
                f.afterJournalSource = () -> {
                    if (stop.equals("failure")) throw new IllegalStateException("injected legacy transition failure");
                    Thread.currentThread().interrupt();
                };
                try {
                    if (stop.equals("failure")) assertThrows(IllegalStateException.class,
                        () -> f.deliverUnit(2, nextUnit, body, language, System.nanoTime() + 30_000_000_000L));
                    else {
                        assertEquals("deadline", f.deliverUnit(2, nextUnit, body, language,
                            System.nanoTime() + 30_000_000_000L).get("status"));
                        assertTrue(Thread.currentThread().isInterrupted());
                    }
                } finally { Thread.interrupted(); f.afterJournalSource = null; }
                assertEquals(legacy, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
                assertEquals(1, f.documents(ContentFixture.UNIT_ID)); assertEquals(0, f.documents(nextUnit));
            }
            var admitted = f.deliverUnit(2, nextUnit, body, language, System.nanoTime() + 30_000_000_000L);
            assertEquals(admitted.toString(), "committed", admitted.get("status"));
            assertEquals(0, f.documents(ContentFixture.UNIT_ID)); assertEquals(1, f.documents(nextUnit));
            for (String field : List.of("publicTitle", "privateBody", "occurrenceLabel"))
                assertEquals(1, f.documents(field.equals("publicTitle") ? PublicNameProjection.PREFIX + "legacy-preserved" : "urn:test:legacy:" + field));
            assertThrows(IllegalStateException.class, () -> f.deliver(1, body, language));
            assertTrue(SearchDeltaJournal.qualifyAtStartup(f.data));
            f.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, nextUnit);
                assertEquals("selected revision/digest/publication/eligibility/epoch/recipe pins remain unchanged",
                    selectedSource, FilteredGraphTextIndex.contentBodySource(f.data, nextUnit));
                assertEquals(1, f.filtered.query(BODY, "魔法禁書", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
                assertEquals(1, f.filtered.query(BODY, "\"alpha beta\"", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
                assertEquals(nextUnit, f.filtered.ranked(BODY, "alpha beta", 64, null).hits().getFirst().id());
                try (var query = org.apache.jena.query.QueryExecution.create(
                    "PREFIX text: <http://jena.apache.org/text#> PREFIX rv: <" + RV + "> ASK { GRAPH <"
                        + CommandPolicy.PUBLIC_SEARCH + "> { <" + nextUnit
                        + "> text:query (rv:searchBody 'alpha') } }", DatasetFactory.wrap(f.data))) {
                    assertTrue(query.execAsk());
                }
                assertEquals(true, SearchDeltaJournal.qualifiedProof(f.data, -1, 16).get("available"));
                assertTrue(f.data.contains(NodeFactory.createURI(CommandPolicy.REVISIONS), NodeFactory.createURI(ContentFixture.PUBLICATION),
                    property("byteDigest"), NodeFactory.createLiteralString("b".repeat(64))));
                assertFalse(f.data.contains(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(f.receipt(1)),
                    property("searchDeltaContentSource"), Node.ANY));
            } finally { f.data.end(); }
        }
    }

    @Test(timeout = 90_000) public void receiptBoundCommittedBodyReadsAndReplayDoNotNeedItsRdfCopy() throws Exception {
        try (var f = new ContentFixture()) {
            var result = f.deliver(1, "魔法禁書目錄 alpha beta", "zh-Hant");
            assertEquals("committed", result.get("status"));
            String digest = f.receiptField(1, "searchDeltaContentBodyDigest").getLiteralLexicalForm();
            try (var reader = DirectoryReader.open(f.index.getDirectory())) {
                var found = new IndexSearcher(reader).search(new TermQuery(new Term("uri", ContentFixture.UNIT_ID)), 2);
                assertEquals(digest, reader.storedFields().document(found.scoreDocs[0].doc).get("externalTextKey"));
            }
            f.removeBodyCopy(); f.rejectBodyReads = true;
            f.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID, digest);
                assertEquals(true, SearchDeltaJournal.proof(f.data, 0, 2).get("available"));
            } finally { f.data.end(); }
            assertTrue(SearchDeltaJournal.qualifyAtStartup(f.data));
            assertSameReceipt(result, f.deliver(1, "魔法禁書目錄 alpha beta", "zh-Hant"));
            for (Node outcome : java.util.Arrays.asList(null, property("Failed"))) {
                f.mutate(CommandPolicy.RECEIPTS, f.receipt(1), "outcome", outcome);
                Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
                assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 8).get("available"));
                assertThrows(IllegalStateException.class, () -> f.deliver(1, "魔法禁書目錄 alpha beta", "zh-Hant"));
                assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
            }
            f.mutate(CommandPolicy.RECEIPTS, f.receipt(1), "outcome", property("Succeeded"));
            f.storage.begin(ReadWrite.WRITE);
            try { f.storage.deleteAny(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(f.receipt(1)), RDF.type.asNode(), Node.ANY); f.storage.commit(); }
            finally { f.storage.end(); }
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 8).get("available"));
            assertThrows(IllegalStateException.class, () -> f.deliver(1, "魔法禁書目錄 alpha beta", "zh-Hant"));
            f.storage.begin(ReadWrite.WRITE);
            try { f.storage.add(NodeFactory.createURI(CommandPolicy.RECEIPTS), NodeFactory.createURI(f.receipt(1)), RDF.type.asNode(), property("OperationReceipt")); f.storage.commit(); }
            finally { f.storage.end(); }
            for (int growth : List.of(0, 256)) {
                if (growth != 0) {
                    f.storage.begin(ReadWrite.WRITE);
                    try {
                        for (int i = 0; i < growth; i++) f.storage.add(NodeFactory.createURI(CommandPolicy.RECEIPTS),
                            NodeFactory.createURI("urn:test:unrelated:receipt:" + i), property("projection"), NodeFactory.createURI("urn:test:unrelated:projection:" + i));
                        f.storage.commit();
                    } finally { f.storage.end(); }
                }
                int lookups = f.receiptProjectionLookups;
                assertEquals(true, SearchDeltaJournal.proof(f.data, 0, 8).get("available"));
                assertEquals("current receipt uses one exact projection lookup under unrelated growth", lookups + 1, f.receiptProjectionLookups);
            }
            for (String fault : List.of("head", "digest", "recipe")) {
                String graph = fault.equals("head") ? CommandPolicy.CURRENT : CommandPolicy.REVISIONS;
                String subject = fault.equals("head") ? ContentFixture.VARIANT : fault.equals("digest") ? ContentFixture.PUBLICATION : f.projection(1);
                String predicate = fault.equals("head") ? "contentPublicationHead" : fault.equals("digest") ? "byteDigest" : "modelRevision";
                Node prior = fault.equals("head") ? NodeFactory.createURI(ContentFixture.PUBLICATION)
                    : fault.equals("digest") ? NodeFactory.createLiteralString("b".repeat(64)) : NodeFactory.createURI(ContentFixture.MODEL);
                Node wrong = fault.equals("digest") ? NodeFactory.createLiteralString("c".repeat(64)) : NodeFactory.createURI("urn:test:wrong-source");
                f.mutate(graph, subject, predicate, wrong);
                Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
                assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 8).get("available"));
                assertThrows(IllegalStateException.class, () -> f.deliver(1, "魔法禁書目錄 alpha beta", "zh-Hant"));
                assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
                f.mutate(graph, subject, predicate, prior);
            }
        }
    }

    @Test(timeout = 90_000) public void trimmedReceiptBoundBodyAndSourceEvidenceNeverAcceptsWrongPhysicalDelivery() throws Exception {
        try (var f = new ContentFixture()) {
            assertEquals("committed", f.deliver(1, "retained source", "en").get("status"));
            Node originalSource = f.receiptField(1, "searchDeltaContentSource"), originalDigest = f.receiptField(1, "searchDeltaContentBodyDigest");
            f.removeBodyCopy(); f.rejectBodyReads = true;
            for (int i = 0; i < SearchDeltaJournal.MAX_ENTRIES; i++) {
                f.data.begin(ReadWrite.WRITE);
                try { SearchDeltaJournal.append(f.data, new SearchDeltaJournal.Capture(f.data), 2); f.data.commit(); }
                finally { f.data.end(); }
            }
            for (String field : List.of("searchDeltaContentSource", "searchDeltaContentBodyDigest")) {
                for (Node value : java.util.Arrays.asList(null, NodeFactory.createLiteralString("corrupt original descriptor"), NodeFactory.createLiteralString("0".repeat(64)))) {
                    f.mutate(CommandPolicy.RECEIPTS, f.receipt(1), field, value);
                    Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
                    assertThrows(IllegalStateException.class, () -> f.deliver(1, "retained source", "en"));
                    assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
                }
                f.mutate(CommandPolicy.RECEIPTS, f.receipt(1), field, field.equals("searchDeltaContentSource") ? originalSource : originalDigest);
            }
            f.data.begin(ReadWrite.READ);
            TextEntityDocuments.Source source;
            try { source = FilteredGraphTextIndex.contentBodyMetadataSource(f.data, ContentFixture.UNIT_ID); }
            finally { f.data.end(); }
            var scope = new TextEntityDocuments.Scope(ContentFixture.UNIT_ID, CommandPolicy.PUBLIC_SEARCH, "body");
            for (boolean wrongBody : List.of(true, false)) {
                var pins = wrongBody ? source : new TextEntityDocuments.Source(source.reference(), source.digest(), source.head(), source.epoch(), "wrong-recipe");
                TextEntityDocuments.replaceRankedBody(f.index, scope,
                    List.of(new TextEntityDocuments.Row(NodeFactory.createLiteralLang(wrongBody ? "wrong physical body" : "retained source", "en"), pins)),
                    ContentFixture.WORK, ContentFixture.WORK); f.index.commit();
                Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
                f.data.begin(ReadWrite.READ);
                try { assertThrows(org.apache.jena.query.text.TextIndexException.class, () ->
                    FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, ContentFixture.UNIT_ID, originalDigest.getLiteralLexicalForm())); }
                finally { f.data.end(); }
                assertThrows(IllegalStateException.class, () -> f.deliver(1, "retained source", "en"));
                assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
            }
        }
    }

    @Test(timeout = 90_000) public void missingBodyWithoutCopyRefusesReplayWhileRetainedCopySupportsFreshNativeRecovery() throws Exception {
        String body = "魔法禁書目錄 alpha beta", language = "zh-Hant";
        try (var f = new ContentFixture()) {
            assertEquals("committed", f.deliver(1, body, language).get("status"));
            Node originalSource = f.receiptField(1, "searchDeltaContentSource"), originalDigest = f.receiptField(1, "searchDeltaContentBodyDigest");
            f.removeBodyCopy(); f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit(); f.reopen();
            Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
            assertEquals(false, SearchDeltaJournal.proof(f.data, 0, 2).get("available"));
            assertThrows(IllegalStateException.class, () -> f.deliver(1, body, language));
            assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
            assertEquals(0, f.documents(ContentFixture.UNIT_ID));
            assertEquals(originalSource, f.receiptField(1, "searchDeltaContentSource"));
            assertEquals(originalDigest, f.receiptField(1, "searchDeltaContentBodyDigest"));
        }
        // Fresh native admission keeps the mandatory RDF copy. The controlled
        // removal above tests only metadata-bound read/replay prerequisites.
        try (var f = new ContentFixture()) {
            assertEquals("committed", f.deliver(1, body, language).get("status"));
            Node originalSource = f.receiptField(1, "searchDeltaContentSource"), originalDigest = f.receiptField(1, "searchDeltaContentBodyDigest");
            for (int i = 0; i < SearchDeltaJournal.MAX_ENTRIES; i++) {
                f.data.begin(ReadWrite.WRITE);
                try { SearchDeltaJournal.append(f.data, new SearchDeltaJournal.Capture(f.data), 2); f.data.commit(); }
                finally { f.data.end(); }
            }
            f.index.getIndexWriter().deleteDocuments(new Term("uri", ContentFixture.UNIT_ID)); f.index.commit(); f.reopen();
            Set<Quad> before = f.graphSnapshot(); long generation = f.committedGeneration();
            assertThrows(IllegalStateException.class, () -> f.deliver(1, body, language));
            assertEquals(before, f.graphSnapshot()); assertEquals(generation, f.committedGeneration());
            String nextUnit = "urn:rezics:content:match-unit:" + "c".repeat(64);
            var fresh = f.deliverUnit(2, nextUnit, body, language, System.nanoTime() + 30_000_000_000L);
            assertEquals(fresh.toString(), "committed", fresh.get("status"));
            assertEquals(originalSource, f.receiptField(1, "searchDeltaContentSource"));
            assertEquals(originalDigest, f.receiptField(1, "searchDeltaContentBodyDigest"));
            assertEquals(0, f.documents(ContentFixture.UNIT_ID)); assertEquals(1, f.documents(nextUnit));
            assertTrue(SearchDeltaJournal.qualifyAtStartup(f.data));
            String nextDigest = f.receiptField(2, "searchDeltaContentBodyDigest").getLiteralLexicalForm();
            f.rejectBodyReads = true;
            f.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, nextUnit, nextDigest);
                assertEquals(true, SearchDeltaJournal.qualifiedProof(f.data, -1, 6).get("available"));
                assertEquals(1, f.filtered.query(BODY, "魔法禁書", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
                assertEquals(1, f.filtered.query(BODY, "\"alpha beta\"", CommandPolicy.PUBLIC_SEARCH, null, 64).size());
                assertEquals(nextUnit, f.filtered.ranked(BODY, "alpha beta", 64, null).hits().getFirst().id());
            } finally { f.data.end(); }
        }
    }

    private static void assertSameReceipt(Map<String, Object> first, Map<String, Object> replay) {
        assertEquals(first.get("status"), replay.get("status"));
        assertEquals(first.get("position"), replay.get("position"));
        // The existing template receipt reconstructs its retained JSON into a
        // JsonObject on replay; its Java representation is not Map equality.
        assertNotNull(replay.get("templateIndex"));
        assertTrue(replay.get("templateIndex").toString().contains("urn:test:content:projection:1"));
    }
}
