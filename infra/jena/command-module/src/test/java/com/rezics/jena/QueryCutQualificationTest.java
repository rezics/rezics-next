package com.rezics.jena;

import static org.junit.Assert.*;
import static com.rezics.jena.ConsistentReadCaptureTest.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.fuseki.main.FusekiServer;
import org.apache.jena.fuseki.main.sys.FusekiModules;
import org.apache.jena.fuseki.server.Operation;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class QueryCutQualificationTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String CONTENT = "urn:rezics:content:match-unit:" + "d".repeat(64);
    private static final String VARIANT = "urn:test:content:variant";
    private static final String RESOURCE = "urn:test:content:work";
    private static final String PUBLICATION = "urn:test:content:publication";
    private static final String ELIGIBILITY = "urn:test:content:eligibility";
    private static final String REVISION = "urn:rezics:content:revision:00000000-0000-4000-8000-000000000001";
    private static final String PROJECTION = "urn:test:content:projection:1";
    private static final String RECEIPT = "urn:test:content:receipt:1";
    private static final String DIGEST = "b".repeat(64);
    private static final String OWNER_EPOCH = "00000000-0000-4000-8000-000000000002";


    private static FusekiServer server(DatasetGraph data) {
        return FusekiServer.create().port(0).add("/data", data, false)
            .fusekiModules(FusekiModules.empty())
            .registerOperation(Operation.Query, org.apache.jena.riot.WebContent.contentTypeSPARQLQuery,
                new QueryWorkService()).build().start();
    }
    private static HttpResponse<String> query(FusekiServer server, String query, String require) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + server.getPort() + "/data/query"))
            .header("Content-Type", "application/sparql-query").header("Accept", "application/sparql-results+json")
            .timeout(Duration.ofSeconds(15));
        if (require != null) request.header(QueryWorkService.REQUIRE_QUALIFIED_HEADER, require);
        return HttpClient.newHttpClient().send(request.POST(HttpRequest.BodyPublishers.ofString(query)).build(),
            HttpResponse.BodyHandlers.ofString());
    }
    private static JsonObject cut(HttpResponse<String> response) {
        String header = response.headers().firstValue(QueryWorkService.READ_CUT_HEADER).orElseThrow();
        assertTrue(header.length() <= QueryWorkService.MAX_READ_CUT_BYTES);
        JsonObject evidence = JSON.parse(header);
        assertEquals(1, evidence.get("version").getAsNumber().value().intValue());
        assertFalse(evidence.get("textIndexUncertain").getAsBoolean().value());
        return evidence;
    }
    private static String string(JsonObject object, String name) { return object.get(name).getAsString().value(); }

    @Test(timeout = 30_000) public void physicalReadVersionMovesWithoutADiagnosticSequenceChange() throws Exception {
        try (var fixture = new Fixture()) {
            var server = server(fixture.data);
            try {
                String body = "SELECT ?sequence WHERE { GRAPH <" + CommandPolicy.CONTROL + "> { <urn:rezics:dataset:product> <" + RV + "sequence> ?sequence } }";
                var first = query(server, body, null);
                assertEquals(200, first.statusCode());
                String version = first.headers().firstValue(QueryWorkService.GRAPH_VERSION_HEADER).orElseThrow();
                assertTrue(version.matches("[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]+"));
                assertEquals(version, query(server, body, null).headers()
                    .firstValue(QueryWorkService.GRAPH_VERSION_HEADER).orElseThrow());
                fixture.data.begin(org.apache.jena.query.ReadWrite.WRITE);
                try {
                    fixture.data.add(uri("urn:test:version"), uri("urn:test:subject"), p("label"),
                        NodeFactory.createLiteralString("new graph input"));
                    fixture.data.commit();
                } finally { fixture.data.end(); }
                var changed = query(server, body, null);
                assertEquals(200, changed.statusCode());
                assertEquals(first.body(), changed.body());
                assertNotEquals(version, changed.headers().firstValue(QueryWorkService.GRAPH_VERSION_HEADER).orElseThrow());
            } finally { server.stop(); }
        }
    }

    @Test(timeout = 30_000) public void streamedQueryKeepsQualificationAndEpochOfItsOwnCutAcrossUnrelatedCommit() throws Exception {
        try (var fixture = new Fixture(); var writer = Executors.newSingleThreadExecutor()) {
            Map<String, Object> before;
            try (var capture = SearchDeltaJournal.captureRead(fixture.data)) { before = capture.evidence(); }
            String function = "urn:test:query-cut:commit-during-stream";
            var functions = org.apache.jena.sparql.function.FunctionRegistry.get();
            var previous = functions.get(function);
            var committed = new AtomicBoolean();
            functions.put(function, ignored -> new org.apache.jena.sparql.function.FunctionBase1() {
                @Override public org.apache.jena.sparql.expr.NodeValue exec(org.apache.jena.sparql.expr.NodeValue row) {
                    if (row.getInteger().intValueExact() == 2 && committed.compareAndSet(false, true))
                        publishDuringRead(writer, () -> fixture.replace(CommandPolicy.PUBLIC_SEARCH,
                            "urn:test:query-cut:unrelated", "unrelated addition", "en"));
                    return org.apache.jena.sparql.expr.NodeValue.makeString(
                        fixture.hits(CommandPolicy.PUBLIC_SEARCH, "unrelated") + ":"
                        + fixture.hits(CommandPolicy.PUBLIC_SEARCH, "alpha"));
                }
            });
            var server = server(fixture.data);
            try {
                String padding = org.apache.jena.riot.out.NodeFmtLib.strNT(NodeFactory.createLiteralString("x".repeat(32_768)));
                String sparql = "SELECT ?probe ?padding WHERE { VALUES ?row { 1 2 } BIND(<" + function
                    + ">(?row) AS ?probe) BIND(" + padding + " AS ?padding) }";
                var response = query(server, sparql, "true");
                assertEquals(response.body(), 200, response.statusCode());
                assertTrue(committed.get());
                var evidence = cut(response);
                assertTrue(evidence.get("qualified").getAsBoolean().value());
                for (String key : new String[] {"dataEpoch", "sequence", "generation", "luceneGeneration", "ordinal", "writeEpoch"})
                    assertEquals(key, before.get(key), string(evidence, key));
                for (var row : JSON.parse(response.body()).get("results").getAsObject().get("bindings").getAsArray())
                    assertEquals("0:1", string(row.getAsObject().get("probe").getAsObject(), "value"));
                var next = query(server, "SELECT ?x WHERE { VALUES ?x { 1 } }", "true");
                assertEquals(next.body(), 200, next.statusCode());
                assertNotEquals(string(evidence, "luceneGeneration"), string(cut(next), "luceneGeneration"));
                assertEquals("2", string(cut(next), "writeEpoch"));
            } finally {
                server.stop();
                if (previous == null) functions.remove(function); else functions.put(function, previous);
            }
        }
    }

    @Test public void unqualifiedCutRefusesOptInAndRemainsVisibleForExistingCallers() throws Exception {
        try (var fixture = new Fixture()) {
            SearchDeltaJournal.dropQualification(fixture.data);
            var server = server(fixture.data);
            try {
                String sparql = "SELECT ?x WHERE { VALUES ?x { 1 } }";
                for (String require : new String[] {null, "false", "true"}) {
                    var response = query(server, sparql, require);
                    assertEquals(response.body(), "true".equals(require) ? 503 : 200, response.statusCode());
                    assertFalse(cut(response).get("qualified").getAsBoolean().value());
                    assertEquals("generation-unqualified", string(cut(response), "reason"));
                    if ("true".equals(require)) assertEquals("unavailable", string(JSON.parse(response.body()), "status"));
                }
                assertEquals(400, query(server, sparql, "yes").statusCode());
                assertTrue(SearchDeltaJournal.qualify(fixture.data));
                assertEquals(200, query(server, sparql, "true").statusCode());
            } finally { server.stop(); }
        }
    }

    @Test public void laterQualificationCannotUpgradeEvidenceFromAnUnqualifiedCapture() throws Exception {
        try (var fixture = new Fixture(); var writer = Executors.newSingleThreadExecutor()) {
            SearchDeltaJournal.dropQualification(fixture.data);
            try (var capture = SearchDeltaJournal.captureRead(fixture.data)) {
                writer.submit(() -> assertTrue(SearchDeltaJournal.qualify(fixture.data))).get();
                assertFalse(QueryWorkService.readCutHeader(capture.evidence()).get("qualified").getAsBoolean().value());
                assertEquals(false, capture.qualification().get("available"));
            }
            try (var next = SearchDeltaJournal.captureRead(fixture.data)) {
                assertTrue(QueryWorkService.readCutHeader(next.evidence()).get("qualified").getAsBoolean().value());
            }
        }
    }

    @Test public void qualifiedRequestWithoutTextIndexIsTypedUnavailable() throws Exception {
        var data = org.apache.jena.sparql.core.DatasetGraphFactory.createTxnMem();
        var server = server(data);
        try {
            var response = query(server, "ASK {}", "true");
            assertEquals(503, response.statusCode());
            assertEquals("unavailable", string(JSON.parse(response.body()), "status"));
            assertFalse(cut(response).get("qualified").getAsBoolean().value());
            assertEquals("text-index-unavailable", string(cut(response), "reason"));
            assertEquals(200, query(server, "ASK {}", null).statusCode());
        } finally { server.stop(); data.close(); }
    }

    @Test public void oversizedControlEvidenceCannotProduceAnUnboundedQualifiedHeader() throws Exception {
        try (var fixture = new Fixture()) {
            fixture.data.begin(org.apache.jena.query.ReadWrite.WRITE);
            try {
                Node control = uri(CommandPolicy.CONTROL), product = uri("urn:rezics:dataset:product");
                fixture.data.deleteAny(control, product, p("dataEpoch"), Node.ANY);
                fixture.data.add(control, product, p("dataEpoch"), NodeFactory.createLiteralString("x".repeat(4096)));
                fixture.data.commit();
            } finally { fixture.data.end(); }
            assertTrue(SearchDeltaJournal.qualify(fixture.data));
            var server = server(fixture.data);
            try {
                var response = query(server, "ASK {}", "true");
                assertEquals(503, response.statusCode());
                assertFalse(cut(response).get("qualified").getAsBoolean().value());
                assertEquals("cut-evidence-unavailable", string(cut(response), "reason"));
            } finally { server.stop(); }
        }
    }

    @Test public void scopedSourceHeadRemovalDeletesOnlyItsCandidateAndKeepsQualifiedSibling() throws Exception {
        for (String head : new String[] {"contentPublicationHead", "publicSearchEligibilityHead"}) {
            try (var fixture = new Fixture()) {
                fixture.beginWrite();
                try {
                    var journal = new SearchDeltaJournal.Capture(fixture.data);
                    seedContent(journal.observed(), "removed candidate body");
                    fixture.append(journal); fixture.publish();
                } finally { fixture.data.end(); }
                fixture.beginWrite();
                try {
                    var journal = new SearchDeltaJournal.Capture(fixture.data);
                    journal.observed().deleteAny(uri(CommandPolicy.CURRENT), uri(VARIANT), p(head), Node.ANY);
                    fixture.append(journal); fixture.publish();
                } finally { fixture.data.end(); }
                try (var capture = SearchDeltaJournal.captureRead(fixture.data)) {
                    assertEquals(true, capture.qualification().get("available"));
                    assertEquals("1", capture.qualification().get("qualifiedPopulation"));
                    assertFalse(fixture.data.contains(uri(CommandPolicy.PUBLIC_SEARCH), uri(CONTENT), Node.ANY, Node.ANY));
                    assertEquals(0, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "removed"));
                    assertEquals(1, fixture.hits(CommandPolicy.PUBLIC_SEARCH, "alpha"));
                    var replay = SearchDeltaJournal.qualifiedProof(fixture.data, 1, fixture.publicEpoch.get());
                    assertEquals(true, replay.get("available"));
                    @SuppressWarnings("unchecked")
                    var deltas = (java.util.List<Map<String, Object>>) replay.get("deltas");
                    @SuppressWarnings("unchecked")
                    var changes = (java.util.List<Map<String, Object>>) deltas.getFirst().get("changes");
                    assertEquals(1, changes.size());
                    assertEquals(Map.of("unit", CONTENT, "before", true, "after", false), changes.getFirst());
                }
                var server = server(fixture.data);
                try { assertTrue(cut(query(server, "ASK {}", "true")).get("qualified").getAsBoolean().value()); }
                finally { server.stop(); }
            }
        }
    }

    private static void seedContent(DatasetGraph data, String body) {
            String current = CommandPolicy.CURRENT, revisions = CommandPolicy.REVISIONS, receipts = CommandPolicy.RECEIPTS;
            iri(data, current, VARIANT, RDF.type.getURI(), RV + "ContentVariant");
            iri(data, current, VARIANT, RV + "resource", RESOURCE);
            iri(data, current, VARIANT, RV + "contentPublicationHead", PUBLICATION);
            iri(data, current, VARIANT, RV + "publicSearchEligibilityHead", ELIGIBILITY);
            iri(data, revisions, PUBLICATION, RDF.type.getURI(), RV + "ContentPublicationDecision");
            iri(data, revisions, PUBLICATION, RV + "component", VARIANT);
            iri(data, revisions, PUBLICATION, RV + "resource", RESOURCE);
            iri(data, revisions, PUBLICATION, RV + "contentRevision", REVISION);
            data.add(uri(revisions), uri(PUBLICATION), uri(RV + "byteDigest"), NodeFactory.createLiteralString(DIGEST));
            data.add(uri(revisions), uri(PUBLICATION), uri(RV + "ownerDataEpoch"), NodeFactory.createLiteralString(OWNER_EPOCH));
            iri(data, revisions, ELIGIBILITY, RDF.type.getURI(), RV + "ContentSearchEligibilityDecision");
            iri(data, revisions, ELIGIBILITY, RV + "variant", VARIANT);
            iri(data, revisions, ELIGIBILITY, RV + "resource", RESOURCE);
            iri(data, revisions, ELIGIBILITY, RV + "publicationDecision", PUBLICATION);
            iri(data, revisions, ELIGIBILITY, RV + "disclosure", RV + "Public");
            iri(data, revisions, PROJECTION, RDF.type.getURI(), RV + "ContentProjection");
            iri(data, revisions, PROJECTION, RV + "matchUnit", CONTENT);
            iri(data, revisions, PROJECTION, RV + "component", VARIANT);
            iri(data, revisions, PROJECTION, RV + "resource", RESOURCE);
            iri(data, revisions, PROJECTION, RV + "contentRevision", REVISION);
            iri(data, revisions, PROJECTION, RV + "publicationDecision", PUBLICATION);
            iri(data, revisions, PROJECTION, RV + "eligibility", ELIGIBILITY);
            iri(data, revisions, PROJECTION, RV + "modelRevision", "https://rezics.com/definition/content-match-unit-v1");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RDF.type.getURI(), RV + "MatchUnit");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "field", RV + "Body");
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "disclosure", RV + "Public");
            data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CONTENT), uri(RV + "language"), NodeFactory.createLiteralString("en"));
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "variant", VARIANT);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "resource", RESOURCE);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "revision", REVISION);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "publicationDecision", PUBLICATION);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "eligibility", ELIGIBILITY);
            iri(data, CommandPolicy.PUBLIC_SEARCH, CONTENT, RV + "projection", PROJECTION);
            data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CONTENT), uri(RV + "searchBody"),
                NodeFactory.createLiteralLang(body, "en"));
            iri(data, receipts, RECEIPT, RDF.type.getURI(), RV + "OperationReceipt");
            iri(data, receipts, RECEIPT, RV + "outcome", RV + "Succeeded");
            iri(data, receipts, RECEIPT, RV + "variant", VARIANT);
            iri(data, receipts, RECEIPT, RV + "resource", RESOURCE);
            iri(data, receipts, RECEIPT, RV + "publicationDecision", PUBLICATION);
            iri(data, receipts, RECEIPT, RV + "eligibility", ELIGIBILITY);
            iri(data, receipts, RECEIPT, RV + "projection", PROJECTION);
            iri(data, receipts, RECEIPT, RV + "matchUnit", CONTENT);
            iri(data, receipts, RECEIPT, RV + "contentRevision", REVISION);
            SearchDeltaJournal.retainContentReceiptSource(data, RECEIPT);
    }
    private static void iri(DatasetGraph data, String graph, String subject, String predicate, String object) {
        data.add(uri(graph), uri(subject), uri(predicate), uri(object));
    }
}
