package com.rezics.jena;

import static org.junit.Assert.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiModules;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.query.QueryCancelledException;
import org.apache.jena.sparql.expr.NodeValue;
import org.apache.jena.sparql.function.FunctionBase0;
import org.apache.jena.sparql.function.FunctionRegistry;
import org.junit.Test;

/** Real servlet/filter, TDB2 and committed Lucene capture contention. These
 * native runtime cases belong to the manager's pinned prove phase. */
public class RequestReadCaptureBoundaryTest {
    private enum Entry { QUERY, DELTA, EXACT_UNIT, PREFIX, TEMPLATE }
    private enum Departure { DEADLINE, DISCONNECT }
    private static final long GRACE = TimeUnit.MILLISECONDS.toNanos(300);
    private static final ThreadLocal<Probe> CURRENT = new ThreadLocal<>();

    private static final class Probe {
        final CountDownLatch entered = new CountDownLatch(1), exited = new CountDownLatch(1);
        final AtomicInteger transactions = new AtomicInteger(), engines = new AtomicInteger();
        volatile Thread worker;
        volatile long deadline, exitedAt;
        volatile QueryCancelledException cancellation;
        volatile boolean transactionAtExit, interruptAtExit;
    }

    private static final class Fixture implements AutoCloseable {
        final ConsistentReadCaptureTest.Fixture text = new ConsistentReadCaptureTest.Fixture(() -> {
            Probe probe = CURRENT.get();
            if (probe != null) probe.transactions.incrementAndGet();
        });
        final Map<String, Probe> probes = new ConcurrentHashMap<>();
        final String function = "urn:rezics:test:capture-engine:" + java.util.UUID.randomUUID();
        final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
        final FusekiServer server;

        Fixture() throws Exception {
            // An empty, maintained prefix is a usable capture consumer too.
            text.data.begin(org.apache.jena.query.ReadWrite.WRITE);
            try {
                PublicNameProjection.rebuildPrefix(text.data);
                try (var publication = SearchDeltaJournal.publicationFence()) { text.data.commit(); }
            } finally { text.data.end(); }
            assertTrue(SearchDeltaJournal.qualify(text.data));
            FunctionRegistry.get().put(function, ignored -> new FunctionBase0() {
                @Override public NodeValue exec() {
                    Probe probe = CURRENT.get();
                    if (probe != null) probe.engines.incrementAndGet();
                    return NodeValue.makeInteger(1);
                }
            });
            var command = Operation.alloc("https://rezics.com/fuseki/command", "command", "captured read");
            server = FusekiServer.create().port(0).fusekiModules(FusekiModules.empty())
                // Keep the product's complete-writer premise: a convenience
                // read-only dataset also exposes Graph Store operations.
                .addDataset("/data", text.data)
                // Observe completion outside the operation filter: its timer,
                // interrupt and thread-local cleanup must have finished too.
                .addFilter("/*", (request, response, chain) -> {
                    Probe probe = probes.get(((jakarta.servlet.http.HttpServletRequest) request).getHeader("X-Test-Read"));
                    CURRENT.set(probe);
                    probe.worker = Thread.currentThread();
                    try { chain.doFilter(request, response); }
                    finally {
                        probe.transactionAtExit = text.data.isInTransaction();
                        probe.interruptAtExit = Thread.currentThread().isInterrupted();
                        probe.exitedAt = System.nanoTime();
                        CURRENT.remove();
                        probe.exited.countDown();
                    }
                })
                .addFilter("/*", new QueryWorkService.ReadBoundaryFilter())
                .addFilter("/*", (request, response, chain) -> {
                    Probe probe = CURRENT.get();
                    probe.deadline = QueryWorkService.ReadBoundary.deadline(Long.MAX_VALUE);
                    probe.entered.countDown();
                    try { chain.doFilter(request, response); }
                    finally {
                        try { QueryWorkService.ReadBoundary.checkCurrent(); }
                        catch (QueryCancelledException cancelled) { probe.cancellation = cancelled; }
                    }
                })
                .registerOperation(Operation.Query, org.apache.jena.riot.WebContent.contentTypeSPARQLQuery,
                    new QueryWorkService())
                .registerOperation(command, text.service).addEndpoint("/data", "command", command)
                .addEndpoint("/data", "query", Operation.Query).build().start();
        }

