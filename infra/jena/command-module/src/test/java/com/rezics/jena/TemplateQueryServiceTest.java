package com.rezics.jena;

import static org.junit.Assert.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.junit.Test;

public class TemplateQueryServiceTest {
    private static final String GRAPH = "urn:rezics:graph:current";
    private record Fixture(DatasetGraph data) implements AutoCloseable {
        @Override public void close() { data.close(); }
    }
    private static JsonObject term(String type, String value) {
        JsonObject object = new JsonObject(); object.put("type", type); object.put("value", value); return object;
    }
    private static JsonObject request(String query) {
        JsonObject object = new JsonObject(); object.put("query", query); object.put("limit", 21);
        object.put("bindings", new JsonObject()); object.put("tables", new JsonArray()); return object;
    }
    private static DatasetGraph dataset() {
        DatasetGraph data = DatasetGraphFactory.createTxnMem();
        data.begin(ReadWrite.WRITE);
        try {
            data.add(NodeFactory.createURI(GRAPH), NodeFactory.createURI("urn:item:one"),
                NodeFactory.createURI("urn:label"), NodeFactory.createLiteralLang("名字 \" } UNION { ?s ?p ?o } #", "zh"));
            data.add(NodeFactory.createURI(GRAPH), NodeFactory.createURI("urn:item:two"),
                NodeFactory.createURI("urn:label"), NodeFactory.createLiteralString("other"));
            data.commit();
        } finally { data.end(); }
        return data;
    }
    private static JsonArray rows(DatasetGraph data, JsonObject request) {
        return TemplateQueryService.select(data, request).get("results").getAsObject().get("bindings").getAsArray();
    }

    @Test public void scalarTermsBindWithoutChangingTheQueryTextOrLiteralIdentity() {
        try (Fixture fixture = new Fixture(dataset())) {
            DatasetGraph data = fixture.data();
            String query = "SELECT ?id WHERE { GRAPH <" + GRAPH + "> { ?id <urn:label> ?_label } }";
            JsonObject request = request(query);
            JsonObject label = term("literal", "名字 \" } UNION { ?s ?p ?o } #"); label.put("language", "zh");
            request.get("bindings").getAsObject().put("_label", label);
            JsonArray rows = rows(data, request);
            assertEquals(1, rows.size());
            assertEquals("urn:item:one", rows.get(0).getAsObject().get("id").getAsObject().get("value").getAsString().value());
            assertEquals(query, request.get("query").getAsString().value());
            request.get("bindings").getAsObject().put("_label", term("literal", label.get("value").getAsString().value()));
            assertEquals("plain and language-tagged literals differ", 0, rows(data, request).size());
        }
    }

