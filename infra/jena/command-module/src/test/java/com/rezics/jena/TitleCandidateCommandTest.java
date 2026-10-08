package com.rezics.jena;

import static org.junit.Assert.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.*;
import org.apache.jena.sparql.core.*;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;
import org.junit.FixMethodOrder;
import org.junit.experimental.categories.Category;
import org.junit.runners.MethodSorters;

/** Account/SQL/custody-issued bytes cross the actual command and HTTP branches.
 * The fixture is emitted by the owned SQL acceptance test, never signed here. */
@Category(ExternalFixture.class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
public class TitleCandidateCommandTest {
    private static final String TOKEN = "2".repeat(64);
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static Node id(int n) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", n)); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH), PRODUCT = uri("urn:rezics:dataset:product"),
        PASS = uri("urn:rezics:test:title-candidate-pass");
    private static JsonObject copy(JsonObject value) { return JSON.parse(value.toString()); }
    private static String string(JsonObject value, String key) { return value.get(key).getAsString().value(); }
    private static JsonObject artifact() throws Exception {
        String path = System.getProperty("rezics.title.candidate.fixture");
        assertNotNull("the focused wrapper must supply the actual SQL-issued fixture", path);
        JsonObject fixture = JSON.parse(Files.readString(Path.of(path)));
        assertEquals("rezics-authenticated-title-candidate-fixture-v1", string(fixture, "format"));
        assertEquals("utf8", string(fixture, "titleKeyEncoding"));
        assertEquals("actual Account/SQL/custody receipt session", 1,
            fixture.get("provenance").getAsObject().get("poolMax").getAsNumber().value().intValue());
        return fixture;
    }
    private record Snapshot(Set<Quad> quads, PublicNameProjection.WorkNameBasis basis, Map<String, Object> proof) {}
    private record Run(Map<String, Object> result, long commits, long rows, long probes) {}
    private static final class Measured extends DatasetGraphWrapper {
        boolean interruptOnAcceptance; long rows, probes;
        final ThreadLocal<Boolean> active = ThreadLocal.withInitial(() -> false);
        final ThreadLocal<Boolean> candidateWork = ThreadLocal.withInitial(() -> false);
        Consumer<Quad> afterMutation;
        Measured(DatasetGraph data) { super(data); }
        void start(boolean candidateWork) { rows = 0; probes = 0; active.set(true); this.candidateWork.set(candidateWork); }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            if (!active.get()) return super.find(g, s, p, o);
            probes++;
            if (candidateWork.get() && s.equals(Node.ANY) && (g.equals(CURRENT) || g.equals(PUBLIC)))
                throw new AssertionError("candidate opened a population iterator");
            return org.apache.jena.atlas.iterator.Iter.map(super.find(g, s, p, o), q -> { rows++; return q; });
        }
        @Override public boolean contains(Node g, Node s, Node p, Node o) {
            if (active.get()) {
                probes++;
                if (candidateWork.get() && s.equals(Node.ANY) && (g.equals(CURRENT) || g.equals(PUBLIC)))
                    throw new AssertionError("candidate opened a population existence probe");
            }
            return super.contains(g, s, p, o);
        }
        @Override public void add(Node g, Node s, Node p, Node o) {
            super.add(g, s, p, o);
            if (afterMutation != null) afterMutation.accept(new Quad(g, s, p, o));
            if (interruptOnAcceptance && p.equals(p("retainedTitleCandidate"))) Thread.currentThread().interrupt();
        }
        @Override public void add(Quad quad) {
            super.add(quad);
            if (afterMutation != null) afterMutation.accept(quad);
            if (interruptOnAcceptance && quad.getPredicate().equals(p("retainedTitleCandidate"))) Thread.currentThread().interrupt();
        }
    }
    private static final class Fixture implements AutoCloseable {
        final JsonObject artifact, envelope, frame;
        final Node work, main, head;
        final Measured physical;
        final DatasetGraphText data;
        final CommandService service;
        Fixture(JsonObject artifact, int noise, boolean mapped, Set<Quad> restored) {
            this.artifact = artifact; envelope = copy(artifact.get("envelope").getAsObject());
            frame = JSON.parse(string(envelope.get("titleCandidate").getAsObject(), "frame"));
            JsonObject intent = frame.get("intent").getAsObject();
            work = uri(string(intent, "work")); main = uri(string(frame, "mainVersion")); head = uri(string(intent, "expectedHead"));
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody")); definition.set("publicTitle", p("publicTitle"));
            definition.set("label", org.apache.jena.vocabulary.RDFS.label.asNode());
            if (mapped) definition.set("privateCandidate", p("retainedTitleCandidate"));
            definition.setLangField("lang"); definition.setUidField("uid");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            var index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            physical = new Measured(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph());
            data = new DatasetGraphText(physical, index, new TextDocProducerTriples(index)); index.bindRankData(data);
            service = new CommandService(ProfileRegistry.load(Path.of("profiles")), "1".repeat(64).getBytes(StandardCharsets.UTF_8),
                TOKEN.getBytes(StandardCharsets.UTF_8), string(artifact, "titleKey").getBytes(StandardCharsets.UTF_8));
            write(() -> {
                if (restored != null) restored.forEach(data::add);
                else {
                    data.add(CONTROL, PRODUCT, p("dataEpoch"), NodeFactory.createLiteralString(string(frame, "dataEpoch")));
                    data.add(CONTROL, PRODUCT, p("routingEpoch"), NodeFactory.createLiteralString(string(frame, "routingEpoch")));
                    data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                    data.add(CONTROL, PRODUCT, p("textIndexGeneration"), uri("urn:rezics:text-index-generation:33333333-3333-4333-8333-333333333333"));
                    data.add(PUBLIC, uri(CommandPolicy.PUBLIC_ANCHOR), RDF.type.asNode(), p("SearchGraphAnchor"));
                    data.add(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
                    data.add(CURRENT, work, p("mainVersion"), main); data.add(CURRENT, work, p("head"), head);
                    JsonObject original = artifact.get("originalWorkState").getAsObject();
                    data.add(CURRENT, work, org.apache.jena.vocabulary.RDFS.label.asNode(),
                        NodeFactory.createLiteralLang(string(original, "title"), string(original, "language")));
                    data.add(CURRENT, main, RDF.type.asNode(), p("MainVersion")); data.add(CURRENT, main, p("work"), work);
                    data.add(REVISIONS, head, RDF.type.asNode(), p("RevisionAnchor")); data.add(REVISIONS, head, p("component"), work);
                    data.add(REVISIONS, head, p("manifest"), uri(string(frame, "originalManifest")));
                    data.add(REVISIONS, head, p("modelRevision"), uri("https://rezics.com/definition/work-metadata-v1"));
                    data.add(REVISIONS, head, p("shapeRevision"), uri("https://rezics.com/definition/work-metadata-v1"));
                    for (int i = 0; i < 150; i++) {
                        Node realm = id(50000 + i), slot = CanonicalPolicy.realmOwner(realm, main);
                        data.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
                        data.add(CURRENT, slot, p("work"), work); data.add(CURRENT, slot, p("mainVersion"), main);
                        data.add(CURRENT, slot, p("realm"), realm); data.add(CURRENT, slot, p("selectionHead"), id(60000 + i));
                        data.add(CURRENT, realm, p("disclosure"), p("Private"));
                    }
                    for (int i = 0; i < noise; i++) {
                        data.add(CURRENT, id(70000), p("localizedName"), NodeFactory.createLiteralString("Unrelated alias " + i));
                        if (i < 1001) data.add(CURRENT, work, uri("https://schema.org/alternateName"), NodeFactory.createLiteralString("Current alias " + i));
                    }
                    SearchDeltaJournal.initialize(data);
                }
                PublicNameProjection.workScopeExclusiveStartup(data); return null;
            });
            int visited;
            do { visited = write(() -> PublicNameProjection.prepareWorkScopeDirectory(data)); assertTrue(visited <= 64); }
            while (visited == 64);
            if (restored == null) {
                write(() -> { PublicNameProjection.beginWorkScope(data, work, PASS); return null; });
                var first = write(() -> PublicNameProjection.advanceWorkScope(data, PASS, uri("urn:rezics:test:title-first-turn")));
                assertEquals(64, first.visited()); assertFalse(first.complete());
            }
            assertTrue(SearchDeltaJournal.qualify(data));
        }
        Fixture(JsonObject artifact) { this(artifact, 0, false, null); }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T result = operation.get(); data.commit(); return result; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; } finally { data.end(); }
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ); try { return operation.get(); } finally { data.end(); }
        }
        Set<Quad> quads() { return read(() -> {
            Set<Quad> result = new HashSet<>(); var rows = data.find();
            try { rows.forEachRemaining(result::add); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); } return Set.copyOf(result);
        }); }
        Snapshot snapshot() { return new Snapshot(quads(), read(() -> PublicNameProjection.captureWorkNameBasis(data, work, Long.MAX_VALUE)),
            SearchDeltaJournal.qualifiedProof(data, -1, Long.MAX_VALUE - 1)); }
        Run run(JsonObject command, long deadline) {
            physical.start(true);
            try (var measured = new CommandWork()) {
                var result = service.runTitleCandidate(data, string(command, "receipt"), string(command, "digest"),
                    command.get("titleCandidate"), command.get("titleAdmission"), deadline);
                long commits = Long.parseLong(java.util.Arrays.stream(measured.counters().split(","))
                    .filter(counter -> counter.startsWith("durable_commits=")).findFirst().orElseThrow().substring("durable_commits=".length()));
                return new Run(result, commits, physical.rows, physical.probes);
            } finally { physical.active.remove(); physical.candidateWork.remove(); }
        }
        Run run() { return run(envelope, Long.MAX_VALUE); }
        Run cancel(JsonObject command) {
            assertEquals("actual owner cancellation receipt", string(envelope, "receipt"), string(command, "receipt"));
            assertEquals(string(envelope, "digest"), string(command, "digest"));
            assertTrue(command.get("validations").getAsArray().isEmpty());
            physical.start(false);
            try (var measured = new CommandWork()) {
                var result = service.runCommand(data, string(command, "receipt"), string(command, "digest"),
                    string(command, "update"), java.util.List.of(), System.nanoTime() + 10_000_000_000L);
                long commits = Long.parseLong(java.util.Arrays.stream(measured.counters().split(","))
                    .filter(counter -> counter.startsWith("durable_commits=")).findFirst().orElseThrow().substring("durable_commits=".length()));
                return new Run(result, commits, physical.rows, physical.probes);
            } finally { physical.active.remove(); physical.candidateWork.remove(); }
        }
        void change(Consumer<DatasetGraph> operation) { write(() -> {
            var capture = new SearchDeltaJournal.Capture(data); operation.accept(capture.observed());
            SearchDeltaJournal.append(data, capture, 2); return null;
        }); }
        void resumePass() {
            int remaining = 0;
            for (int i = 0; i < 3; i++) {
                final int turn = i;
                var result = write(() -> PublicNameProjection.advanceWorkScope(data, PASS, uri("urn:rezics:test:title-resume:" + turn)));
                remaining += result.visited();
                if (result.complete()) { assertEquals(86, remaining); return; }
            }
            fail("private acceptance disturbed finite owner cursor");
        }
        @Override public void close() { SearchDeltaJournal.stopRecovery(data); data.close(); }
    }
    private static HttpResponse<String> post(int port, String body, String token) throws Exception {
        var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/data/command"))
            .header("Content-Type", "application/json").header("Authorization", "Bearer " + token)
            .timeout(java.time.Duration.ofSeconds(30)).POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    }
    private static JsonObject lookup(Fixture f) {
        var command = copy(f.envelope); command.get("titleCandidate").getAsObject().put("mode", "lookup"); return command;
    }
    private static void accepted(Run run) { assertEquals(run.result.toString(), "accepted", run.result.get("status")); }

    @Test public void aaAuthenticShortLeaseExpiresWithoutRenewingRetainedNativeHistory() throws Exception {
        JsonObject issued = artifact();
        assertTrue("SQL bridge must issue a real short lease", issued.hasKey("shortLivedEnvelope"));
        var shortIssued = copy(issued); shortIssued.put("envelope", issued.get("shortLivedEnvelope"));
        try (var f = new Fixture(shortIssued)) {
            var expiry = java.time.Instant.parse(string(f.frame.get("admission").getAsObject(), "expiresAt"));
            assertTrue("wrapper must dispatch freshly issued short lease before expiry", expiry.isAfter(java.time.Instant.now()));
            var first = f.run(); accepted(first); assertEquals(1, first.commits()); var retained = f.snapshot();
            long waitStarted = System.nanoTime();
            while (java.time.Instant.now().isBefore(expiry)) {
                long remaining = java.time.Duration.between(java.time.Instant.now(), expiry).toMillis();
                assertTrue("short native expiry proof exceeded its real 60-second lease", System.nanoTime() - waitStarted < 61_000_000_000L);
                Thread.sleep(Math.max(1, Math.min(250, remaining + 1)));
            }
            JsonObject historyEnvelope = issued.get("shortLivedHistoricalEnvelope").getAsObject();
            var history = f.run(historyEnvelope, Long.MAX_VALUE); assertEquals("historical", history.result().get("status"));
            assertEquals(first.result().get("record"), history.result().get("record")); assertEquals(0, history.commits());
            var retry = f.run(); assertEquals("conflict", retry.result().get("status")); assertEquals(0, retry.commits());
            assertEquals(retained, f.snapshot());
            var cancelled = f.cancel(issued.get("shortCancellationEnvelope").getAsObject());
            assertEquals(cancelled.result().toString(), "committed", cancelled.result().get("status")); assertEquals(1, cancelled.commits());
            var terminalState = f.quads(); var terminal = f.run(historyEnvelope, Long.MAX_VALUE);
            assertEquals("terminal", terminal.result().get("status")); assertEquals("cancelled", terminal.result().get("outcome"));
            assertEquals(0, terminal.commits()); assertEquals(terminalState, f.quads());
            System.out.println("Title candidate actual SQL original expiry: accepted while live, exact native history after expiry, fresh refusal and terminal cancellation; no renewed authority");
        }
    }

    @Test public void authenticatedAccountSqlCustodyProofCrossesClosedHttpBranchAndLostAcknowledgement() throws Exception {
        JsonObject issued = artifact();
        try (var f = new Fixture(issued)) {
            var operation = org.apache.jena.fuseki.server.Operation.alloc("urn:rezics:test:title-candidate", "command", "command");
            var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data", f.data)
                .registerOperation(operation, f.service).addEndpoint("/data", "command", operation).build().start();
            try {
                Snapshot before = f.snapshot();
                assertEquals(403, post(server.getPort(), f.envelope.toString(), "1".repeat(64)).statusCode());
                var extra = copy(f.envelope); extra.put("ready", true);
                assertEquals(400, post(server.getPort(), extra.toString(), TOKEN).statusCode());
                assertEquals(before, f.snapshot());
                var response = post(server.getPort(), f.envelope.toString(), TOKEN); assertEquals(response.body(), 200, response.statusCode());
                var accepted = JSON.parse(response.body()); assertEquals(accepted.toString(), "accepted", string(accepted, "status"));
                assertTrue(response.headers().firstValue("X-Rezics-Command-Work").orElseThrow().contains("durable_commits=1"));
                JsonObject record = JSON.parse(string(accepted, "record"));
                JsonObject retainedFrame = JSON.parse(string(record, "frame"));
                assertEquals(TitleControlPolicy.canonicalCandidateJSON(issued.get("expectedActor")),
                    TitleControlPolicy.canonicalCandidateJSON(retainedFrame.get("actor")));
                Snapshot committed = f.snapshot(); assertEquals(before.basis(), committed.basis());
                Set<Quad> added = new HashSet<>(committed.quads()); added.removeAll(before.quads());
                assertEquals(1, added.size()); assertEquals(PublicNameProjection.REPAIR, added.iterator().next().getGraph());
                assertTrue(committed.quads().containsAll(before.quads())); assertEquals(before.proof(), committed.proof());
                var retry = post(server.getPort(), f.envelope.toString(), TOKEN); assertEquals(200, retry.statusCode());
                assertEquals("accepted", string(JSON.parse(retry.body()), "status"));
                assertTrue(retry.headers().firstValue("X-Rezics-Command-Work").orElseThrow().contains("durable_commits=0"));
                assertEquals(committed, f.snapshot());
                var history = post(server.getPort(), lookup(f).toString(), TOKEN);
                assertEquals(200, history.statusCode()); assertEquals("historical", string(JSON.parse(history.body()), "status"));
                assertEquals(committed, f.snapshot()); f.resumePass();
            } finally { server.stop(); }
        }
    }
    @Test public void actualCoreRefusesAlteredSignedFrameCustodyActorManifestAndLegacyTerminal() throws Exception {
        try (var f = new Fixture(artifact())) {
            accepted(f.run()); var committed = f.snapshot();
            for (String tamper : new String[] {"actor", "workManifest", "controlManifest", "originalManifest", "intent", "planned", "custody", "signature"}) {
                var command = copy(f.envelope); var candidate = command.get("titleCandidate").getAsObject();
                var frame = JSON.parse(string(candidate, "frame"));
                switch (tamper) {
                    case "actor" -> frame.get("actor").getAsObject().put("actingSubject", f.main.getURI());
                    case "workManifest", "controlManifest", "originalManifest" -> frame.put(tamper, "urn:rezics:sha256:" + "f".repeat(64));
                    case "intent" -> frame.get("intent").getAsObject().put("title", "Different intent");
                    case "planned" -> frame.get("planned").getAsObject().put("revision", id(80000).getURI());
                    case "custody" -> candidate.put("custodySha256", "f".repeat(64));
                    case "signature" -> command.get("titleAdmission").getAsObject().put("signature", "0".repeat(64));
                    default -> throw new AssertionError(tamper);
                }
                if (!Set.of("custody", "signature").contains(tamper)) candidate.put("frame", TitleControlPolicy.canonicalCandidateJSON(frame));
                var refused = f.run(command, Long.MAX_VALUE); assertEquals(tamper, "conflict", refused.result().get("status"));
                assertEquals(0, refused.commits()); assertEquals(committed, f.snapshot());
            }
            var cancelled = f.cancel(f.artifact.get("cancellationEnvelope").getAsObject());
            assertEquals(cancelled.result().toString(), "committed", cancelled.result().get("status")); assertEquals(1, cancelled.commits());
            var terminal = f.run(); assertEquals("terminal", terminal.result().get("status")); assertEquals("cancelled", terminal.result().get("outcome"));
        }
        try (var f = new Fixture(artifact())) {
            var cancelled = f.cancel(f.artifact.get("cancellationEnvelope").getAsObject());
            assertEquals(cancelled.result().toString(), "committed", cancelled.result().get("status")); assertEquals(1, cancelled.commits());
            var before = f.snapshot(); assertEquals("conflict", f.run().result().get("status")); assertEquals(before, f.snapshot());
        }
    }
    @Test public void actualCoreRefusesChangedSourceAdoptionLineageAndStoreWithoutRebasingHistory() throws Exception {
        JsonObject issued = artifact();
        for (String mutation : new String[] {"alias", "adoption", "head", "erasure", "dataEpoch", "routingEpoch", "raw"}) {
            try (var f = new Fixture(issued)) {
                accepted(f.run());
                f.change(d -> {
                    switch (mutation) {
                        case "alias" -> d.add(CURRENT, f.work, uri("https://schema.org/alternateName"), NodeFactory.createLiteralString("New alias"));
                        case "adoption" -> {
                            var slot = CanonicalPolicy.realmOwner(id(65000), f.main);
                            d.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot")); d.add(CURRENT, slot, p("realm"), id(65000));
                            d.add(CURRENT, slot, p("mainVersion"), f.main); d.add(CURRENT, slot, p("work"), f.work); d.add(CURRENT, slot, p("selectionHead"), id(65001));
                        }
                        case "head" -> { d.deleteAny(CURRENT, f.work, p("head"), Node.ANY); d.add(CURRENT, f.work, p("head"), id(65002)); }
                        case "erasure" -> d.add(REVISIONS, f.head, RDF.type.asNode(), p("ErasedRevision"));
                        case "dataEpoch", "routingEpoch" -> {
                            d.deleteAny(CONTROL, PRODUCT, p(mutation), Node.ANY);
                            d.add(CONTROL, PRODUCT, p(mutation), NodeFactory.createLiteralString("changed-lineage"));
                        }
                        case "raw" -> PublicNameProjection.invalidateWorkScopeQualification(f.data);
                        default -> throw new AssertionError(mutation);
                    }
                });
                var beforeRetry = f.quads(); var retry = f.run(); assertEquals(mutation, "conflict", retry.result().get("status"));
                assertEquals(0, retry.commits()); assertEquals(beforeRetry, f.quads());
                var history = f.run(lookup(f), Long.MAX_VALUE); assertEquals("historical", history.result().get("status"));
                assertEquals(0, history.commits()); assertEquals(beforeRetry, f.quads());
            }
        }
        try (var original = new Fixture(issued)) {
            accepted(original.run()); var retained = original.quads();
            try (var restored = new Fixture(issued, 0, false, retained)) {
                assertNotEquals(original.snapshot().basis().store(), restored.snapshot().basis().store());
                var beforeRetry = restored.quads(); assertEquals("conflict", restored.run().result().get("status"));
                assertEquals("historical", restored.run(lookup(restored), Long.MAX_VALUE).result().get("status")); assertEquals(beforeRetry, restored.quads());
            }
        }
    }
    @Test public void actualOwnerCancellationAndAcceptanceRaceThroughTheSameSerializedNativeWriter() throws Exception {
        JsonObject issued = artifact();
        for (boolean acceptanceFirst : new boolean[] {false, true}) {
            try (var f = new Fixture(issued)) {
                Snapshot before = f.snapshot();
                var entered = new java.util.concurrent.CountDownLatch(1);
                var release = new java.util.concurrent.CountDownLatch(1);
                var secondStarted = new java.util.concurrent.CountDownLatch(1);
                var once = new java.util.concurrent.atomic.AtomicBoolean();
                f.physical.afterMutation = quad -> {
                    Node pause = acceptanceFirst ? p("retainedTitleCandidate") : p("outcome");
                    if (quad.getPredicate().equals(pause) && once.compareAndSet(false, true)) {
                        entered.countDown();
                        try { assertTrue("release first serialized writer", release.await(10, java.util.concurrent.TimeUnit.SECONDS)); }
                        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
                    }
                };
                var candidate = new java.util.concurrent.atomic.AtomicReference<Run>();
                var cancelled = new java.util.concurrent.atomic.AtomicReference<Run>();
                var error = new java.util.concurrent.atomic.AtomicReference<Throwable>();
                Runnable accept = () -> { try { candidate.set(f.run()); } catch (Throwable failure) { error.compareAndSet(null, failure); } };
                Runnable cancel = () -> { try { cancelled.set(f.cancel(issued.get("cancellationEnvelope").getAsObject())); }
                    catch (Throwable failure) { error.compareAndSet(null, failure); } };
                Thread first = new Thread(acceptanceFirst ? accept : cancel, "title-first-native-writer");
                Thread second = new Thread(() -> { secondStarted.countDown(); (acceptanceFirst ? cancel : accept).run(); }, "title-second-native-writer");
                try {
                    first.start(); assertTrue("first owner reached its real native write", entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
                    second.start(); assertTrue(secondStarted.await(10, java.util.concurrent.TimeUnit.SECONDS)); release.countDown();
                    first.join(15000); second.join(15000); assertFalse(first.isAlive()); assertFalse(second.isAlive());
                } finally { release.countDown(); f.physical.afterMutation = null; }
                if (error.get() != null) throw new AssertionError(error.get());
                assertNotNull(candidate.get()); assertNotNull(cancelled.get());
                assertEquals(cancelled.get().result().toString(), "committed", cancelled.get().result().get("status"));
                assertEquals(1, cancelled.get().commits());
                assertEquals(acceptanceFirst ? "accepted" : "conflict", candidate.get().result().get("status"));
                assertEquals(acceptanceFirst ? 1 : 0, candidate.get().commits());
                Snapshot after = f.snapshot(); assertEquals(before.basis(), after.basis());
                assertEquals(before.quads().stream().filter(q -> q.getGraph().equals(CURRENT) || q.getGraph().equals(PUBLIC)).collect(java.util.stream.Collectors.toSet()),
                    after.quads().stream().filter(q -> q.getGraph().equals(CURRENT) || q.getGraph().equals(PUBLIC)).collect(java.util.stream.Collectors.toSet()));
                f.read(() -> {
                    assertEquals(acceptanceFirst ? 1 : 0, org.apache.jena.atlas.iterator.Iter.count(f.data.find(
                        PublicNameProjection.REPAIR, Node.ANY, p("retainedTitleCandidate"), Node.ANY)));
                    assertTrue(f.data.contains(uri(CommandPolicy.RECEIPTS), uri(string(f.envelope, "receipt")), p("outcome"), p("Cancelled")));
                    assertTrue(f.data.contains(CONTROL, uri(CommandInvariant.MAIN_STREAM_SCOPE), p("streamSequence"),
                        NodeFactory.createLiteralByValue(1, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
                    assertEquals(1, org.apache.jena.atlas.iterator.Iter.count(f.data.find(uri(CommandPolicy.OUTBOX), Node.ANY, RDF.type.asNode(), p("OutboxBatch"))));
                    return null;
                });
                var terminalState = f.quads(); var exact = f.run();
                assertEquals(acceptanceFirst ? "terminal" : "conflict", exact.result().get("status")); assertEquals(0, exact.commits());
                var changed = copy(f.envelope); var altered = JSON.parse(string(changed.get("titleCandidate").getAsObject(), "frame"));
                altered.get("actor").getAsObject().put("actingSubject", f.main.getURI());
                changed.get("titleCandidate").getAsObject().put("frame", TitleControlPolicy.canonicalCandidateJSON(altered));
                assertEquals("conflict", f.run(changed, Long.MAX_VALUE).result().get("status")); assertEquals(terminalState, f.quads());
                f.resumePass();
                System.out.println("Title candidate actual cancelTitleControl/Core race acceptanceFirst=" + acceptanceFirst
                    + " cancellation alone advances stream/outbox; CURRENT/PUBLIC/G/B unchanged");
            }
        }
    }
    private static final class CancelledThread extends Thread {
        final Fixture fixture; final boolean finalGuard; Run result; Throwable error; boolean fired; int guards;
        CancelledThread(Fixture fixture, boolean finalGuard) { this.fixture = fixture; this.finalGuard = finalGuard; }
        @Override public boolean isInterrupted() {
            if (finalGuard && !fired && StackWalker.getInstance().walk(frames -> {
                var iterator = frames.iterator();
                while (iterator.hasNext()) {
                    var frame = iterator.next();
                    if (frame.getClassName().equals(TemplateIndexService.class.getName()) && frame.getMethodName().equals("workScopeBudget") && iterator.hasNext()) {
                        var caller = iterator.next(); return caller.getClassName().equals(CommandService.class.getName()) && caller.getMethodName().equals("runTitleCandidate");
                    }
                }
                return false;
            }) && ++guards == 2) { fired = true; super.interrupt(); }
            return super.isInterrupted();
        }
        @Override public void run() {
            try { fixture.physical.interruptOnAcceptance = !finalGuard; result = fixture.run(); }
            catch (Throwable failure) { error = failure; }
            finally { fixture.physical.interruptOnAcceptance = false; Thread.interrupted(); }
        }
    }
    @Test public void actualCoreCancelledPrivateAddAndFinalCommitLeaveAllStateAndCursorUnchanged() throws Exception {
        for (boolean finalGuard : new boolean[] {false, true}) {
            try (var f = new Fixture(artifact())) {
                var before = f.snapshot(); var worker = new CancelledThread(f, finalGuard); worker.start(); worker.join(60000);
                assertFalse(worker.isAlive()); if (worker.error != null) throw new AssertionError(worker.error);
                assertEquals("deadline", worker.result.result().get("status")); assertEquals(0, worker.result.commits());
                if (finalGuard) assertTrue(worker.fired);
                assertEquals(before, f.snapshot());
                var expired = f.run(f.envelope, Long.MIN_VALUE); assertEquals("deadline", expired.result().get("status")); assertEquals(0, expired.commits());
                assertEquals(before, f.snapshot()); accepted(f.run()); accepted(f.run()); f.resumePass();
            }
        }
    }
    @Test public void actualSqlExpiredHistoryCannotCreateFirstAcceptanceAndDepthOrMappingCannotEscape() throws Exception {
        JsonObject issued = artifact();
        assertTrue("SQL bridge must include originally issued now-expired bytes", issued.hasKey("expiredEnvelope"));
        try (var f = new Fixture(issued)) {
            var before = f.snapshot(); var expired = issued.get("expiredEnvelope").getAsObject();
            assertEquals("conflict", f.run(expired, Long.MAX_VALUE).result().get("status")); assertEquals(before, f.snapshot());
            var deep = copy(f.envelope); deep.get("titleCandidate").getAsObject().put("frame", "[".repeat(1000) + "0" + "]".repeat(1000));
            assertEquals("conflict", f.run(deep, Long.MAX_VALUE).result().get("status")); assertEquals(before, f.snapshot());
        }
        try (var f = new Fixture(issued, 0, true, null)) {
            var before = f.snapshot(); assertEquals("conflict", f.run().result().get("status")); assertEquals(before, f.snapshot());
        }
    }
    @Test public void actualCandidatePointWorkDoesNotGrowWithAuthoredOrUnrelatedNameInventory() throws Exception {
        JsonObject issued = artifact(); Run baseline;
        try (var f = new Fixture(issued)) { baseline = f.run(); accepted(baseline); }
        try (var f = new Fixture(issued, 2100, false, null)) {
            var grown = f.run(); accepted(grown); assertEquals(baseline.rows(), grown.rows()); assertEquals(baseline.probes(), grown.probes());
            assertTrue("actual delivered RDF point rows", grown.rows() <= 512); assertTrue("actual point probes", grown.probes() <= 1024);
            System.out.println("Title candidate Account/SQL/custody native+HTTP acceptance point rows=" + grown.rows()
                + " probes=" + grown.probes() + " aliases=1001 unrelated=2100 source/adoption unchanged; cancellation durable_commits=0");
        }
    }
}
