package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
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
import org.apache.lucene.index.Term;
import org.apache.lucene.store.FSDirectory;
import org.junit.Test;

/** Native dataset/index lifecycle tests; no container or operator rebuild. */
public class PublicTextRestartTest {
    private static final org.apache.jena.fuseki.server.Operation COMMAND = org.apache.jena.fuseki.server.Operation.alloc(
        "https://rezics.com/fuseki/command", "command", "REZICS transactional command");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product"),
        PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), UNIT = uri("urn:test:restart:unit"), BODY = p("searchBody");

    private static void awaitQualification(DatasetGraphText data, List<String> lines) throws Exception {
        // Production permits a 600-second maintenance turn and backs off
        // retries to 30 seconds. Allow another 30 seconds for dispatch and
        // the final audit, but never extend the overall bound on retries.
        long marginMs = 60_000;
        long started = System.nanoTime();
        long progressDeadline = started + TimeUnit.MILLISECONDS.toNanos(marginMs);
        long deadline = started + TimeUnit.MILLISECONDS.toNanos(
            OccurrenceTextSchema.REBUILD_DEADLINE_MS + marginMs);
        int attempts = 0, rebuilds = 0;
        long pollMs = 20;
        Map<String, Object> last;
        do {
            // Observe the maintenance owner without opening a captured read
            // or repeatedly invalidating the cut it is trying to qualify.
            last = SearchDeltaJournal.qualifiedProof(data, -1, 0);
            if (Boolean.TRUE.equals(last.get("available"))) {
                try (var capture = SearchDeltaJournal.captureRead(data)) {
                    assertEquals(true, capture.qualification().get("available"));
                }
                return;
            }
            int nextAttempts = ((Number) last.get("recoveryAttempts")).intValue();
            int nextRebuilds = ((Number) last.get("rebuildAttempts")).intValue();
            assertTrue("recovery counters must advance monotonically: " + last,
                nextAttempts >= attempts && nextRebuilds >= rebuilds);
            if (nextAttempts > attempts || nextRebuilds > rebuilds) {
                attempts = nextAttempts;
                rebuilds = nextRebuilds;
                pollMs = 20;
            }
            if (attempts == 0 && System.nanoTime() >= progressDeadline)
                fail("native recovery never started within scheduling margin: " + last + " logs=" + lines);
            long remainingMs = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (remainingMs <= 0) break;
            Thread.sleep(Math.min(pollMs, remainingMs));
            pollMs = Math.min(1_000, pollMs * 2);
        } while (System.nanoTime() < deadline);
        fail("native requalification exceeded maintenance budget plus " + marginMs
            + "ms margin: " + last + " logs=" + lines);
    }

    private static final class Fixture implements AutoCloseable {
        final Path root, marker;
        final List<String> lines = Collections.synchronizedList(new ArrayList<>());
        DatasetGraph storage;
        DatasetGraphText data;
        FilteredGraphTextIndex index;
        final boolean faultReader;
        final java.util.concurrent.atomic.AtomicBoolean failNextRead = new java.util.concurrent.atomic.AtomicBoolean();
        final java.util.concurrent.atomic.AtomicBoolean failDirectoryOnce = new java.util.concurrent.atomic.AtomicBoolean();
        Fixture() throws Exception { this(false); }
        Fixture(boolean faultReader) throws Exception {
            this.faultReader = faultReader;
            Files.createDirectories(Path.of(".temp"));
            root = Files.createTempDirectory(Path.of(".temp"), "public-text-restart-");
            marker = root.resolve("lucene.uncertain");
            SearchDeltaJournal.logged = lines::add;
            open();
            write(() -> {
                data.add(CONTROL, PRODUCT, p("dataEpoch"), NodeFactory.createLiteralString("epoch"));
                data.add(CONTROL, PRODUCT, p("routingEpoch"), NodeFactory.createLiteralString("routing"));
                data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(0, XSDDatatype.XSDinteger));
                data.add(CONTROL, PRODUCT, p("textIndexGeneration"), uri(
                    "urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
                data.add(PUBLIC, uri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), p("SearchGraphAnchor"));
                data.add(PUBLIC, UNIT, RDF.type.asNode(), p("MatchUnit"));
                data.add(PUBLIC, UNIT, BODY, NodeFactory.createLiteralLang("restarttoken selected body", "en"));
                data.add(uri("urn:test:private"), uri("urn:test:private:unit"), p("privateSearchBody"),
                    NodeFactory.createLiteralLang("privatetoken retained body", "en"));
                SearchDeltaJournal.initialize(data);
                return null;
            });
        }
        void open() throws Exception {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", BODY); definition.set("publicTitle", p("publicTitle"));
            definition.set("privateBody", p("privateSearchBody"));
            definition.setUidField("uid"); definition.setLangField("lang");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            org.apache.lucene.store.Directory directory = FSDirectory.open(root.resolve("lucene"));
            if (faultReader) directory = new org.apache.lucene.store.FilterDirectory(directory) {
                @Override public org.apache.lucene.store.IndexInput openInput(String name, org.apache.lucene.store.IOContext context)
                    throws java.io.IOException {
                    if (name.startsWith("segments_") && failNextRead.compareAndSet(true, false))
                        throw new java.io.IOException("injected committed-reader failure");
                    return super.openInput(name, context);
                }
            };
            index = new FilteredGraphTextIndex(new TextIndexLucene(directory, config) {
                @Override public org.apache.lucene.store.Directory getDirectory() {
                    if (failDirectoryOnce.getAndSet(false)) throw new IllegalStateException("injected transient index read");
                    return super.getDirectory();
                }
            });
            storage = org.apache.jena.tdb2.TDB2Factory.connectDataset(root.resolve("tdb2").toString()).asDatasetGraph();
            data = new DatasetGraphText(storage, index, new TextDocProducerTriples(index), true);
            // The production text assembler installs this query binding too.
            data.getContext().set(org.apache.jena.query.text.TextQuery.textIndex, index);
            index.bindRankData(data);
        }
        <T> T write(Supplier<T> work) {
            data.begin(ReadWrite.WRITE);
            try { T result = work.get(); data.commit(); return result; }
            finally { data.end(); }
        }
        Map<String, Object> proof() throws Exception {
            try (var capture = SearchDeltaJournal.captureRead(data)) {
                return SearchDeltaJournal.qualifiedProof(data, -1, 0);
            }
        }
        void closeStore() {
            synchronized (data) {
                SearchDeltaJournal.stopRecovery(data);
                data.close();
                org.apache.jena.tdb2.sys.TDBInternal.expel(storage);
            }
        }
        /** Terminate the writer without a clean-stop ticket, losing its process
         * baseline. Already committed text-only changes survive the reopen. */
        void crashAndReopen() throws Exception {
            SearchDeltaJournal.dropQualification(data);
            index.lucene().getIndexWriter().rollback();
            closeStore();
            Files.writeString(marker, "");
            open();
        }
        void startup() {
            var model = org.apache.jena.riot.RDFDataMgr.loadModel("fuseki-text.ttl");
            String previous = System.getProperty("rezics.profiles");
            System.setProperty("rezics.profiles", "profiles");
            try {
                var module = new CommandModule();
                module.start();
                var service = model.listResourcesWithProperty(RDF.type,
                    model.createResource("http://jena.apache.org/fuseki#Service")).nextResource();
                var dataset = service.getPropertyResourceValue(model.createProperty("http://jena.apache.org/fuseki#dataset"));
                var descriptions = new org.apache.jena.fuseki.build.DatasetDescriptionMap();
                descriptions.register(dataset.asNode(), data);
                var point = org.apache.jena.fuseki.build.FusekiConfig.buildDataAccessPoint(
                    model.getGraph(), service.asNode(), descriptions);
                assertNotNull(point);
                assertTrue(CommandService.deltaExclusive(point.getDataService()));
                module.configDataAccessPoint(point, model);
            } finally {
                if (previous == null) System.clearProperty("rezics.profiles");
                else System.setProperty("rezics.profiles", previous);
                model.close();
            }
        }
        void awaitQualification() throws Exception {
            PublicTextRestartTest.awaitQualification(data, lines);
        }
        void assertHits() {
            data.begin(ReadWrite.READ);
            try {
                assertEquals(UNIT, index.query(BODY, "restarttoken", CommandPolicy.PUBLIC_SEARCH, null, 10).getFirst().getNode());
                assertEquals(1, index.query(p("privateSearchBody"), "privatetoken", "urn:test:private", null, 10).size());
                assertTrue(index.query(BODY, "orphantoken", CommandPolicy.PUBLIC_SEARCH, null, 10).isEmpty());
            } finally { data.end(); }
        }
        org.apache.jena.fuseki.main.FusekiServer server(CommandService command) {
            return org.apache.jena.fuseki.main.FusekiServer.create().port(0).addDataset("/data", data)
                .fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty())
                .registerOperation(COMMAND, command).addEndpoint("/data", "command", COMMAND)
                .registerOperation(org.apache.jena.fuseki.server.Operation.Query,
                    org.apache.jena.riot.WebContent.contentTypeSPARQLQuery, new QueryWorkService())
                .addEndpoint("/data", "query", org.apache.jena.fuseki.server.Operation.Query).build().start();
        }
        @Override public void close() throws Exception {
            closeStore(); SearchDeltaJournal.logged = null;
            try (var paths = Files.walk(root)) {
                for (var path : paths.sorted(java.util.Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }

    @Test public void intactCrashCutQualifiesAndClearsOnlyItsOwnMarkerAfterAllStartupWrites() throws Exception {
        try (var f = new Fixture(); var other = new Fixture()) {
            f.startup(); assertEquals(true, f.proof().get("available"));
            f.crashAndReopen();
            Files.writeString(other.marker, "");
            assertTrue(SearchDeltaJournal.textIndexUncertain(f.data));
            // Construct the endpoint while fenced, as Fuseki does before startup.
            var command = new CommandService(SlimCommandTest.profiles(), "1".repeat(64).getBytes(),
                "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
            f.startup();
            assertEquals(true, f.proof().get("available"));
            assertFalse(Files.exists(f.marker));
            assertTrue("another dataset keeps its crash fence", Files.exists(other.marker));
            f.assertHits();
            f.startup(); assertEquals(true, f.proof().get("available"));
            var server = f.server(command);
            try {
                var client = HttpClient.newHttpClient();
                String endpoint = "http://127.0.0.1:" + server.getPort() + "/data/command";
                var health = client.send(HttpRequest.newBuilder(URI.create(endpoint)).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertFalse(org.apache.jena.atlas.json.JSON.parse(health.body()).get("textIndexUncertain").getAsBoolean().value());
                var delta = client.send(HttpRequest.newBuilder(URI.create(endpoint + "?deltaSince=-1")).GET().build(), HttpResponse.BodyHandlers.ofString());
                assertTrue(delta.body(), org.apache.jena.atlas.json.JSON.parse(delta.body()).get("available").getAsBoolean().value());
                var query = client.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + "/data/query"))
                    .header("Content-Type", "application/sparql-query").header("Accept", "application/sparql-results+json")
                    .header(QueryWorkService.REQUIRE_QUALIFIED_HEADER, "true")
                    .POST(HttpRequest.BodyPublishers.ofString("""
                        PREFIX text: <http://jena.apache.org/text#>
                        SELECT ?unit WHERE { GRAPH <urn:rezics:search:public> {
                          (?unit ?score ?literal) text:query (<https://rezics.com/vocab/searchBody> "restarttoken" 10)
                        } }
                        """)).build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(query.body(), 200, query.statusCode());
                assertTrue(query.body().contains(UNIT.getURI()));
                var cut = org.apache.jena.atlas.json.JSON.parse(query.headers().firstValue(QueryWorkService.READ_CUT_HEADER).orElseThrow());
                assertTrue(cut.get("qualified").getAsBoolean().value());
                assertFalse(cut.get("textIndexUncertain").getAsBoolean().value());
            } finally { server.stop(); }
        }
    }

    @Test public void missingAndOrphanedCommittedDocumentsRebuildWithoutAnotherWriterOrOperator() throws Exception {
        for (boolean missing : new boolean[] {true, false}) try (var f = new Fixture()) {
            f.startup();
            if (missing) f.index.lucene().getIndexWriter().deleteDocuments(new Term("uri", UNIT.getURI()));
            else {
                var orphan = new Entity("urn:test:restart:orphan", CommandPolicy.PUBLIC_SEARCH, "en", null);
                orphan.put("body", "orphantoken uncommitted source");
                f.data.begin(ReadWrite.READ);
                try { f.index.addEntity(orphan); }
                finally { f.data.end(); }
            }
            f.index.commit(); f.crashAndReopen();
            synchronized (f.data) {
                f.startup();
                var unavailable = f.proof();
                assertEquals(false, unavailable.get("available"));
                assertEquals("text-index-uncertain", unavailable.get("reason"));
                assertEquals("scheduled", unavailable.get("recovery"));
                assertTrue(Files.exists(f.marker));
            }
            f.awaitQualification(); f.assertHits();
            assertFalse(Files.exists(f.marker));
            assertTrue(f.lines.stream().anyMatch(line -> line.startsWith("public text rebuild completed: quads=2 elapsedMs=")));
            assertEquals("single-flight recovery", 1L,
                f.lines.stream().filter(line -> line.startsWith("public text rebuild started:")).count());
        }
    }

    @Test public void restoreHoldKeepsTheCrashFenceAndReleaseSelfQualifiesWithoutANewStartup() throws Exception {
        try (var f = new Fixture()) {
            f.write(() -> { f.data.add(CONTROL, PRODUCT, p("restoreHold"),
                NodeFactory.createLiteralByValue(false, XSDDatatype.XSDboolean)); return null; });
            f.crashAndReopen(); f.startup();
            assertEquals(false, f.proof().get("available"));
            assertTrue(Files.exists(f.marker));
            assertFalse(f.lines.stream().anyMatch(line -> line.startsWith("public text rebuild started:")));
            f.write(() -> { f.data.deleteAny(CONTROL, PRODUCT, p("restoreHold"), Node.ANY); return null; });
            f.awaitQualification(); f.assertHits();
            assertFalse(Files.exists(f.marker));
        }
    }

    @Test public void exhaustedRebuildRollsBackAndKeepsTheCrashFenceForRecovery() throws Exception {
        try (var f = new Fixture()) {
            Files.writeString(f.marker, "");
            try { OccurrenceTextSchema.rebuild(f.data, System.nanoTime() - 1); fail("expired rebuild was committed"); }
            catch (IllegalStateException expired) { assertEquals("text rebuild exceeded its maintenance budget", expired.getMessage()); }
            assertTrue(Files.exists(f.marker)); f.assertHits();
            f.startup(); assertEquals(true, f.proof().get("available"));
        }
    }

    @Test public void losingExclusiveStartupWithdrawsTheOldBaselineAndCannotClearACrashFence() throws Exception {
        try (var f = new Fixture()) {
            f.startup(); assertEquals(true, f.proof().get("available"));
            SearchDeltaJournal.revokeExclusiveStartup(f.data);
            assertEquals(false, f.proof().get("available"));
            Files.writeString(f.marker, "");
            assertFalse(SearchDeltaJournal.qualify(f.data));
            assertTrue(Files.exists(f.marker));
            assertEquals("text-index-uncertain", f.proof().get("reason"));
            f.startup(); assertEquals(true, f.proof().get("available"));
        }
    }

    @Test public void commandAndQualifiedQueryReaderFailuresScheduleTheirOwnRecovery() throws Exception {
        try (var f = new Fixture(true)) {
            f.startup();
            var command = new CommandService(SlimCommandTest.profiles(), "1".repeat(64).getBytes(),
                "2".repeat(64).getBytes(), "3".repeat(64).getBytes());
            var server = f.server(command);
            try {
                var client = HttpClient.newHttpClient();
                String base = "http://127.0.0.1:" + server.getPort() + "/data/";
                f.failNextRead.set(true);
                var delta = client.send(HttpRequest.newBuilder(URI.create(base + "command?deltaSince=-1"))
                    .GET().build(), HttpResponse.BodyHandlers.ofString());
                var unavailable = org.apache.jena.atlas.json.JSON.parse(delta.body());
                assertFalse(unavailable.get("available").getAsBoolean().value());
                assertEquals("committed-reader-unavailable", unavailable.get("reason").getAsString().value());
                assertNotEquals("waiting-for-lineage", unavailable.get("recovery").getAsString().value());
                f.awaitQualification();
                f.failNextRead.set(true);
                var query = client.send(HttpRequest.newBuilder(URI.create(base + "query"))
                    .header("Content-Type", "application/sparql-query")
                    .header(QueryWorkService.REQUIRE_QUALIFIED_HEADER, "true")
                    .POST(HttpRequest.BodyPublishers.ofString("ASK {}" )).build(), HttpResponse.BodyHandlers.ofString());
                assertEquals(query.body(), 503, query.statusCode());
                var cut = org.apache.jena.atlas.json.JSON.parse(query.headers().firstValue(QueryWorkService.READ_CUT_HEADER).orElseThrow());
                assertEquals("committed-reader-unavailable", cut.get("reason").getAsString().value());
                f.awaitQualification(); f.assertHits();
            } finally { server.stop(); }
        }
    }

    @Test public void committedContentLossRebuildsItsBodyAndRetainedSourcePinsWithoutReceiptReplay() throws Exception {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        SearchDeltaJournal.logged = lines::add;
        try (var f = new SearchDeltaJournalTest.ContentFixture()) {
            assertEquals("committed", f.deliver(1, "contentrestarttoken retained source", "en").get("status"));
            f.index.getIndexWriter().deleteDocuments(new Term("uri", SearchDeltaJournalTest.ContentFixture.UNIT_ID));
            f.index.commit(); f.reopen();
            var marker = f.root.resolve("lucene.uncertain"); Files.writeString(marker, "");
            SearchDeltaJournal.proveExclusiveStartup(f.data);
            assertFalse(SearchDeltaJournal.qualifyAtStartup(f.data));
            awaitQualification(f.data, lines);
            assertFalse(Files.exists(marker));
            f.data.begin(ReadWrite.READ);
            try {
                FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, SearchDeltaJournalTest.ContentFixture.UNIT_ID);
                assertEquals(1, f.filtered.query(BODY, "contentrestarttoken", CommandPolicy.PUBLIC_SEARCH, null, 10).size());
            } finally { f.data.end(); }
        } finally { SearchDeltaJournal.logged = null; }
    }

    @Test public void transientFenceAndBackgroundAuditFailuresRetryOnPersistentStorageWithoutRebuilding() throws Exception {
        try (var f = new Fixture()) {
            f.startup();
            var before = f.proof();
            synchronized (f.data) {
                f.failDirectoryOnce.set(true);
                SearchDeltaJournal.fenceBeforeWrite(f.data);
                assertEquals(false, SearchDeltaJournal.qualifiedProof(f.data, -1, 0).get("available"));
                f.failDirectoryOnce.set(true);
                assertFalse(SearchDeltaJournal.textIndexUncertain(f.data));
                assertEquals(false, SearchDeltaJournal.qualifiedProof(f.data, -1, 0).get("available"));
                assertTrue("diagnostics leave the transient reader failure for the audit", f.failDirectoryOnce.get());
            }
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(f.data, -1, 0).get("available"))
                && System.nanoTime() < until) Thread.sleep(20);
            var after = f.proof();
            assertEquals(f.lines.toString(), true, after.get("available"));
            assertEquals(before.get("generation"), after.get("generation"));
            assertEquals(before.get("luceneGeneration"), after.get("luceneGeneration"));
            assertFalse(f.lines.stream().anyMatch(line -> line.startsWith("public text rebuild started:")));
            f.assertHits();
        }
    }

    @Test public void unreadableIntactCrashCutRetriesWithoutRebuildingBeforeClearingItsMarker() throws Exception {
        try (var f = new Fixture()) {
            f.startup(); var before = f.proof(); f.crashAndReopen();
            synchronized (f.data) {
                f.failDirectoryOnce.set(true); f.startup();
                assertEquals(false, f.proof().get("available"));
                assertTrue(Files.exists(f.marker));
            }
            f.awaitQualification(); var after = f.proof();
            assertEquals(before.get("generation"), after.get("generation"));
            assertEquals(before.get("luceneGeneration"), after.get("luceneGeneration"));
            assertFalse(Files.exists(f.marker));
            assertFalse(f.lines.stream().anyMatch(line -> line.startsWith("public text rebuild started:")));
            f.assertHits();
        }
    }

    @Test public void transientContentVerificationFailureRetriesWithoutReplacingItsCommittedSource() throws Exception {
        List<String> lines = Collections.synchronizedList(new ArrayList<>());
        SearchDeltaJournal.logged = lines::add;
        try (var f = new SearchDeltaJournalTest.ContentFixture()) {
            assertEquals("committed", f.deliver(1, "contentretrytoken retained source", "en").get("status"));
            SearchDeltaJournal.proveExclusiveStartup(f.data);
            var before = SearchDeltaJournal.qualifiedProof(f.data, -1, 0);
            synchronized (f.data) {
                f.failReaderAt.set(2);
                SearchDeltaJournal.invalidate(f.data);
                assertEquals(false, SearchDeltaJournal.qualifiedProof(f.data, -1, 0).get("available"));
                assertEquals(2, f.failReaderAt.get());
            }
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!Boolean.TRUE.equals(SearchDeltaJournal.qualifiedProof(f.data, -1, 0).get("available"))
                && System.nanoTime() < until) Thread.sleep(20);
            var after = SearchDeltaJournal.qualifiedProof(f.data, -1, 0);
            assertEquals(after + " logs=" + lines, true, after.get("available"));
            assertEquals(0, f.failReaderAt.get());
            assertEquals(before.get("generation"), after.get("generation"));
            assertEquals(before.get("luceneGeneration"), after.get("luceneGeneration"));
            assertFalse(lines.stream().anyMatch(line -> line.startsWith("public text rebuild started:")));
            assertTrue(lines.stream().anyMatch(line -> line.startsWith("startup-audit failed: committed text reader unavailable")));
            f.data.begin(ReadWrite.READ);
            try { FilteredGraphTextIndex.verifyContentBodyCommitted(f.data, SearchDeltaJournalTest.ContentFixture.UNIT_ID); }
            finally { f.data.end(); }
        } finally { SearchDeltaJournal.logged = null; }
    }
}
