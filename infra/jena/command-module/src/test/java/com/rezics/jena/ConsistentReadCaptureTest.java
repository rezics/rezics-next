package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

public class ConsistentReadCaptureTest {
    static final String BODY = "alpha beta selected passage";
    static final String UNIT = "urn:test:consistent-read:selected";
    static final String PRIVATE_UNIT = "urn:test:consistent-read:private";
    static final String GENERATION = "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111";
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node p(String name) { return uri("https://rezics.com/vocab/" + name); }
    static Node bodyPredicate(String graph) {
        return p(CommandPolicy.PRIVATE_SEARCH.equals(graph) ? "privateSearchBody" : "searchBody");
    }

    /** Real TDB snapshots and the product text wrapper, without unrelated admission fixtures. */
    static final class Fixture implements AutoCloseable {
        final Path root;
        final DatasetGraph storage;
        final TextIndexConfig config;
        final TextIndexLucene lucene;
        final FilteredGraphTextIndex filtered;
        final DatasetGraphText data;
        final CommandService service;
        final AtomicLong publicEpoch;
        final AtomicLong privateEpoch;
        long sequence;
        volatile Runnable afterPrivateRead;

        Fixture() throws Exception { this(null); }

        Fixture(Runnable beforeBegin) throws Exception {
            Files.createDirectories(Path.of(".temp"));
            root = Files.createTempDirectory(Path.of(".temp"), "consistent-read-");
            storage = TDB2Factory.connectDataset(root.resolve("tdb2").toString()).asDatasetGraph();
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.set("privateBody", p("privateSearchBody"));
            definition.setLangField("lang");
            definition.setUidField("uid");
            config = new TextIndexConfig(definition);
            config.setValueStored(true);
            config.setAnalyzer(new FilteredGraphTextAssembler.CjkBigramV2());
            lucene = new TextIndexLucene(new ByteBuffersDirectory(), config);
            filtered = new FilteredGraphTextIndex(lucene);
            data = new DatasetGraphText(storage, filtered, new TextDocProducerTriples(filtered)) {
                @Override public void begin(ReadWrite mode) {
                    if (beforeBegin != null) beforeBegin.run();
                    super.begin(mode);
                }
                @Override public void begin(org.apache.jena.query.TxnType type) {
                    if (beforeBegin != null) beforeBegin.run();
                    super.begin(type);
                }
                @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(
                    Node graph, Node subject, Node predicate, Node object) {
                    var rows = super.find(graph, subject, predicate, object);
                    pausePrivateRead(graph, subject);
                    return rows;
                }
                @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(org.apache.jena.sparql.core.Quad quad) {
                    var rows = super.find(quad);
                    pausePrivateRead(quad.getGraph(), quad.getSubject());
                    return rows;
                }
                @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                    boolean found = super.contains(graph, subject, predicate, object);
                    pausePrivateRead(graph, subject);
                    return found;
                }
                private void pausePrivateRead(Node graph, Node subject) {
                    if (!uri(CommandPolicy.PRIVATE_SEARCH).equals(graph) || !uri(PRIVATE_UNIT).equals(subject)
                        || transactionMode() != ReadWrite.READ) return;
                    Runnable action = afterPrivateRead;
                    if (action != null) { afterPrivateRead = null; action.run(); }
                }
            };
            var profiles = ProfileRegistry.load(Files.isRegularFile(Path.of("profiles/manifest.json"))
                ? Path.of("profiles") : Path.of("../../../generated/model"));
            service = new CommandService(profiles, "1".repeat(64).getBytes(),
                "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
            publicEpoch = epoch("publicSearchWriteEpoch");
            privateEpoch = epoch("privateSearchWriteEpoch");
            data.begin(ReadWrite.WRITE);
            try {
                Node control = uri(CommandPolicy.CONTROL), product = uri("urn:rezics:dataset:product");
                data.add(control, product, p("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(control, product, p("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(control, product, p("sequence"), NodeFactory.createLiteralByValue(java.math.BigInteger.ZERO,
                    org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.add(control, product, p("textIndexGeneration"), uri(GENERATION));
                data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PUBLIC_ANCHOR),
                    RDF.type.asNode(), p("SearchGraphAnchor"));
                put(data, CommandPolicy.PUBLIC_SEARCH, UNIT, BODY, "en");
                put(data, CommandPolicy.PRIVATE_SEARCH, PRIVATE_UNIT, BODY, "en");
                SearchDeltaJournal.initialize(data);
                try (var publication = SearchDeltaJournal.publicationFence()) { data.commit(); }
            } finally { data.end(); }
            assertTrue("fixture has one qualified committed generation", SearchDeltaJournal.qualify(data));
        }

        private AtomicLong epoch(String name) throws Exception {
            var field = CommandService.class.getDeclaredField(name);
            field.setAccessible(true);
            return (AtomicLong) field.get(service);
        }

        void put(DatasetGraph target, String graph, String unit, String body, String language) {
            Node g = uri(graph), subject = uri(unit);
            target.deleteAny(g, subject, Node.ANY, Node.ANY);
            target.add(g, subject, RDF.type.asNode(), p("MatchUnit"));
            target.add(g, subject, p("language"), NodeFactory.createLiteralString(language));
            target.add(g, subject, bodyPredicate(graph), language.isEmpty()
                ? NodeFactory.createLiteralString(body) : NodeFactory.createLiteralLang(body, language));
        }

        void beginWrite() {
            data.begin(ReadWrite.WRITE);
            publicEpoch.incrementAndGet();
            privateEpoch.incrementAndGet();
        }

        void append(SearchDeltaJournal.Capture journal) {
            Node control = uri(CommandPolicy.CONTROL), product = uri("urn:rezics:dataset:product");
            data.deleteAny(control, product, p("sequence"), Node.ANY);
            data.add(control, product, p("sequence"), NodeFactory.createLiteralByValue(java.math.BigInteger.valueOf(++sequence),
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            SearchDeltaJournal.append(data, journal, publicEpoch.get() + 1);
        }

        void publish() {
            service.commitPublished(data, true, true, false, false);
            long epoch = publicEpoch.incrementAndGet();
            privateEpoch.incrementAndGet();
            assertEquals(true, SearchDeltaJournal.qualifiedProof(data, -1, epoch).get("available"));
        }

        void replace(String graph, String unit, String body, String language) {
            synchronized (data) {
                beginWrite();
                try {
                    var journal = new SearchDeltaJournal.Capture(data);
                    put(journal.observed(), graph, unit, body, language);
                    append(journal);
                    publish();
                } finally { if (data.isInTransaction()) { data.abort(); data.end(); } }
            }
        }

        int hits(String graph, String phrase) {
            return filtered.query(bodyPredicate(graph), phrase, graph, null, 64).size();
        }

        boolean containsBody(String graph, String unit, String body, String language) {
            return data.contains(uri(graph), uri(unit), bodyPredicate(graph), language.isEmpty()
                ? NodeFactory.createLiteralString(body) : NodeFactory.createLiteralLang(body, language));
        }

        @Override public void close() throws Exception {
            SearchDeltaJournal.stopRecovery(data);
            if (data.isInTransaction()) { data.abort(); data.end(); }
            data.close();
            org.apache.jena.tdb2.sys.TDBInternal.expel(storage);
            config.getAnalyzer().close();
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    static void await(CountDownLatch latch) {
        try { assertTrue("concurrent test phase reached", latch.await(5, TimeUnit.SECONDS)); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
    }

    /** Publish on a separate transaction thread at the read's exact seam.
     * The enclosing test/request deadline owns cancellation; no servlet phase
     * timer may inject an assertion into an already streaming JSON response. */
    static void publishDuringRead(ExecutorService writer, Runnable publication) {
        try { writer.submit(publication).get(); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
        catch (java.util.concurrent.ExecutionException failed) { throw new AssertionError("native publication failed", failed.getCause()); }
    }

    @Test(timeout = 30_000) public void unrelatedOpenWriterDoesNotDelayOrMixTheCapturedCut() throws Exception {
        try (var fixture = new Fixture(); ExecutorService workers = Executors.newFixedThreadPool(2)) {
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var writer = workers.submit(() -> {
                synchronized (fixture.data) {
                    fixture.beginWrite();
                    try {
                        var journal = new SearchDeltaJournal.Capture(fixture.data);
                        fixture.put(journal.observed(), CommandPolicy.PUBLIC_SEARCH,
                            "urn:test:consistent-read:unrelated", "uncommitted unrelated passage", "en");
                        fixture.append(journal);
                        entered.countDown();
                        await(release);
                        fixture.publish();
                    } finally { if (fixture.data.isInTransaction()) { fixture.data.abort(); fixture.data.end(); } }
                }
            });
            try {
                await(entered);
                assertEquals(1L, fixture.publicEpoch.get());
                assertEquals(1L, fixture.privateEpoch.get());
                var read = workers.submit(() -> {
                    try (var cut = SearchDeltaJournal.captureRead(fixture.data)) {
                        assertEquals(true, cut.qualification().get("available"));
                        assertEquals(GENERATION, cut.qualification().get("generation"));
                        assertTrue(fixture.containsBody(CommandPolicy.PUBLIC_SEARCH, UNIT, BODY, "en"));
                        assertFalse(fixture.containsBody(CommandPolicy.PUBLIC_SEARCH,
                            "urn:test:consistent-read:unrelated", "uncommitted unrelated passage", "en"));
                        assertEquals(1, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "\"alpha beta\""));
                        assertEquals(0, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "uncommitted"));
                        assertEquals(1, fixture.hits(CommandPolicy.PRIVATE_SEARCH, "\"alpha beta\""));
                    }
                    return null;
                });
                read.get(2, TimeUnit.SECONDS);
                assertEquals("writer remains open until this read has completed", 1L, release.getCount());
            } finally { release.countDown(); }
            writer.get(5, TimeUnit.SECONDS);
            try (var cut = SearchDeltaJournal.captureRead(fixture.data)) {
                assertEquals(true, cut.qualification().get("available"));
                assertEquals(1, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "uncommitted"));
            }
        }
    }

    @Test(timeout = 30_000) public void laterCommitCannotChangeRdfQueriesOrNestedProofOfCapturedRead() throws Exception {
        try (var fixture = new Fixture(); ExecutorService workers = Executors.newSingleThreadExecutor()) {
            String later = "gamma delta replacement passage";
            Map<String, Object> before;
            try (var cut = SearchDeltaJournal.captureRead(fixture.data)) {
                before = Map.copyOf(cut.qualification());
                long readerGeneration = cut.reader().getIndexCommit().getGeneration();
                assertEquals(1, fixture.filtered.query(p("searchBody"), "\"alpha beta\"", null, null, 64).size());
                workers.submit(() -> fixture.replace(CommandPolicy.PUBLIC_SEARCH, UNIT, later, "en"))
                    .get(5, TimeUnit.SECONDS);
                assertEquals(readerGeneration, cut.reader().getIndexCommit().getGeneration());
                assertTrue(fixture.containsBody(CommandPolicy.PUBLIC_SEARCH, UNIT, BODY, "en"));
                assertFalse(fixture.containsBody(CommandPolicy.PUBLIC_SEARCH, UNIT, later, "en"));
                assertEquals(1, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "\"alpha beta\""));
                assertEquals(0, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "\"gamma delta\""));
                assertEquals("an unscoped text helper must borrow the same captured reader", 1,
                    fixture.filtered.query(p("searchBody"), "\"alpha beta\"", null, null, 64).size());
                assertEquals(0, fixture.filtered.query(p("searchBody"), "\"gamma delta\"", null, null, 64).size());
                var nestedProof = SearchDeltaJournal.qualifiedProof(fixture.data, -1, fixture.publicEpoch.get());
                assertEquals(true, nestedProof.get("available"));
                assertEquals(before.get("luceneGeneration"), nestedProof.get("luceneGeneration"));
                assertEquals(before.get("sequence"), nestedProof.get("sequence"));
                assertEquals(before, cut.qualification());
                assertEquals("nested queries must not close the captured reader", 1, cut.reader().getRefCount());
            }
            assertFalse(fixture.data.isInTransaction());
            try (var next = SearchDeltaJournal.captureRead(fixture.data)) {
                assertEquals(true, next.qualification().get("available"));
                assertNotEquals(before.get("luceneGeneration"), next.qualification().get("luceneGeneration"));
                assertTrue(fixture.containsBody(CommandPolicy.PUBLIC_SEARCH, UNIT, later, "en"));
                assertEquals(0, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "\"alpha beta\""));
                assertEquals(1, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "\"gamma delta\""));
            }
        }
    }