    @Test public void sourceOwnedTuplesReplaceOnlyTheirAuthoredEmptyValuesSlot() {
        try (Fixture fixture = new Fixture(dataset())) {
            DatasetGraph data = fixture.data();
            JsonObject request = request("SELECT ?id ?key ?ordinal WHERE { "
                + "{ VALUES (?id ?key ?ordinal) {} } UNION { GRAPH <" + GRAPH + "> { ?id <urn:label> \"other\" } } }");
            JsonObject table = new JsonObject();
            JsonArray columns = new JsonArray(); columns.add("id"); columns.add("key"); columns.add("ordinal");
            JsonArray cells = new JsonArray(); cells.add(term("uri", "urn:source:one")); cells.add(term("literal", "OL1A"));
            JsonObject ordinal = term("literal", "7"); ordinal.put("datatype", "http://www.w3.org/2001/XMLSchema#integer");
            cells.add(ordinal); JsonArray values = new JsonArray(); values.add(cells);
            table.put("columns", columns); table.put("rows", values); request.get("tables").getAsArray().add(table);
            assertEquals(2, rows(data, request).size());
            assertTrue(TemplateQueryService.prepare(request).query().toString().contains("OL1A"));
            table.put("rows", new JsonArray());
            assertEquals("empty source attribution must not suppress the graph branch", 1, rows(data, request).size());
            table.get("columns").getAsArray().add("unexpected");
            assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(request));
        }
    }

    @Test public void nativePageLimitOverridesAuthoredLimitAndPreservesLookahead() {
        try (Fixture fixture = new Fixture(dataset())) {
            DatasetGraph data = fixture.data();
            JsonObject request = request("SELECT ?id WHERE { GRAPH <" + GRAPH + "> { ?id <urn:label> ?label } } LIMIT 10000");
            request.put("limit", 1); assertEquals(1, rows(data, request).size());
            request.put("limit", 65); assertEquals(2, rows(data, request).size());
            for (int invalid : new int[] { 0, 66, -1 }) {
                request.put("limit", invalid);
                assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(request));
            }
        }
    }

    @Test public void serviceRemoteDatasetsVariableGraphsDefaultGraphsAndUnboundedPathsAreRefused() {
        String[] queries = {
            "SELECT * WHERE { SERVICE <https://example.invalid/> { ?s ?p ?o } }",
            "SELECT * WHERE { FILTER EXISTS { SERVICE <https://example.invalid/> { ?s ?p ?o } } }",
            "SELECT (EXISTS { SERVICE <https://example.invalid/> { ?s ?p ?o } } AS ?value) WHERE {}",
            "SELECT * WHERE { { SELECT * FROM <https://example.invalid/> WHERE { ?s ?p ?o } } }",
            "SELECT * WHERE { GRAPH ?graph { ?s ?p ?o } }",
            "SELECT * WHERE { GRAPH <urn:private> { ?s ?p ?o } }",
            "SELECT * WHERE { ?s ?p ?o }",
            "SELECT * WHERE { GRAPH <" + GRAPH + "> { ?s <urn:edge>* ?o } }",
            "SELECT * WHERE { GRAPH <" + GRAPH + "> { ?s ?p ?o } } OFFSET 1",
            "ASK { GRAPH <" + GRAPH + "> { ?s ?p ?o } }"
        };
        for (String query : queries) assertThrows(query, RuntimeException.class,
            () -> TemplateQueryService.prepare(request(query)));
    }

    @Test public void termMetadataAndCandidateBoundsAreValidated() {
        assertEquals("", TemplateQueryService.term(term("literal", "")).getLiteralLexicalForm());
        JsonObject bad = term("uri", "urn:item:one"); bad.put("language", "en");
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.term(bad));
        JsonObject blank = term("bnode", "one");
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.term(blank));
        JsonObject both = term("literal", "one"); both.put("datatype", "urn:type"); both.put("language", "en");
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.term(both));
        JsonObject request = request("SELECT ?id WHERE { VALUES ?id {} }");
        JsonObject table = new JsonObject(); JsonArray columns = new JsonArray(); columns.add("id");
        JsonArray values = new JsonArray();
        for (int i = 0; i < 256; i++) { JsonArray row = new JsonArray(); row.add(term("uri", "urn:item:" + i)); values.add(row); }
        table.put("columns", columns); table.put("rows", values); request.get("tables").getAsArray().add(table);
        assertNotNull(TemplateQueryService.prepare(request));
        JsonArray overflow = new JsonArray(); overflow.add(term("uri", "urn:item:overflow")); values.add(overflow);
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(request));
    }

    @Test public void malformedInputsAndAmbiguousValuesSlotsAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(new JsonObject()));
        JsonObject request = request("SELECT ?id WHERE { { VALUES ?id {} } UNION { VALUES ?id {} } }");
        JsonObject table = new JsonObject(); JsonArray columns = new JsonArray(); columns.add("id");
        table.put("columns", columns); table.put("rows", new JsonArray()); request.get("tables").getAsArray().add(table);
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(request));
        JsonObject extra = request("SELECT ?id WHERE { VALUES ?id { <urn:item:one> } }");
        extra.get("tables").getAsArray().add(table);
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(extra));
        JsonObject overlap = request("SELECT ?id WHERE { VALUES ?id {} }");
        overlap.get("tables").getAsArray().add(table);
        overlap.get("bindings").getAsObject().put("id", term("uri", "urn:item:one"));
        assertThrows(IllegalArgumentException.class, () -> TemplateQueryService.prepare(overlap));
    }

    @Test public void commandTransportRequiresTheAdmittedCapabilityAndNeverWrites() throws Exception {
        try (Fixture fixture = new Fixture(dataset())) {
            DatasetGraph data = fixture.data();
            byte[] maintenance = "1".repeat(64).getBytes(), admitted = "2".repeat(64).getBytes(), title = "3".repeat(64).getBytes();
            CommandService service = new CommandService(ProfileRegistry.load(Path.of("src/test/resources/registry-probe")),
                maintenance, admitted, title);
            Operation operation = Operation.alloc("urn:rezics:test:command", "command", "command");
            FusekiServer server = FusekiServer.create().port(0).add("/data", data)
                .registerOperation(operation, service).addEndpoint("/data", "command", operation).build().start();
            try {
                JsonObject envelope = new JsonObject();
                envelope.put("templateQuery", request("SELECT ?id WHERE { GRAPH <" + GRAPH + "> { ?id <urn:label> ?label } }"));
                URI uri = URI.create("http://localhost:" + server.getPort() + "/data/command");
                var client = HttpClient.newHttpClient();
                for (String token : new String[] { "1".repeat(64), "2".repeat(64) }) {
                    var http = HttpRequest.newBuilder(uri).header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + token)
                        .POST(HttpRequest.BodyPublishers.ofString(envelope.toString())).build();
                    var response = client.send(http, HttpResponse.BodyHandlers.ofString());
                    assertEquals(token.startsWith("2") ? 200 : 403, response.statusCode());
                    if (response.statusCode() == 200) assertEquals(2,
                        JSON.parse(response.body()).get("results").getAsObject().get("bindings").getAsArray().size());
                }
                data.begin(ReadWrite.READ);
                try { assertEquals(2, data.stream().count()); }
                finally { data.end(); }
            } finally { server.stop(); }
        }
    }
}
