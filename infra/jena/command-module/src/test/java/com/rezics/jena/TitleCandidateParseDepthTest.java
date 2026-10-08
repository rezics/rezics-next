// Intended merge destination: infra/jena/command-module/src/test/java/com/rezics/jena/TitleCandidateParseDepthTest.java.
package com.rezics.jena;

import static org.junit.Assert.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.junit.Test;

/** Malformed untrusted bytes must be refused before recursive parsing, even below the byte bound. */
public class TitleCandidateParseDepthTest {
    private static final String RECEIPT = "urn:rezics:receipt:" + "a".repeat(64), DIGEST = "b".repeat(64);
    private static String deep() { return "[".repeat(12000) + "0" + "]".repeat(12000); }
    private static Set<Quad> snapshot(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try {
            Set<Quad> result = new HashSet<>(); var rows = data.find();
            try { rows.forEachRemaining(result::add); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            return Set.copyOf(result);
        } finally { data.end(); }
    }
    @Test public void deeplyNestedFrameIsRefusedBeforeCoreProfilePinParsingAndLeavesNoWrite() {
        DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        try {
            var before = snapshot(data); JsonObject candidate = new JsonObject();
            candidate.put("frame", deep()); candidate.put("custodySha256", "c".repeat(64)); candidate.put("mode", "accept");
            assertTrue(deep().getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 32768);
            var result = SlimCommandTest.service(SlimCommandTest.profiles()).runTitleCandidate(data, RECEIPT, DIGEST,
                candidate, new JsonObject(), System.nanoTime() + 10_000_000_000L);
            assertEquals(result.toString(), "conflict", result.get("status"));
            assertFalse(data.isInTransaction()); assertEquals(before, snapshot(data));
        } finally { data.close(); }
    }
    @Test public void deeplyNestedUnknownHttpCandidateFieldIsRefusedBeforeOuterJsonParsing() throws Exception {
        DatasetGraph data = org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph();
        var operation = org.apache.jena.fuseki.server.Operation.alloc("urn:rezics:test:title-candidate-depth", "command", "command");
        var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data", data)
            .registerOperation(operation, SlimCommandTest.service(SlimCommandTest.profiles()))
            .addEndpoint("/data", "command", operation).build().start();
        try {
            var before = snapshot(data);
            String body = "{\"receipt\":\"" + RECEIPT + "\",\"digest\":\"" + DIGEST
                + "\",\"update\":\"\",\"validations\":[],\"deadlineMs\":10000,\"titleCandidate\":{"
                + "\"frame\":\"{}\",\"custodySha256\":\"" + "c".repeat(64)
                + "\",\"mode\":\"accept\",\"unknownNestedField\":" + deep()
                + "},\"titleAdmission\":{\"payload\":\"[]\",\"signature\":\"" + "d".repeat(64) + "\"}}";
            var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + "/data/command"))
                .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + "2".repeat(64))
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
            var response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
            assertEquals(response.body(), 400, response.statusCode());
            assertEquals(before, snapshot(data));
        } finally { server.stop(); data.close(); }
    }
}