    @Test public void qualifiedReplayUsesItsCapturedCommitInsteadOfAPreCaptureWriterEpochSample() throws Exception {
        try (var fixture = new Fixture()) {
            fixture.replace(CommandPolicy.PUBLIC_SEARCH, "urn:test:consistent-read:published-unrelated",
                "newly published unrelated passage", "en");
            assertEquals(2L, fixture.publicEpoch.get());
            try (var cut = SearchDeltaJournal.captureRead(fixture.data)) {
                assertEquals(true, cut.qualification().get("available"));
                for (long sampled : new long[] {0, 1}) {
                    var replay = SearchDeltaJournal.qualifiedProof(fixture.data, 0, sampled);
                    assertEquals("a pre-capture stale or active epoch must not refuse a committed captured delta", true,
                        replay.get("available"));
                    assertEquals(cut.qualification().get("luceneGeneration"), replay.get("luceneGeneration"));
                    assertEquals(cut.qualification().get("sequence"), replay.get("sequence"));
                    @SuppressWarnings("unchecked")
                    var deltas = (java.util.List<Map<String, Object>>) replay.get("deltas");
                    assertEquals(1, deltas.size());
                    assertEquals("2", deltas.getFirst().get("writeEpoch"));
                }
            }
            assertEquals("writer-side replay still rejects a commit beyond its claimed process epoch", false,
                SearchDeltaJournal.qualifiedProof(fixture.data, 0, 1).get("available"));
        }
    }