        CompletableFuture<HttpResponse<String>> start(Entry entry, String id, int allocation, Probe probe) {
            probes.put(id, probe);
            String query = "SELECT (<" + function + ">() AS ?value) WHERE {}";
            String body = switch (entry) {
                case QUERY -> query;
                case DELTA -> null;
                case EXACT_UNIT -> JSON.toStringFlat(CommandService.jsonObject(Map.of("exactUnitProbe", Map.of(
                    "graph", CommandPolicy.PRIVATE_SEARCH, "unit", ConsistentReadCaptureTest.PRIVATE_UNIT,
                    "body", ConsistentReadCaptureTest.BODY, "language", "en", "phrase", "alpha beta"))));
                case PREFIX -> "{\"prefixWalk\":{\"prefix\":\"absent\",\"language\":\"en\",\"pageSize\":1,\"cursor\":null}}";
                case TEMPLATE -> "{\"templateQuery\":{\"query\":\"SELECT (1 AS ?value) WHERE {}\",\"bindings\":{},\"tables\":[],\"limit\":1}}";
            };
            String path = entry == Entry.QUERY ? "query" : entry == Entry.DELTA ? "command?deltaSince=-1" : "command";
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + "/data/" + path))
                .header("X-Test-Read", id).header(QueryWorkService.READ_BUDGET_HEADER, Integer.toString(allocation))
                .header("Authorization", "Bearer " + "2".repeat(64)).timeout(Duration.ofSeconds(15));
            if (entry == Entry.QUERY) request.header(QueryWorkService.REQUIRE_QUALIFIED_HEADER, "true");
            if (body == null) request.GET();
            else request.header("Content-Type", entry == Entry.QUERY ? "application/sparql-query" : "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
            return client.sendAsync(request.build(), HttpResponse.BodyHandlers.ofString());
        }

