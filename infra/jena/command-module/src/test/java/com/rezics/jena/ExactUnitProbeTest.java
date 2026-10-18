package com.rezics.jena;

import static org.junit.Assert.*;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.Entity;
import org.apache.lucene.index.Term;
import org.junit.Test;

public class ExactUnitProbeTest {
    private static JsonObject request(String graph, String unit, String phrase) {
        var value = new JsonObject();
        value.put("graph", graph);
        value.put("unit", unit);
        value.put("body", ConsistentReadCaptureTest.BODY);
        value.put("language", "en");
        value.put("phrase", phrase);
        return value;
    }
    private static String status(JsonObject result) { return result.get("status").getAsString().value(); }
    private static String probe(ConsistentReadCaptureTest.Fixture fixture, String graph, String unit, String phrase) {
        return status(CommandService.runExactUnitProbe(fixture.data, request(graph, unit, phrase)));
    }

    @Test public void completePostingDistinguishesPhrasePresenceFromACompleteMissInBothGraphs() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH)) {
                String unit = graph.equals(CommandPolicy.PUBLIC_SEARCH)
                    ? ConsistentReadCaptureTest.UNIT : ConsistentReadCaptureTest.PRIVATE_UNIT;
                JsonObject present = CommandService.runExactUnitProbe(fixture.data, request(graph, unit, "alpha beta"));
                assertEquals("present", status(present));
                JsonObject cut = present.get("cut").getAsObject();
                assertTrue(cut.get("available").getAsBoolean().value());
                assertEquals(ConsistentReadCaptureTest.GENERATION, cut.get("generation").getAsString().value());
                assertTrue(cut.get("luceneGeneration").getAsString().value().matches("[1-9][0-9]*"));
                assertEquals("absent", probe(fixture, graph, unit, "gamma delta"));
                assertEquals("a phrase cannot cross or reorder tokens", "absent", probe(fixture, graph, unit, "beta alpha"));
                assertFalse("one native request ends its RDF transaction", fixture.data.isInTransaction());
            }
        }
    }

    @Test(timeout = 30_000) public void commandHttpReportsItsCapabilitiesAndCarriesProbeWorkAndAdmission() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            var operation = org.apache.jena.fuseki.server.Operation.alloc("https://rezics.com/fuseki/command",
                "command", "native captured probe");
            var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).addDataset("/data", fixture.data)
                .fusekiModules(org.apache.jena.fuseki.main.sys.FusekiModules.empty())
                .registerOperation(operation, fixture.service).addEndpoint("/data", "command", operation).build().start();
            try {
                var address = java.net.URI.create("http://127.0.0.1:" + server.getPort() + "/data/command");
                var client = java.net.http.HttpClient.newHttpClient();
                var health = client.send(java.net.http.HttpRequest.newBuilder(address)
                    .timeout(java.time.Duration.ofSeconds(10)).GET().build(), java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(health.body(), 200, health.statusCode());
                JsonObject capabilities = org.apache.jena.atlas.json.JSON.parse(health.body());
                assertTrue(capabilities.get("consistentCaptureAvailable").getAsBoolean().value());
                assertTrue(capabilities.get("exactUnitProbeAvailable").getAsBoolean().value());

                var envelope = new JsonObject();
                envelope.put("exactUnitProbe", request(CommandPolicy.PRIVATE_SEARCH,
                    ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
                var response = client.send(java.net.http.HttpRequest.newBuilder(address)
                    .header("Content-Type", "application/json").header("Authorization", "Bearer " + "2".repeat(64))
                    .timeout(java.time.Duration.ofSeconds(10))
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(envelope.toString())).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(response.body(), 200, response.statusCode());
                JsonObject result = org.apache.jena.atlas.json.JSON.parse(response.body());
                assertEquals("present", status(result));
                assertEquals(ConsistentReadCaptureTest.GENERATION,
                    result.get("cut").getAsObject().get("generation").getAsString().value());
                var counters = new java.util.HashMap<String, Long>();
                for (String entry : response.headers().firstValue("X-Rezics-Command-Work").orElseThrow().split(",")) {
                    String[] value = entry.split("=", 2);
                    counters.put(value[0], Long.parseLong(value[1]));
                }
                assertTrue(counters.get("exact_unit_rdf_rows_visited") > 0);
                assertEquals(Long.valueOf(1), counters.get("exact_unit_postings_visited"));
                assertEquals(Long.valueOf(1), counters.get("exact_unit_phrase_matches_visited"));

                var denied = client.send(java.net.http.HttpRequest.newBuilder(address)
                    .header("Content-Type", "application/json").timeout(java.time.Duration.ofSeconds(10))
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(envelope.toString())).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(denied.body(), 403, denied.statusCode());
                assertEquals("forbidden", status(org.apache.jena.atlas.json.JSON.parse(denied.body())));

                envelope.get("exactUnitProbe").getAsObject().put("unexpected", "field");
                var malformed = client.send(java.net.http.HttpRequest.newBuilder(address)
                    .header("Content-Type", "application/json").header("Authorization", "Bearer " + "2".repeat(64))
                    .timeout(java.time.Duration.ofSeconds(10))
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(envelope.toString())).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
                assertEquals(malformed.body(), 400, malformed.statusCode());
                assertEquals("bad-request", status(org.apache.jena.atlas.json.JSON.parse(malformed.body())));
            } finally { server.stop(); }
        }
    }

    @Test(timeout = 30_000) public void unrelatedWriterHoldingBothEpochsOpenDoesNotRefuseHitOrMiss() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture(); ExecutorService workers = Executors.newFixedThreadPool(2)) {
            var entered = new CountDownLatch(1);
            var release = new CountDownLatch(1);
            var writer = workers.submit(() -> {
                synchronized (fixture.data) {
                    fixture.beginWrite();
                    try {
                        var journal = new SearchDeltaJournal.Capture(fixture.data);
                        fixture.put(journal.observed(), CommandPolicy.PRIVATE_SEARCH,
                            "urn:test:consistent-read:another-principal", "unrelated pending text", "en");
                        fixture.append(journal);
                        entered.countDown();
                        ConsistentReadCaptureTest.await(release);
                        fixture.publish();
                    } finally { if (fixture.data.isInTransaction()) { fixture.data.abort(); fixture.data.end(); } }
                }
            });
            try {
                ConsistentReadCaptureTest.await(entered);
                var read = workers.submit(() -> {
                    for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH)) {
                        String unit = graph.equals(CommandPolicy.PUBLIC_SEARCH)
                            ? ConsistentReadCaptureTest.UNIT : ConsistentReadCaptureTest.PRIVATE_UNIT;
                        assertEquals("present", probe(fixture, graph, unit, "alpha beta"));
                        assertEquals("absent", probe(fixture, graph, unit, "gamma delta"));
                    }
                });
                read.get(2, TimeUnit.SECONDS);
                assertEquals(1L, release.getCount());
            } finally { release.countDown(); }
            writer.get(5, TimeUnit.SECONDS);
        }
    }

    @Test public void missingUnitMembershipCannotBecomeACompleteHitOrMiss() throws Exception {
        for (String graph : List.of(CommandPolicy.PUBLIC_SEARCH, CommandPolicy.PRIVATE_SEARCH)) {
            try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
                String unit = graph.equals(CommandPolicy.PUBLIC_SEARCH)
                    ? ConsistentReadCaptureTest.UNIT : ConsistentReadCaptureTest.PRIVATE_UNIT;
                fixture.data.begin(ReadWrite.WRITE);
                try {
                    fixture.data.delete(ConsistentReadCaptureTest.uri(graph), ConsistentReadCaptureTest.uri(unit),
                        org.apache.jena.vocabulary.RDF.type.asNode(), ConsistentReadCaptureTest.p("MatchUnit"));
                    try (var publication = SearchDeltaJournal.publicationFence()) { fixture.data.commit(); }
                } finally { fixture.data.end(); }
                assertEquals("damaged", probe(fixture, graph, unit, "alpha beta"));
                assertEquals("damaged", probe(fixture, graph, unit, "gamma delta"));
            }
        }
    }

    @Test public void missingPostingCannotBecomeACompleteAbsentAnswer() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            try (var publication = SearchDeltaJournal.publicationFence()) {
                fixture.lucene.getIndexWriter().deleteDocuments(new Term("uri", ConsistentReadCaptureTest.PRIVATE_UNIT));
                fixture.lucene.commit();
            }
            assertEquals("damaged", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
            assertEquals("damaged", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "no matching phrase"));
        }
    }

    @Test(timeout = 30_000) public void postingAndPhraseUseTheSameCutWhenSelectedUnitCommitsDuringTheProbe() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture(); ExecutorService workers = Executors.newSingleThreadExecutor()) {
            var published = new java.util.concurrent.atomic.AtomicBoolean();
            fixture.afterPrivateRead = () -> {
                ConsistentReadCaptureTest.publishDuringRead(workers, () -> fixture.replace(CommandPolicy.PRIVATE_SEARCH,
                    ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta replaced passage", "en"));
                published.set(true);
            };
            assertEquals("captured old RDF, posting and phrase agree after a later commit", "present",
                probe(fixture, CommandPolicy.PRIVATE_SEARCH, ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
            assertTrue("replacement committed during the captured RDF probe", published.get());
            assertEquals("a new probe must see the new cut and detect the stale expected body", "damaged",
                probe(fixture, CommandPolicy.PRIVATE_SEARCH, ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
        }
    }

    private static void replacePosting(ConsistentReadCaptureTest.Fixture fixture, String body, String language,
                                       boolean duplicate) throws Exception {
        var entity = new Entity(ConsistentReadCaptureTest.PRIVATE_UNIT, CommandPolicy.PRIVATE_SEARCH, language, null);
        entity.put("privateBody", body);
        try (var publication = SearchDeltaJournal.publicationFence()) {
            if (!duplicate) fixture.lucene.getIndexWriter().deleteDocuments(new Term("uri", ConsistentReadCaptureTest.PRIVATE_UNIT));
            fixture.lucene.getIndexWriter().addDocument(org.apache.jena.query.text.RezicsLuceneDocument.build(fixture.lucene, entity));
            fixture.lucene.commit();
        }
    }

    @Test public void duplicateWrongBodyAndWrongLanguagePostingsAreDamagedEvenForAMiss() throws Exception {
        for (String damage : List.of("duplicate", "body", "language")) {
            try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
                replacePosting(fixture, damage.equals("body") ? "another selected body" : ConsistentReadCaptureTest.BODY,
                    damage.equals("language") ? "fr" : "en", damage.equals("duplicate"));
                assertEquals(damage, "damaged", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                    ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta"));
            }
        }
    }

    @Test public void capturedExpectedBodyAndLanguageMustAgreeWithTheRdfUnit() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            JsonObject wrongBody = request(CommandPolicy.PRIVATE_SEARCH, ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta");
            wrongBody.put("body", "wrong selected body");
            assertEquals("damaged", status(CommandService.runExactUnitProbe(fixture.data, wrongBody)));
            JsonObject wrongLanguage = request(CommandPolicy.PRIVATE_SEARCH, ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta");
            wrongLanguage.put("language", "fr");
            assertEquals("damaged", status(CommandService.runExactUnitProbe(fixture.data, wrongLanguage)));
            assertEquals("damaged", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                "urn:test:consistent-read:no-unit", "gamma delta"));
        }
    }

    @Test public void privateExactIntegrityDoesNotDependOnPublicGenerationQualification() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            SearchDeltaJournal.dropQualification(fixture.data);
            assertEquals("present", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
            assertEquals("absent", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta"));
            assertEquals("unavailable", probe(fixture, CommandPolicy.PUBLIC_SEARCH,
                ConsistentReadCaptureTest.UNIT, "gamma delta"));
        }
    }

    @Test public void recoveryHoldCannotCertifyACompletePrivateMiss() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            fixture.data.begin(ReadWrite.WRITE);
            try {
                fixture.data.add(ConsistentReadCaptureTest.uri(CommandPolicy.CONTROL),
                    ConsistentReadCaptureTest.uri("urn:rezics:dataset:product"), ConsistentReadCaptureTest.p("restoreHold"),
                    org.apache.jena.graph.NodeFactory.createLiteralByValue(true));
                try (var publication = SearchDeltaJournal.publicationFence()) { fixture.data.commit(); }
            } finally { fixture.data.end(); }
            assertEquals("unavailable", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "gamma delta"));
        }
    }

    @Test public void requestRejectsUnsupportedGraphsExtraFieldsAndOversizedUtf8Values() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            for (String field : List.of("graph", "unit", "body", "language", "phrase", "extra")) {
                JsonObject value = request(CommandPolicy.PRIVATE_SEARCH, ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta");
                value.put(field, switch (field) {
                    case "graph" -> CommandPolicy.CURRENT;
                    case "unit" -> "urn:test:" + "x".repeat(128);
                    case "body" -> "中".repeat(349_526);
                    case "language" -> "x".repeat(65);
                    case "phrase" -> "中".repeat(171);
                    default -> "unsupported";
                });
                assertThrows(field, IllegalArgumentException.class, () -> CommandService.runExactUnitProbe(fixture.data, value));
                assertFalse(fixture.data.isInTransaction());
            }
        }
    }

    private static List<Long> work(ConsistentReadCaptureTest.Fixture fixture) {
        try (var command = new CommandWork()) {
            assertEquals("present", probe(fixture, CommandPolicy.PRIVATE_SEARCH,
                ConsistentReadCaptureTest.PRIVATE_UNIT, "alpha beta"));
            return List.of(CommandWork.currentCount("exact_unit_rdf_rows_visited"),
                CommandWork.currentCount("exact_unit_postings_visited"),
                CommandWork.currentCount("exact_unit_phrase_matches_visited"));
        }
    }

    @Test public void probeReportsActualBoundedVisitsAcrossGrowingUnrelatedInventories() throws Exception {
        try (var fixture = new ConsistentReadCaptureTest.Fixture()) {
            List<Long> before = work(fixture);
            assertTrue("RDF work is reported", before.get(0) > 0);
            assertEquals(Long.valueOf(1), before.get(1));
            assertEquals(Long.valueOf(1), before.get(2));
            fixture.beginWrite();
            try {
                var journal = new SearchDeltaJournal.Capture(fixture.data);
                for (int i = 0; i < 1_024; i++) fixture.put(journal.observed(), CommandPolicy.PRIVATE_SEARCH,
                    "urn:test:consistent-read:inventory:" + i, ConsistentReadCaptureTest.BODY, "en");
                fixture.append(journal);
                fixture.publish();
            } finally { if (fixture.data.isInTransaction()) { fixture.data.abort(); fixture.data.end(); } }
            assertEquals("unrelated phrase matches do not increase native probe visits", before, work(fixture));
        }
    }
}