    @Test public void unqualifiedCaptureRemainsExplicitAndReleasesItsTransactionAndReader() throws Exception {
        try (var fixture = new Fixture()) {
            SearchDeltaJournal.dropQualification(fixture.data);
            var capture = SearchDeltaJournal.captureRead(fixture.data);
            var reader = capture.reader();
            try {
                assertEquals(false, capture.qualification().get("available"));
                assertTrue(fixture.data.isInTransaction());
                assertEquals(1, fixture.hits(CommandPolicy.PRIVATE_SEARCH, "\"alpha beta\""));
            } finally { capture.close(); }
            assertFalse(fixture.data.isInTransaction());
            assertEquals(0, reader.getRefCount());
        }
    }

    @Test(timeout = 30_000) public void nestedSourceBackedPostingProofBorrowsTheCapturedCommittedReader() throws Exception {
        try (var fixture = new Fixture(); ExecutorService workers = Executors.newSingleThreadExecutor()) {
            var scope = new TextEntityDocuments.Scope("urn:test:consistent-read:source-backed",
                CommandPolicy.PRIVATE_SEARCH, "privateBody");
            var originalSource = new TextEntityDocuments.Source("urn:test:consistent-read:source", "a".repeat(64),
                "urn:test:consistent-read:head:original", "source-epoch", "source-recipe-v1");
            var nextSource = new TextEntityDocuments.Source(originalSource.reference(), "b".repeat(64),
                "urn:test:consistent-read:head:next", originalSource.epoch(), originalSource.recipe());
            var before = java.util.List.of(new TextEntityDocuments.Row(NodeFactory.createLiteralLang(BODY, "en"), originalSource));
            var after = java.util.List.of(new TextEntityDocuments.Row(NodeFactory.createLiteralLang("gamma delta replacement", "en"), nextSource));
            try (var publication = SearchDeltaJournal.publicationFence()) {
                TextEntityDocuments.replace(fixture.lucene, scope, before);
                fixture.lucene.commit();
            }
            try (var cut = SearchDeltaJournal.captureRead(fixture.data)) {
                long generation = cut.reader().getIndexCommit().getGeneration();
                assertEquals(generation, TextEntityDocuments.verifyCommitted(fixture.lucene, scope, before));
                workers.submit(() -> {
                    try (var publication = SearchDeltaJournal.publicationFence()) {
                        TextEntityDocuments.replace(fixture.lucene, scope, after);
                        fixture.lucene.commit();
                    }
                }).get(5, TimeUnit.SECONDS);
                assertEquals("nested source proof stays on the committed reader captured before replacement",
                    generation, TextEntityDocuments.verifyCommitted(fixture.lucene, scope, before));
                assertEquals(1, cut.reader().getRefCount());
            }
            long nextGeneration = TextEntityDocuments.verifyCommitted(fixture.lucene, scope, after);
            assertTrue(nextGeneration > 0);
            assertThrows(org.apache.jena.query.text.TextIndexException.class,
                () -> TextEntityDocuments.verifyCommitted(fixture.lucene, scope, before));
        }
    }

