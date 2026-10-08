package com.rezics.jena;

import static org.junit.Assert.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.Quad;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** The maintenance dataset reset empties every graph, including repair state
 * the next file must not inherit. Raw update still cannot do that. */
public class DatasetResetPolicyTest {
    private static final String MAINTENANCE = "1".repeat(64);
    private static final String COMMAND = "2".repeat(64);
    private static final String BODY = "{\"datasetReset\":{}}";
    private static final Node REPAIR = PublicNameProjection.REPAIR;
    private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
    private static final Node SUBJECT = NodeFactory.createURI("urn:rezics:title-candidate:previous-file");
    private static Node vocab(String name) { return NodeFactory.createURI("https://rezics.com/vocab/" + name); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }

    @Test public void refusedWithoutTheMaintenanceCapability() throws Exception {
        try (Endpoint endpoint = new Endpoint()) {
            assertEquals(403, endpoint.post(BODY, null).statusCode());
            assertEquals(403, endpoint.post(BODY, COMMAND).statusCode());
            var widened = endpoint.post("{\"datasetReset\":{\"graphs\":\"all\"}}", MAINTENANCE);
            assertEquals(widened.body(), 400, widened.statusCode());
            assertTrue(endpoint.repairPopulated());
            assertTrue(endpoint.search("previous"));
            assertTrue(endpoint.writerAdmitted());
        }
    }

    @Test public void completeWithTheMaintenanceCapability() throws Exception {
        try (Endpoint endpoint = new Endpoint()) {
            for (String rejected : List.of(
                "CLEAR ALL",
                "CLEAR GRAPH <" + REPAIR.getURI() + ">",
                "DROP GRAPH <" + REPAIR.getURI() + ">")) {
                var raw = endpoint.update(rejected);
                assertEquals(raw.body(), 400, raw.statusCode());
            }
            assertTrue(endpoint.repairPopulated());
            var response = endpoint.post(BODY, MAINTENANCE);
            assertEquals(response.body(), 200, response.statusCode());
            assertEquals("reset", JSON.parse(response.body()).get("status").getAsString().value());
            assertTrue(endpoint.quads().isEmpty());
            assertFalse(endpoint.repairPopulated());
            assertFalse(endpoint.search("previous"));
            assertFalse(endpoint.writerAdmitted());
        }
    }

    /** One file's repair cursor, label copy and retained title are gone before
     * the next file reads the proof graph. */
    @Test public void repairStateLeftByOneFileIsAbsentWhenTheNextFileStarts() throws Exception {
        try (Endpoint endpoint = new Endpoint()) {
            assertEquals(List.of("labelCopyGeneration", "labelCopyPhase", "labelCopyStep", "repairCursor", "retainedTitleCandidate"),
                endpoint.repairPredicates());
            assertEquals(200, endpoint.post(BODY, MAINTENANCE).statusCode());
            assertEquals(List.of(), endpoint.repairPredicates());
            assertFalse(endpoint.dataContains(REPAIR, Node.ANY, Node.ANY, Node.ANY));
            assertFalse(endpoint.dataContains(CURRENT, Node.ANY, Node.ANY, Node.ANY));
            assertFalse(endpoint.dataContains(Quad.defaultGraphNodeGenerated, Node.ANY, Node.ANY, Node.ANY));
        }
    }

    private static final class Endpoint implements AutoCloseable {
        final DatasetGraphText data;
        final FusekiServer server;
        final HttpClient http = HttpClient.newHttpClient();

