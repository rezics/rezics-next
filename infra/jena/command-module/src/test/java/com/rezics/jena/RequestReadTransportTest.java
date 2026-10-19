package com.rezics.jena;

import static org.junit.Assert.*;

import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiModules;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.QueryCancelledException;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.junit.Test;

/** Exercise live HTTP/1 reads, including bytes belonging to the next request. */
public class RequestReadTransportTest {
    private static final String PREDICATE = "urn:rezics:test:transport-block";
    private static final String SLOW = "SELECT ?value WHERE { GRAPH <urn:rezics:graph:current> {"
        + " <urn:rezics:test:subject> <" + PREDICATE + "> ?value } }";
    private static final String FAST = "SELECT (2 AS ?value) WHERE {}";

    private static final class Fixture implements AutoCloseable {
        final CountDownLatch started = new CountDownLatch(1), finished = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final org.apache.jena.sparql.core.DatasetGraph data = new SlowData();
        final HttpClient client = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
        final FusekiServer server;

        void block(Node predicate) {
            if (!predicate.isURI() || !predicate.getURI().equals(PREDICATE)) return;
            started.countDown();
            try {
                if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("read was never released");
            } catch (InterruptedException cancelled) { throw new QueryCancelledException(cancelled); }
            finally { finished.countDown(); }
        }
        final class SlowData extends org.apache.jena.sparql.core.DatasetGraphWrapper
                implements org.apache.jena.sparql.core.DatasetGraphWrapperView {
            SlowData() { super(DatasetGraphFactory.createTxnMem()); }
            @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(
                    Node g, Node s, Node p, Node o) {
                block(p); return super.find(g, s, p, o);
            }
            @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> findNG(
                    Node g, Node s, Node p, Node o) {
                block(p); return super.findNG(g, s, p, o);
            }
            @Override public org.apache.jena.graph.Graph getGraph(Node name) {
                return new org.apache.jena.sparql.graph.GraphWrapper(super.getGraph(name)) {
                    @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(
                            Node s, Node p, Node o) {
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
            // GRAPH evaluation first checks that the named graph exists.
            data.begin(ReadWrite.WRITE);
            try {
                data.add(NodeFactory.createURI(CommandPolicy.CURRENT), NodeFactory.createURI("urn:rezics:test:subject"),
                    NodeFactory.createURI(PREDICATE), NodeFactory.createLiteralString("first"));
                data.commit();
            } finally { data.end(); }
            var command = Operation.alloc("urn:rezics:test:transport-command", "command", "command");
            server = FusekiServer.create().port(0).fusekiModules(FusekiModules.empty())
                .add("/data", data, false).addFilter("/*", new QueryWorkService.ReadBoundaryFilter())
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
        void retry(boolean template) throws Exception {
            var response = client.send(request(template, FAST, "1000"), HttpResponse.BodyHandlers.ofString());
            assertEquals(response.body(), 200, response.statusCode());
        }
        @Override public void close() {
            release.countDown(); server.stop(); client.close(); data.close();
        }
    }

    @Test(timeout = 20_000) public void disconnectInterruptsExecutingOrdinaryAndTemplateReads() throws Exception {
        for (boolean template : new boolean[] {false, true}) {
            try (var fixture = new Fixture()) {
                var pending = fixture.client.sendAsync(fixture.request(template, SLOW, "10000"),
                    HttpResponse.BodyHandlers.ofString());
                assertTrue("native lookup never entered", fixture.started.await(2, TimeUnit.SECONDS));
                assertTrue(pending.cancel(true));
                assertTrue("executing lookup survived 300ms disconnect grace", fixture.finished.await(300, TimeUnit.MILLISECONDS));
                fixture.retry(template);
            }
        }
    }

    @Test(timeout = 20_000) public void allocationInterruptsExecutingOrdinaryAndTemplateReads() throws Exception {
        for (boolean template : new boolean[] {false, true}) {
            try (var fixture = new Fixture()) {
                long began = System.nanoTime();
                var pending = fixture.client.sendAsync(fixture.request(template, SLOW, "1500"),
                    HttpResponse.BodyHandlers.ofString());
                assertTrue("native lookup never entered", fixture.started.await(1, TimeUnit.SECONDS));
                assertTrue("executing lookup survived deadline grace", fixture.finished.await(1800, TimeUnit.MILLISECONDS));
                assertTrue("allocation was renewed", System.nanoTime() - began < 1_800_000_000L);
                assertNotEquals(200, pending.get(2, TimeUnit.SECONDS).statusCode());
                fixture.retry(template);
            }
        }
    }

    private static byte[] wire(String query, boolean close) {
        return ("POST /data/query HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/sparql-query\r\n"
            + "Accept: application/sparql-results+json\r\n" + QueryWorkService.READ_BUDGET_HEADER + ": 3000\r\n"
            + (close ? "Connection: close\r\n" : "") + "Content-Length: " + query.length() + "\r\n\r\n" + query)
            .getBytes(StandardCharsets.UTF_8);
    }

    @Test(timeout = 10_000) public void transportProbePreservesPipelinedRequestBytes() throws Exception {
        try (var fixture = new Fixture(); var socket = new Socket("127.0.0.1", fixture.server.getPort())) {
            socket.setSoTimeout(5000);
            socket.getOutputStream().write(wire(SLOW, false));
            assertTrue(fixture.started.await(1, TimeUnit.SECONDS));
            socket.getOutputStream().write(wire(FAST, true));
            Thread.sleep(50);
            fixture.release.countDown();
            String responses = new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            assertEquals(responses, 2, responses.split("HTTP/1.1 200", -1).length - 1);
            assertTrue(responses, responses.contains("first"));
            assertTrue(responses, responses.contains("\"2\""));
        }
    }
}