    @Test(timeout = 30_000) public void productionQueryKeepsItsCaptureWhileLazyRowsAreWrittenToHttp() throws Exception {
        try (var fixture = new Fixture(); ExecutorService workers = Executors.newSingleThreadExecutor()) {
            String function = "urn:test:consistent-read:lazy-row";
            var functions = org.apache.jena.sparql.function.FunctionRegistry.get();
            var previous = functions.get(function);
            var published = new java.util.concurrent.atomic.AtomicBoolean();
            functions.put(function, ignored -> new org.apache.jena.sparql.function.FunctionBase1() {
                @Override public org.apache.jena.sparql.expr.NodeValue exec(org.apache.jena.sparql.expr.NodeValue row) {
                    // Row 1's padding flushes before lazy row 2 evaluates. Commit
                    // here, then read row 2 from the same request-local capture.
                    if (row.getInteger().intValueExact() == 2 && published.compareAndSet(false, true))
                        publishDuringRead(workers, () -> fixture.replace(CommandPolicy.PRIVATE_SEARCH,
                            PRIVATE_UNIT, "gamma delta replacement passage", "en"));
                    String value = fixture.hits(CommandPolicy.PRIVATE_SEARCH, "\"alpha beta\"") + ":"
                        + fixture.hits(CommandPolicy.PRIVATE_SEARCH, "\"gamma delta\"") + ":"
                        + fixture.containsBody(CommandPolicy.PRIVATE_SEARCH, PRIVATE_UNIT, BODY, "en");
                    return org.apache.jena.sparql.expr.NodeValue.makeString(value);
                }
            });
            fixture.data.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, fixture.filtered);
            var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data", fixture.data, false)
                .fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty())
                .registerOperation(org.apache.jena.fuseki.server.Operation.Query,
                    org.apache.jena.riot.WebContent.contentTypeSPARQLQuery, new QueryWorkService()).build().start();
            try {
                String padding = org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString("x".repeat(32_768)));
                String query = "SELECT ?row ?probe ?padding WHERE { VALUES ?row { 1 2 } BIND(<" + function
                    + ">(?row) AS ?probe) BIND(" + padding + " AS ?padding) }";
                var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create(
                    "http://127.0.0.1:" + server.getPort() + "/data/query"))
                    .header("Content-Type", "application/sparql-query")
                    .header("Accept", "application/sparql-results+json")
                    .timeout(java.time.Duration.ofSeconds(15))
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(query)).build();
                var received = java.net.http.HttpClient.newHttpClient().send(request,
                    java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(received.body(), 200, received.statusCode());
                assertTrue("replacement committed during lazy row evaluation", published.get());
                var rows = org.apache.jena.atlas.json.JSON.parse(received.body()).get("results").getAsObject()
                    .get("bindings").getAsArray();
                assertEquals(2, rows.size());
                for (var row : rows) assertEquals("1:0:true", row.getAsObject().get("probe").getAsObject()
                    .get("value").getAsString().value());
                assertTrue(received.body().length() > 65_536);
                // The next request on this endpoint must have its own reader, not a leaked thread-local capture.
                var next = java.net.http.HttpClient.newHttpClient().send(request,
                    java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(next.body(), 200, next.statusCode());
                var nextRows = org.apache.jena.atlas.json.JSON.parse(next.body()).get("results").getAsObject()
                    .get("bindings").getAsArray();
                assertEquals("0:1:false", nextRows.get(0).getAsObject().get("probe").getAsObject()
                    .get("value").getAsString().value());
            } finally {
                server.stop();
                if (previous == null) functions.remove(function); else functions.put(function, previous);
            }
        }
    }
}
