package com.rezics.jena;

import static org.junit.Assert.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiModules;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.QueryCancelledException;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.junit.Test;

/** Real servlet, transport and ARQ execution, including the ordinary query
 * fallback and command/template path. Heavy proof runs in the wave prove phase. */
public class RequestReadBoundaryTest {
    private static final String PREDICATE = "urn:rezics:test:request-read-block";
    private static final String SLOW = "SELECT ?value WHERE { GRAPH <urn:rezics:graph:current> {"
        + " <urn:rezics:test:subject> <" + PREDICATE + "> ?value } }";
    private static final String FAST = "SELECT (1 AS ?value) WHERE {}";

    private static final class Fixture implements AutoCloseable {
        final CountDownLatch started = new CountDownLatch(1), finished = new CountDownLatch(1);
        final AtomicInteger active = new AtomicInteger();
        final org.apache.jena.sparql.core.DatasetGraph data = new SlowData();
        final FusekiServer server;
        final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();

        void block(org.apache.jena.graph.Node predicate) {
            if (!predicate.isURI() || !predicate.getURI().equals(PREDICATE)) return;
            active.incrementAndGet(); started.countDown();
            try { Thread.sleep(10_000); }
            catch (InterruptedException cancelled) { throw new QueryCancelledException(cancelled); }
            finally { active.decrementAndGet(); finished.countDown(); }
        }
        final class SlowData extends org.apache.jena.sparql.core.DatasetGraphWrapper
                implements org.apache.jena.sparql.core.DatasetGraphWrapperView {
            SlowData() { super(DatasetGraphFactory.createTxnMem()); }
            @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(
                    org.apache.jena.graph.Node g, org.apache.jena.graph.Node s,
                    org.apache.jena.graph.Node p, org.apache.jena.graph.Node o) {
                block(p); return super.find(g, s, p, o);
            }
            @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> findNG(
                    org.apache.jena.graph.Node g, org.apache.jena.graph.Node s,
                    org.apache.jena.graph.Node p, org.apache.jena.graph.Node o) {
                block(p); return super.findNG(g, s, p, o);
            }
            @Override public org.apache.jena.graph.Graph getGraph(org.apache.jena.graph.Node name) {
                return new org.apache.jena.sparql.graph.GraphWrapper(super.getGraph(name)) {
                    @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(
                            org.apache.jena.graph.Node s, org.apache.jena.graph.Node p, org.apache.jena.graph.Node o) {
                        block(p); return super.find(s, p, o);
                    }
                    @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(
                            org.apache.jena.graph.Triple pattern) {
                        block(pattern.getPredicate()); return super.find(pattern);
                    }
                };
            }
        }
        Fixture() {
            // GRAPH checks existence before reaching the blocking lookup.
            data.begin(ReadWrite.WRITE);
            try {
                data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI("urn:rezics:test:subject"),
                    NodeFactory.createURI(PREDICATE), NodeFactory.createLiteralString("seed"));
                data.commit();
            } finally { data.end(); }
            var command = Operation.alloc("urn:rezics:test:read-boundary", "command", "command");
            server = FusekiServer.create().port(0).fusekiModules(FusekiModules.empty())
                .add("/data", data, false)
                .addFilter("/*", new QueryWorkService.ReadBoundaryFilter())
                .registerOperation(Operation.Query, org.apache.jena.riot.WebContent.contentTypeSPARQLQuery,
                    new QueryWorkService())
                .registerOperation(command, new CommandService(ProfileRegistry.load(Path.of("src/test/resources/registry-probe")),
                    "1".repeat(64).getBytes(), "2".repeat(64).getBytes(), "3".repeat(64).getBytes()))
                .addEndpoint("/data", "command", command).build().start();
        }
        HttpRequest request(boolean template, String query, String allocation) {
            String body = template ? "{\"templateQuery\":{\"query\":\"" + query
                + "\",\"bindings\":{},\"tables\":[],\"limit\":1}}" : query;
            return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort()
                    + "/data/" + (template ? "command" : "query")))
                .header("Content-Type", template ? "application/json" : "application/sparql-query")
                .header("Accept", "application/sparql-results+json")
                .header("Authorization", "Bearer " + "2".repeat(64))
                .header(QueryWorkService.READ_BUDGET_HEADER, allocation).timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        }
        void freshRead(boolean template) throws Exception {
            var response = client.send(request(template, FAST, "1000"), HttpResponse.BodyHandlers.ofString());
            assertEquals(response.body(), 200, response.statusCode());
            assertTrue(response.body().contains("value"));
        }
        @Override public void close() {
            server.stop(); client.close(); data.close();
        }
    }

    @Test(timeout = 20_000) public void wallAllocationAbortsOrdinaryAndTemplateEnginesWithoutDiagnostics() throws Exception {
        for (boolean template : new boolean[] { false, true }) {
            try (var fixture = new Fixture()) {
                long began = System.nanoTime();
                var pending = fixture.client.sendAsync(fixture.request(template, SLOW, "1500"),
                    HttpResponse.BodyHandlers.ofString());
                assertTrue("native engine never entered", fixture.started.await(1, TimeUnit.SECONDS));
                assertTrue("native execution survived the deadline grace", fixture.finished.await(1800,
                    TimeUnit.MILLISECONDS));
                assertEquals(0, fixture.active.get());
                assertTrue("allocation renewed while executing", System.nanoTime() - began < 1_800_000_000L);
                assertNotEquals(200, pending.get(2, TimeUnit.SECONDS).statusCode());
                fixture.freshRead(template);
            }
        }
    }

    @Test(timeout = 20_000) public void clientCancellationReleasesNativeExecutionWithinGrace() throws Exception {
        for (boolean template : new boolean[] { false, true }) {
            try (var fixture = new Fixture()) {
                var pending = fixture.client.sendAsync(fixture.request(template, SLOW, "10000"),
                    HttpResponse.BodyHandlers.ofString());
                assertTrue("native engine never entered", fixture.started.await(2, TimeUnit.SECONDS));
                pending.cancel(true);
                assertTrue("disconnected native execution survived 300ms grace", fixture.finished.await(300,
                    TimeUnit.MILLISECONDS));
                assertEquals(0, fixture.active.get());
                fixture.freshRead(template);
            }
        }
    }

    @Test(timeout = 10_000) public void invalidAllocationsNeverEnterTheEngine() throws Exception {
        try (var fixture = new Fixture()) {
            for (String invalid : new String[] { "0", "10001", "-1", "NaN", "1.5" }) {
                var response = fixture.client.send(fixture.request(false, SLOW, invalid), HttpResponse.BodyHandlers.ofString());
                assertEquals(response.body(), 400, response.statusCode());
            }
            assertEquals(1, fixture.started.getCount());
            assertEquals(0, fixture.active.get());
            fixture.freshRead(false);
        }
    }
}
