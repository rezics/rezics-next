package com.rezics.jena;

import static org.junit.Assert.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** One maintenance page of the existing Work-name directory. */
public class WorkScopeDirectoryCommandTest {
    private static final String MAINTENANCE = "1".repeat(64);
    private static final String COMMAND = "2".repeat(64);
    private static final String BODY = "{\"workScopeDirectory\":{}}";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node id(int value) {
        return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", value));
    }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), CONTROL = uri(CommandPolicy.CONTROL),
        PRODUCT = uri("urn:rezics:dataset:product"), WORK = id(10), MAIN = id(11);

    private static void owner(DatasetGraph data, int number) {
        Node realm = id(1000 + number), slot = CanonicalPolicy.realmOwner(realm, MAIN);
        data.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
        data.add(CURRENT, slot, p("realm"), realm);
        data.add(CURRENT, slot, p("mainVersion"), MAIN);
        data.add(CURRENT, slot, p("work"), WORK);
        data.add(CURRENT, slot, p("selectionHead"), id(20000 + number));
        data.add(CURRENT, realm, p("disclosure"), p("Private"));
    }

    private static final class Endpoint implements AutoCloseable {
        final DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        final FusekiServer server;
        final HttpClient http = HttpClient.newHttpClient();
        Endpoint(int owners) {
            data.begin(ReadWrite.WRITE);
            try {
                data.add(CONTROL, PRODUCT, p("dataEpoch"), text("11111111-1111-4111-8111-111111111111"));
                data.add(CONTROL, PRODUCT, p("routingEpoch"), text("22222222-2222-4222-8222-222222222222"));
                data.add(CURRENT, WORK, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
                data.add(CURRENT, WORK, p("mainVersion"), MAIN);
                data.add(CURRENT, MAIN, RDF.type.asNode(), p("MainVersion"));
                data.add(CURRENT, MAIN, p("work"), WORK);
                for (int number = 0; number < owners; number++) owner(data, number);
                PublicNameProjection.workScopeExclusiveStartup(data);
                data.commit();
            } catch (RuntimeException | Error failure) {
                data.abort(); throw failure;
            } finally { data.end(); }
            Operation operation = Operation.alloc("https://rezics.com/fuseki/command", "command", "REZICS transactional command");
            server = FusekiServer.create().port(0).add("/data", data, false)
                .registerOperation(operation, SlimCommandTest.service(SlimCommandTest.profiles()))
                .addEndpoint("/data", "command", operation).build().start();
        }
        HttpResponse<String> post(String body, String token) throws Exception {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + "/data/command"))
                .header("Content-Type", "application/json").timeout(java.time.Duration.ofSeconds(30));
            if (token != null) request.header("Authorization", "Bearer " + token);
            return http.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
        }
        JsonObject execute() throws Exception {
            var response = post(BODY, MAINTENANCE);
            assertEquals(response.body(), 200, response.statusCode());
            assertTrue(response.headers().firstValue("X-Rezics-Command-Work").isPresent());
            return JSON.parse(response.body());
        }
        Set<Quad> quads() {
            data.begin(ReadWrite.READ);
            try {
                Set<Quad> result = new HashSet<>();
                var rows = data.find();
                try { rows.forEachRemaining(result::add); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                return Set.copyOf(result);
            } finally { data.end(); }
        }
        @Override public void close() { server.stop(); http.close(); data.close(); }
    }

    private static String status(JsonObject value) { return value.get("status").getAsString().value(); }
    private static String phase(JsonObject value) { return value.get("phase").getAsString().value(); }

    @Test public void refusesTheDirectoryPageWithoutTheMaintenanceCapability() throws Exception {
        try (Endpoint endpoint = new Endpoint(0)) {
            Set<Quad> before = endpoint.quads();
            for (String token : new String[] { null, COMMAND }) {
                var response = endpoint.post(BODY, token);
                assertEquals(response.body(), 403, response.statusCode());
                assertEquals("forbidden", status(JSON.parse(response.body())));
            }
            var open = endpoint.post("{\"workScopeDirectory\":{\"page\":1}}", MAINTENANCE);
            assertEquals(open.body(), 400, open.statusCode());
            assertEquals(before, endpoint.quads());
        }
    }

    @Test public void pagesRealmOwnersThenLeavesACompleteDirectoryUnchanged() throws Exception {
        try (Endpoint endpoint = new Endpoint(65)) {
            JsonObject first = endpoint.execute();
            assertEquals("prepared", status(first));
            assertEquals("owners", phase(first));
            assertTrue(first.get("more").getAsBoolean().value());
            JsonObject done = null;
            for (int turn = 0; turn < 3 && (done == null || !"complete".equals(phase(done))); turn++) done = endpoint.execute();
            assertNotNull(done);
            assertEquals(done.toString(), "prepared", status(done));
            assertEquals("complete", phase(done));
            assertFalse(done.get("more").getAsBoolean().value());
            Set<Quad> committed = endpoint.quads();
            JsonObject again = endpoint.execute();
            assertEquals("prepared", status(again));
            assertEquals("complete", phase(again));
            assertFalse(again.get("more").getAsBoolean().value());
            assertEquals(committed, endpoint.quads());
        }
    }
}