        Endpoint() {
            var definition = new EntityDefinition("uri", "publicTitle", "graph");
            definition.set("publicTitle", vocab("publicTitle"));
            definition.setUidField("uid");
            var config = new TextIndexConfig(definition);
            config.setValueStored(true);
            var index = new TextIndexLucene(new ByteBuffersDirectory(), config);
            data = new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),
                index, new TextDocProducerTriples(index));
            data.begin(ReadWrite.WRITE);
            try {
                data.add(REPAIR, SUBJECT, vocab("repairCursor"), literal("cursor-from-the-previous-file"));
                data.add(REPAIR, SUBJECT, vocab("labelCopyPhase"), literal("2"));
                data.add(REPAIR, SUBJECT, vocab("labelCopyStep"), literal("9"));
                data.add(REPAIR, SUBJECT, vocab("labelCopyGeneration"), literal("4"));
                data.add(REPAIR, SUBJECT, vocab("retainedTitleCandidate"), literal("{\"kept\":true}"));
                data.add(CURRENT, SUBJECT, vocab("publicTitle"), literal("Previous file title"));
                data.add(Quad.defaultGraphNodeGenerated, SUBJECT, vocab("repairCursor"), literal("default-graph-leftover"));
                data.commit();
            } catch (RuntimeException | Error failure) {
                data.abort(); throw failure;
            } finally { data.end(); }
            data.begin(ReadWrite.READ);
            try { TemplateIndexService.admitWorkScopeWriter(data); }
            finally { data.end(); }
            Operation command = Operation.alloc("https://rezics.com/fuseki/command", "command", "REZICS transactional command");
            server = FusekiServer.create().port(0).add("/data", data, false)
                .registerOperation(command, SlimCommandTest.service(SlimCommandTest.profiles()))
                .addEndpoint("/data", "command", command)
                .registerOperation(Operation.Update, new TemplateIndexService.RawMembershipUpdate())
                .addEndpoint("/data", "update", Operation.Update)
                .build().start();
        }

        HttpResponse<String> post(String body, String token) throws Exception {
            return send("/data/command", "application/json", body, token);
        }

        HttpResponse<String> update(String sparql) throws Exception {
            return send("/data/update", "application/sparql-update", sparql, null);
        }

        private HttpResponse<String> send(String path, String type, String body, String token) throws Exception {
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + path))
                .header("Content-Type", type).timeout(java.time.Duration.ofSeconds(30));
            if (token != null) request.header("Authorization", "Bearer " + token);
            return http.send(request.POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                HttpResponse.BodyHandlers.ofString());
        }

        boolean repairPopulated() {
            return dataContains(REPAIR, SUBJECT, vocab("repairCursor"), literal("cursor-from-the-previous-file"))
                && dataContains(REPAIR, SUBJECT, vocab("retainedTitleCandidate"), literal("{\"kept\":true}"));
        }

        List<String> repairPredicates() {
            List<String> names = new ArrayList<>();
            data.begin(ReadWrite.READ);
            try {
                var rows = data.find(REPAIR, Node.ANY, Node.ANY, Node.ANY);
                try { rows.forEachRemaining(quad -> names.add(quad.getPredicate().getLocalName())); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            } finally { data.end(); }
            names.sort(String::compareTo);
            return List.copyOf(names);
        }

        boolean dataContains(Node graph, Node subject, Node predicate, Node object) {
            data.begin(ReadWrite.READ);
            try { return data.contains(graph, subject, predicate, object); }
            finally { data.end(); }
        }

        java.util.Set<Quad> quads() {
            data.begin(ReadWrite.READ);
            try {
                var result = new java.util.HashSet<Quad>();
                var rows = data.find();
                try { rows.forEachRemaining(result::add); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                return java.util.Set.copyOf(result);
            } finally { data.end(); }
        }

        boolean writerAdmitted() {
            data.begin(ReadWrite.READ);
            try { return TemplateIndexService.workScopeWriterAdmitted(data); }
            finally { data.end(); }
        }

        boolean search(String text) {
            var hits = data.search(text, vocab("publicTitle"));
            try { return hits.hasNext(); }
            finally { org.apache.jena.atlas.iterator.Iter.close(hits); }
        }

        @Override public void close() { server.stop(); http.close(); data.close(); }
    }
}