        void assertSuccess(Entry entry, HttpResponse<String> response, Probe probe) throws Exception {
            assertEquals(response.body(), 200, response.statusCode());
            assertTrue("native filter did not finish", probe.exited.await(1, TimeUnit.SECONDS));
            assertTrue("transaction observation was not exercised", probe.transactions.get() > 0);
            assertFalse(probe.transactionAtExit);
            assertFalse(probe.interruptAtExit);
            assertNull(probe.cancellation);
            switch (entry) {
                case QUERY -> {
                    assertTrue("query engine observation was not exercised", probe.engines.get() > 0);
                    assertTrue(JSON.parse(response.headers().firstValue(QueryWorkService.READ_CUT_HEADER).orElseThrow())
                        .get("qualified").getAsBoolean().value());
                }
                case DELTA -> assertTrue(response.body(), JSON.parse(response.body()).get("available").getAsBoolean().value());
                case EXACT_UNIT -> assertEquals("present", JSON.parse(response.body()).get("status").getAsString().value());
                case PREFIX -> assertEquals(0, JSON.parse(response.body()).get("examined").getAsNumber().value().intValue());
                case TEMPLATE -> assertTrue(response.body().contains("value"));
            }
        }
        @Override public void close() throws Exception {
            server.stop(); client.close(); FunctionRegistry.get().remove(function); text.close();
        }
    }

    private static void awaitCaptureWait(Probe probe) throws Exception {
        assertTrue("servlet did not enter the real operation filter", probe.entered.await(2, TimeUnit.SECONDS));
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() < until && probe.exited.getCount() != 0) {
            Thread.State state = probe.worker.getState();
            if ((state == Thread.State.WAITING || state == Thread.State.TIMED_WAITING || state == Thread.State.BLOCKED)
                && java.util.Arrays.stream(probe.worker.getStackTrace()).anyMatch(frame ->
                    frame.getClassName().equals(SearchDeltaJournal.ReadCapture.class.getName())
                        && frame.getMethodName().equals("<init>"))) return;
            Thread.sleep(5);
        }
        fail("read did not wait inside the real text-backed capture");
    }

    private static void assertNoDepartedWork(Probe probe) {
        assertEquals("departed capture started an RDF transaction", 0, probe.transactions.get());
        assertEquals("departed capture executed a query engine", 0, probe.engines.get());
        assertFalse("departed servlet retained a transaction", probe.transactionAtExit);
        assertFalse("request interrupt leaked to the servlet executor", probe.interruptAtExit);
    }

    private static void contention(Entry entry, Departure departure) throws Exception {
        try (var fixture = new Fixture(); var publisher = Executors.newSingleThreadExecutor()) {
            var holding = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var published = publisher.submit(() -> {
                try (var publication = SearchDeltaJournal.publicationFence()) {
                    holding.countDown();
                    if (!release.await(15, TimeUnit.SECONDS)) throw new AssertionError("publisher was never released");
                }
                return null;
            });
            try {
                assertTrue(holding.await(2, TimeUnit.SECONDS));
                var departed = new Probe();
                var pending = fixture.start(entry, "departed", departure == Departure.DEADLINE ? 3000 : 10000, departed);
                awaitCaptureWait(departed);
                var unaffected = new Probe();
                var concurrent = fixture.start(entry, "unaffected", 10000, unaffected);
                awaitCaptureWait(unaffected);
                long departureAt = departed.deadline;
                if (departure == Departure.DISCONNECT) {
                    departureAt = System.nanoTime();
                    assertTrue("client request already completed", pending.cancel(true));
                }
                long graceEnd = departureAt + GRACE;
                assertTrue("native capture remained inside the servlet past 300ms grace while publication was held",
                    departed.exited.await(Math.max(0, graceEnd - System.nanoTime()), TimeUnit.NANOSECONDS));
                assertTrue("native exit exceeded the operation release grace", departed.exitedAt <= graceEnd);
                assertNotNull("native cancellation lost its typed cause", departed.cancellation);
                assertTrue(departed.cancellation.getCause().toString(), departed.cancellation.getCause().toString()
                    .contains(departure == Departure.DEADLINE ? "deadline" : "client-cancelled"));
                assertNoDepartedWork(departed);
                // Keep the holder beyond the entire grace, rather than letting
                // release of publication masquerade as request cancellation.
                TimeUnit.NANOSECONDS.sleep(Math.max(0, graceEnd + TimeUnit.MILLISECONDS.toNanos(50) - System.nanoTime()));
                assertEquals(1, release.getCount());
                assertEquals("unaffected reader left before publication resumed", 1, unaffected.exited.getCount());
                assertFalse(concurrent.isDone());
                assertNoDepartedWork(departed);
                if (departure == Departure.DEADLINE)
                    assertNotEquals(200, pending.get(1, TimeUnit.SECONDS).statusCode());
                release.countDown();
                published.get(2, TimeUnit.SECONDS);
                fixture.assertSuccess(entry, concurrent.get(3, TimeUnit.SECONDS), unaffected);
                var retry = new Probe();
                fixture.assertSuccess(entry, fixture.start(entry, "retry", 3000, retry).get(4, TimeUnit.SECONDS), retry);
                assertNoDepartedWork(departed);
            } finally { release.countDown(); published.get(3, TimeUnit.SECONDS); }
        }
    }

    @Test(timeout = 25_000) public void queryDeadlineLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.QUERY, Departure.DEADLINE);
    }
    @Test(timeout = 25_000) public void queryDisconnectLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.QUERY, Departure.DISCONNECT);
    }
    @Test(timeout = 25_000) public void deltaReadinessDeadlineLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.DELTA, Departure.DEADLINE);
    }
    @Test(timeout = 25_000) public void deltaReadinessDisconnectLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.DELTA, Departure.DISCONNECT);
    }
    @Test(timeout = 25_000) public void exactUnitDeadlineLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.EXACT_UNIT, Departure.DEADLINE);
    }
    @Test(timeout = 25_000) public void exactUnitDisconnectLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.EXACT_UNIT, Departure.DISCONNECT);
    }
    @Test(timeout = 25_000) public void prefixDeadlineLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.PREFIX, Departure.DEADLINE);
    }
    @Test(timeout = 25_000) public void prefixDisconnectLeavesHeldPublicationWithoutLaterWork() throws Exception {
        contention(Entry.PREFIX, Departure.DISCONNECT);
    }
    @Test(timeout = 15_000) public void templatesRetainTheirBoundedModelReadDuringPublication() throws Exception {
        try (var fixture = new Fixture(); var publication = SearchDeltaJournal.publicationFence()) {
            var probe = new Probe();
            fixture.assertSuccess(Entry.TEMPLATE,
                fixture.start(Entry.TEMPLATE, "template", 3000, probe).get(4, TimeUnit.SECONDS), probe);
        }
    }
}
