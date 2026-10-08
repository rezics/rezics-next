package com.rezics.jena;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextDocProducerTriples;
import org.apache.jena.query.text.TextIndexConfig;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.store.ByteBuffersDirectory;
import org.junit.Test;

/** Real command transactions, including the last cancellation fence before commit. */
public class WorkNameScopeCommandTest {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri(SlimCommandTest.RV + name); }
    private static Node id(int n) {
        return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", n));
    }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), CONTROL = uri(CommandPolicy.CONTROL),
        PRODUCT = uri("urn:rezics:dataset:product"), SENTINEL = id(70000), MAIN = id(70001),
        PASS = uri("urn:rezics:test:command-scope-pass");
    private static final String SECOND = "https://rezics.com/id/00000000-0000-4000-8000-000000000006";
    private enum Mode { ORDINARY, SLIM, BULK }
    private enum Seam { NONE, EFFECTS, APPEND_END, PRECOMMIT }
    private record Snapshot(Set<Quad> rdf, Set<Quad> singleton, Node source, String basis, boolean complete, Map<String, Object> proof) {}

    private static final class Fixture implements AutoCloseable {
        final ProfileRegistry profiles = SlimCommandTest.profiles();
        final CommandService service = SlimCommandTest.service(profiles);
        final DatasetGraphText data;
        Fixture() { this(true); }
        Fixture(boolean prepareScope) {
            var definition = new EntityDefinition("uri", "label", "graph");
            definition.set("body", p("searchBody"));
            definition.set("publicTitle", p("publicTitle"));
            definition.set("label", uri("http://www.w3.org/2000/01/rdf-schema#label"));
            definition.setLangField("lang"); definition.setUidField("uid");
            var config = new TextIndexConfig(definition); config.setValueStored(true);
            var index = new FilteredGraphTextIndex(new TextIndexLucene(new ByteBuffersDirectory(), config));
            data = new DatasetGraphText(org.apache.jena.tdb2.TDB2Factory.createDataset().asDatasetGraph(),
                index, new TextDocProducerTriples(index));
            index.bindRankData(data);
            var seed = SlimCommandTest.dataset();
            try {
                seed.begin(ReadWrite.READ);
                write(() -> {
                    var rows = seed.find();
                    try { rows.forEachRemaining(data::add); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                    data.add(CONTROL, PRODUCT, p("textIndexGeneration"),
                        uri("urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111"));
                    data.add(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PUBLIC_ANCHOR),
                        RDF.type.asNode(), p("SearchGraphAnchor"));
                    // The command fixture has a legacy header; this independent Work has a valid source proof.
                    data.add(CURRENT, SENTINEL, RDF.type.asNode(), uri("https://schema.org/CreativeWork"));
                    data.add(CURRENT, SENTINEL, p("mainVersion"), MAIN);
                    data.add(CURRENT, SENTINEL, uri("http://www.w3.org/2000/01/rdf-schema#label"),
                        NodeFactory.createLiteralLang("Scope sentinel", "en"));
                    data.add(CURRENT, MAIN, RDF.type.asNode(), p("MainVersion"));
                    data.add(CURRENT, MAIN, p("work"), SENTINEL);
                    for (int n = 0; n < 150; n++) {
                        Node realm = id(80000 + n), slot = CanonicalPolicy.realmOwner(realm, MAIN);
                        data.add(CURRENT, slot, RDF.type.asNode(), p("RealmPublicationSlot"));
                        data.add(CURRENT, slot, p("realm"), realm);
                        data.add(CURRENT, slot, p("mainVersion"), MAIN);
                        data.add(CURRENT, slot, p("work"), SENTINEL);
                        data.add(CURRENT, slot, p("selectionHead"), id(90000 + n));
                        data.add(CURRENT, realm, p("disclosure"), p("Private"));
                    }
                    SearchDeltaJournal.initialize(data); return null;
                });
                seed.end();
            } finally { seed.close(); }
            if (!prepareScope) return;
            assertTrue("exclusive native startup must qualify the real TDB/Lucene fixture", SearchDeltaJournal.qualifyAtStartup(data));
            int visited, total = 0;
            do {
                visited = write(() -> PublicNameProjection.prepareWorkScopeDirectory(data));
                assertTrue(visited >= 0 && visited <= 64); total += visited;
            } while (visited == 64);
            assertEquals(150, total);
            write(() -> { PublicNameProjection.beginWorkScope(data, SENTINEL, PASS); return null; });
            var first = write(() -> PublicNameProjection.advanceWorkScope(data, PASS, uri("urn:rezics:test:first-scope-turn")));
            assertEquals(64, first.visited()); assertFalse(first.complete());
            assertTrue("real Lucene/TDB generation must qualify before commands", SearchDeltaJournal.qualify(data));
        }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T result = operation.get(); data.commit(); return result; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; }
            finally { data.end(); }
        }
        <T> T read(Supplier<T> operation) {
            data.begin(ReadWrite.READ);
            try { return operation.get(); } finally { data.end(); }
        }
        Snapshot snapshot() {
            return read(() -> {
                Set<Quad> rdf = new HashSet<>(); var rows = data.find();
                try { rows.forEachRemaining(rdf::add); }
                finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                var proof = SearchDeltaJournal.qualifiedProof(data, -1, Long.MAX_VALUE - 1);
                assertEquals("qualified native proof", true, proof.get("available"));
                Set<Quad> singleton = rdf.stream().filter(q -> q.getGraph().equals(PublicNameProjection.REPAIR)
                    && q.getSubject().equals(uri(PublicNameProjection.PREFIX + "work-scope-directory")))
                    .collect(java.util.stream.Collectors.toUnmodifiableSet());
                assertFalse(singleton.isEmpty());
                assertTrue(singleton.stream().noneMatch(q -> q.getPredicate().equals(p("scopeVersion"))));
                return new Snapshot(Set.copyOf(rdf), singleton, PublicNameProjection.nameSourceToken(data, SENTINEL),
                    TemplateIndexService.workAdoptionBasis(data, SENTINEL),
                    PublicNameProjection.workScopeComplete(data, PASS), proof);
            });
        }
        Map<String, Object> command(Mode mode, long deadline) {
            String receipt = "urn:rezics:receipt:scope-command:" + mode.name().toLowerCase(java.util.Locale.ROOT);
            String update = SlimCommandTest.update(receipt, SlimCommandTest.OLD, SlimCommandTest.NEW, 0);
            var validations = SlimCommandTest.validations(profiles, SlimCommandTest.NEW);
            return switch (mode) {
                case ORDINARY -> service.runCommand(data, receipt, SlimCommandTest.DIGEST, update, validations, deadline);
                case SLIM -> service.runSlim(data, receipt, SlimCommandTest.DIGEST, update,
                    new CommandService.Slim(SlimCommandTest.PAYLOAD, SlimCommandTest.COMPONENT, SlimCommandTest.NEW),
                    validations, deadline);
                case BULK -> {
                    String secondReceipt = receipt + ":second";
                    String secondUpdate = SlimCommandTest.update(secondReceipt, SlimCommandTest.NEW, SECOND, 1);
                    yield service.runBulk(data, List.of(item(receipt, update, SlimCommandTest.NEW),
                        item(secondReceipt, secondUpdate, SECOND)), deadline);
                }
            };
        }
        CommandService.BulkItem item(String receipt, String update, String revision) {
            String cancellation = cancellation(receipt);
            return new CommandService.BulkItem(receipt, SlimCommandTest.DIGEST, update,
                CommandPolicy.parse(update, receipt), SlimCommandTest.validations(profiles, revision),
                cancellation, CommandPolicy.parse(cancellation, receipt));
        }
        void finishPass() {
            int remaining = 0;
            for (int turn = 0; turn < 3; turn++) {
                final int step = turn;
                var result = write(() -> PublicNameProjection.advanceWorkScope(data, PASS,
                    uri("urn:rezics:test:resumed-scope-turn:" + step)));
                remaining += result.visited();
                if (result.complete()) { assertEquals(86, remaining); return; }
            }
            fail("partial pass did not resume to its exact 86 remaining owners");
        }
        @Override public void close() { SearchDeltaJournal.stopRecovery(data); data.close(); }
    }

    private static String cancellation(String receipt) {
        return """
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n } }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:outcome rv:Cancelled ;
                rv:requestDigest "%s" ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "test" ; rv:sequence ?next }
              GRAPH <urn:rezics:graph:outbox> { <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "test" ; rv:sequence ?next ; rv:eventCount 0 }
            } WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "test" ; rv:routingEpoch "0" ; rv:sequence ?n }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              BIND(?n + 1 AS ?next)
            }
            """.formatted(receipt, SlimCommandTest.DIGEST, receipt, receipt);
    }

    /** An actual interrupted worker, armed only at the requested existing native seam. */
    private static final class CommandThread extends Thread {
        final Fixture fixture; final Mode mode; final Seam seam; final long deadline;
        Map<String, Object> result; Throwable failure; long commits; boolean fired, interruptedAtExit;
        int probes;
        CommandThread(Fixture fixture, Mode mode, Seam seam, long deadline) {
            super("work-command-cancellation-test");
            this.fixture = fixture; this.mode = mode; this.seam = seam; this.deadline = deadline;
        }
        @Override public boolean isInterrupted() {
            if (!fired && seam != Seam.NONE) {
                boolean atSeam = StackWalker.getInstance().walk(frames -> {
                    var iterator = frames.iterator();
                    while (iterator.hasNext()) {
                        var frame = iterator.next();
                        if (frame.getClassName().equals(TemplateIndexService.class.getName())
                            && frame.getMethodName().equals("workScopeBudget") && iterator.hasNext()) {
                            var caller = iterator.next();
                            return switch (seam) {
                                case EFFECTS -> caller.getClassName().equals(SearchDeltaJournal.Capture.class.getName())
                                    && caller.getMethodName().equals("scopeEffects");
                                case APPEND_END -> caller.getClassName().equals(SearchDeltaJournal.class.getName())
                                    && caller.getMethodName().equals("append");
                                case PRECOMMIT -> caller.getClassName().equals(CommandService.class.getName())
                                    && caller.getMethodName().equals(mode == Mode.BULK ? "runBulk" : "runSerialized");
                                case NONE -> false;
                            };
                        }
                    }
                    return false;
                });
                int required = seam == Seam.EFFECTS ? 3 : seam == Seam.APPEND_END ? 2 : 1;
                if (atSeam && ++probes == required) { fired = true; super.interrupt(); }
            }
            return super.isInterrupted();
        }
        @Override public void run() {
            try (var work = new CommandWork()) {
                try { result = fixture.command(mode, deadline); }
                finally {
                    for (String counter : work.counters().split(","))
                        if (counter.startsWith("durable_commits=")) commits = Long.parseLong(counter.substring("durable_commits=".length()));
                }
            } catch (Throwable thrown) { failure = thrown; }
            finally { interruptedAtExit = super.isInterrupted(); Thread.interrupted(); }
        }
    }

    private static CommandThread run(Fixture fixture, Mode mode, Seam seam, boolean expired) throws Exception {
        var worker = new CommandThread(fixture, mode, seam,
            expired ? Long.MIN_VALUE : System.nanoTime() + 60_000_000_000L);
        worker.start(); worker.join(60_000);
        assertFalse("native command did not finish", worker.isAlive());
        if (worker.failure != null) throw new AssertionError("native command worker failed", worker.failure);
        assertNotNull(worker.result); return worker;
    }
    private static void outcome(Mode mode, Map<String, Object> result, String expected) {
        if (mode != Mode.BULK) { assertEquals(result.toString(), expected, result.get("status")); return; }
        assertTrue(result.toString(), result.get("items") instanceof List<?>);
        var items = (List<?>) result.get("items"); assertEquals(2, items.size());
        for (Object item : items) assertEquals(result.toString(), expected, ((Map<?, ?>) item).get("status"));
        if (result.containsKey("status")) assertEquals(expected, result.get("status"));
    }
    private static void unchangedScope(Snapshot before, Snapshot after) {
        assertEquals("unrelated ordinary/slim/bulk command stamped singleton correctness state", before.singleton(), after.singleton());
        assertEquals(before.source(), after.source()); assertEquals(before.basis(), after.basis());
        assertEquals(before.complete(), after.complete()); assertFalse(after.complete());
    }
    private static void cancelledThenRetry(Mode mode, Seam seam, boolean expired) throws Exception {
        try (var fixture = new Fixture()) {
            Snapshot before = fixture.snapshot();
            var cancelled = run(fixture, mode, seam, expired);
            outcome(mode, cancelled.result, "deadline"); assertEquals(0, cancelled.commits);
            if (!expired) { assertTrue("requested cancellation seam was reached", cancelled.fired); assertTrue(cancelled.interruptedAtExit); }
            assertEquals("aborted command changed committed RDF or native scope/index proof", before, fixture.snapshot());
            var retry = run(fixture, mode, Seam.NONE, false);
            outcome(mode, retry.result, "committed"); assertEquals(1, retry.commits);
            Snapshot committed = fixture.snapshot(); unchangedScope(before, committed);
            fixture.read(() -> {
                assertEquals(mode == Mode.BULK ? "2" : "1", SlimCommandTest.streamSequence(fixture.data)); return null;
            });
            var replay = run(fixture, mode, Seam.NONE, false);
            outcome(mode, replay.result, "committed");
            Snapshot replayed = fixture.snapshot();
            assertEquals("lost-ack replay duplicated or changed RDF", committed.rdf(), replayed.rdf());
            unchangedScope(committed, replayed);
            fixture.finishPass();
            System.out.println("Work command cancellation mode=" + mode + " seam=" + (expired ? "EXPIRED" : seam)
                + " commits=" + cancelled.commits + " retry=committed replay=committed remaining=86");
        }
    }

    @Test public void actualEffectAndJournalTraversalCancellationRollsBackAllCommandModes() throws Exception {
        for (Mode mode : Mode.values()) cancelledThenRetry(mode, mode == Mode.SLIM ? Seam.APPEND_END : Seam.EFFECTS, false);
    }
    @Test public void finalPrecommitInterruptionRollsBackAllCommandModesAndEveryBulkOutcome() throws Exception {
        for (Mode mode : Mode.values()) cancelledThenRetry(mode, Seam.PRECOMMIT, false);
    }
    @Test public void expiredNativeDeadlineLeavesAllCommandModesUncommittedAndReplayable() throws Exception {
        for (Mode mode : Mode.values()) cancelledThenRetry(mode, Seam.NONE, true);
    }
    @Test public void failedRepeatedStartupCannotRetainAnEarlierSameStoreAdmission() {
        try (var fixture = new Fixture()) {
            fixture.finishPass();
            Node generation = fixture.read(() -> {
                var rows = fixture.data.find(CONTROL, PRODUCT, p("textIndexGeneration"), Node.ANY);
                try { return rows.next().getObject(); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            });
            fixture.write(() -> { fixture.data.delete(CONTROL, PRODUCT, p("textIndexGeneration"), generation); return null; });
            assertFalse(SearchDeltaJournal.qualifyAtStartup(fixture.data));
            fixture.read(() -> {
                assertFalse(PublicNameProjection.workScopeComplete(fixture.data, PASS));
                assertThrows(IllegalStateException.class, () -> PublicNameProjection.nameSourceToken(fixture.data, SENTINEL)); return null;
            });
            fixture.write(() -> { fixture.data.add(CONTROL, PRODUCT, p("textIndexGeneration"), generation); return null; });
            assertTrue(SearchDeltaJournal.qualifyAtStartup(fixture.data));
            int visited, total = 0;
            do {
                visited = fixture.write(() -> PublicNameProjection.prepareWorkScopeDirectory(fixture.data));
                assertTrue(visited >= 0 && visited <= 64); total += visited;
            } while (visited == 64);
            assertEquals(150, total);
            fixture.read(() -> { assertFalse(PublicNameProjection.workScopeComplete(fixture.data, PASS)); return null; });
        }
    }

    /** Parse the authored production endpoint configuration with Fuseki's own
     * builder, binding its dataset description to this isolated physical store.
     * No server/listener lifecycle is needed to exercise the real startup callback. */
    private static void configuredStartup(Fixture fixture, String additionalOperation) {
        var model = org.apache.jena.riot.RDFDataMgr.loadModel("fuseki-text.ttl");
        String previous = System.getProperty("rezics.profiles");
        System.setProperty("rezics.profiles", "profiles");
        try {
            var module = new CommandModule();
            var service = model.listResourcesWithProperty(RDF.type,
                model.createResource("http://jena.apache.org/fuseki#Service")).nextResource();
            var dataset = service.getPropertyResourceValue(model.createProperty("http://jena.apache.org/fuseki#dataset"));
            if (additionalOperation != null) {
                if (additionalOperation.startsWith("urn:"))
                    org.apache.jena.fuseki.server.Operation.alloc(additionalOperation, "unknown", "unknown writer");
                var endpoint = model.createResource()
                    .addProperty(model.createProperty("http://jena.apache.org/fuseki#operation"), model.createResource(additionalOperation))
                    .addProperty(model.createProperty("http://jena.apache.org/fuseki#name"), "maintenance");
                service.addProperty(model.createProperty("http://jena.apache.org/fuseki#endpoint"), endpoint);
            }
            var descriptions = new org.apache.jena.fuseki.build.DatasetDescriptionMap();
            descriptions.register(dataset.asNode(), fixture.data);
            var point = org.apache.jena.fuseki.build.FusekiConfig.buildDataAccessPoint(
                model.getGraph(), service.asNode(), descriptions);
            assertNotNull(point);
            assertSame("configuration must reconfigure the exact admitted physical store", fixture.data,
                point.getDataService().getDataset());
            assertEquals("/rezics", point.getName());
            assertEquals(additionalOperation == null, CommandService.deltaExclusive(point.getDataService()));
            module.configDataAccessPoint(point, model);
        } finally {
            if (previous == null) System.clearProperty("rezics.profiles");
            else System.setProperty("rezics.profiles", previous);
            model.close();
        }
    }

    private static void uncertified(Fixture fixture) {
        fixture.read(() -> {
            assertFalse(PublicNameProjection.workScopeComplete(fixture.data, PASS));
            assertThrows(IllegalStateException.class, () -> PublicNameProjection.nameSourceToken(fixture.data, SENTINEL));
            return null;
        });
    }

    private static void prepareConfiguredScope(Fixture fixture, String suffix) {
        int total = 0;
        for (int expected : new int[] {64, 64, 22}) {
            uncertified(fixture);
            int visited = fixture.write(() -> PublicNameProjection.prepareWorkScopeDirectory(fixture.data));
            assertEquals(expected, visited); total += visited;
        }
        assertEquals(150, total);
        Node pass = uri("urn:rezics:test:configured-scope:" + suffix);
        fixture.write(() -> { PublicNameProjection.beginWorkScope(fixture.data, SENTINEL, pass); return null; });
        int owners = 0;
        for (int turn = 0; turn < 3; turn++) {
            final int step = turn;
            var result = fixture.write(() -> PublicNameProjection.advanceWorkScope(fixture.data, pass,
                uri("urn:rezics:test:configured-turn:" + suffix + ":" + step)));
            assertTrue(result.visited() <= 64); owners += result.visited();
            assertEquals(turn == 2, result.complete());
        }
        assertEquals(150, owners);
        fixture.read(() -> {
            assertTrue(PublicNameProjection.workScopeComplete(fixture.data, pass));
            assertNotNull(PublicNameProjection.nameSourceToken(fixture.data, SENTINEL)); return null;
        });
    }

    @Test public void productionExclusiveConfigurationAdmitsOnlySeparateBoundedPreparation() {
        try (var fixture = new Fixture(false)) {
            assertFalse(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
            uncertified(fixture);
            configuredStartup(fixture, null);
            assertTrue(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
            prepareConfiguredScope(fixture, "initial");
            System.out.println("Work startup production configuration exclusive=true prepareTurns=64,64,22 ownerTurns=64,64,22");
        }
    }

    @Test public void productionNonexclusiveAndUnknownWriterConfigurationWithdrawSameStoreAdmission() {
        try (var fixture = new Fixture()) {
            fixture.finishPass();
            for (String operation : List.of("http://jena.apache.org/fuseki#update", "urn:rezics:test:unknown-writer")) {
                configuredStartup(fixture, operation);
                assertFalse(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
                uncertified(fixture);
                assertThrows(IllegalStateException.class,
                    () -> fixture.write(() -> PublicNameProjection.prepareWorkScopeDirectory(fixture.data)));
                configuredStartup(fixture, null);
                assertTrue(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
                prepareConfiguredScope(fixture, operation.endsWith("update") ? "raw" : "unknown");
            }
            System.out.println("Work startup production configuration unknown/raw withdrawSameStore=true uncertifiedUntilPrepared=true");
        }
    }

    @Test public void productionFailedFinalAuditDoesNotAdmitThePreviouslyQualifiedStore() {
        try (var fixture = new Fixture()) {
            fixture.finishPass();
            fixture.write(() -> {
                fixture.data.delete(uri(CommandPolicy.PUBLIC_SEARCH), uri(CommandPolicy.PUBLIC_ANCHOR),
                    RDF.type.asNode(), p("SearchGraphAnchor")); return null;
            });
            configuredStartup(fixture, null);
            assertFalse(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
            uncertified(fixture);
            assertThrows(IllegalStateException.class,
                () -> fixture.write(() -> PublicNameProjection.prepareWorkScopeDirectory(fixture.data)));
            System.out.println("Work startup production configuration failedAudit withdrawSameStore=true");
        }
    }

    @Test public void productionEarlyStartupExceptionWithdrawsBeforeTextSchemaInspection() throws Exception {
        try (var fixture = new Fixture()) {
            fixture.finishPass();
            ((FilteredGraphTextIndex) fixture.data.getTextIndex()).lucene().getIndexWriter().close();
            // The closed writer fails inside commit. The helper ends that transaction and would stop the process.
            var halts = new ArrayList<Integer>();
            var lines = new ArrayList<String>();
            var halt = CommitHalt.halt;
            var logged = CommitHalt.logged;
            CommitHalt.halt = halts::add;
            CommitHalt.logged = lines::add;
            Throwable thrown = null;
            try {
                try { configuredStartup(fixture, null); }
                catch (Throwable failure) { thrown = failure; }
            } finally {
                CommitHalt.halt = halt;
                CommitHalt.logged = logged;
            }
            assertNotNull("closed writer must fail startup before text schema inspection", thrown);
            assertEquals(List.of(CommitHalt.STATUS), halts);
            assertEquals(lines.toString(), 1, lines.size());
            assertTrue(lines.get(0), lines.get(0).contains(org.apache.lucene.store.AlreadyClosedException.class.getName()));
            assertFalse(TemplateIndexService.workScopeWriterAdmitted(fixture.data));
            uncertified(fixture);
            System.out.println("Work startup production configuration earlyException withdrawSameStore=true");
        }
    }
    @Test public void currentRecipeMaterializationUsesAnUnmappedPredicateAndLeavesActualLuceneUnchanged() throws Exception {
        try (var fixture = new Fixture()) {
            var index = (FilteredGraphTextIndex) fixture.data.getTextIndex();
            var production = org.apache.jena.riot.RDFDataMgr.loadModel("fuseki-text.ttl");
            try {
                assertFalse(production.contains(null, production.createProperty("http://jena.apache.org/text#predicate"),
                    production.asRDFNode(PublicNameProjection.WORK_NAME_RECIPE_LITERAL)));
            } finally { production.close(); }
            for (String field : index.getDocDef().fields())
                assertFalse("private recipe predicate is text-mapped: " + field,
                    index.getDocDef().getPredicates(field).contains(PublicNameProjection.WORK_NAME_RECIPE_LITERAL));
            int documents;
            try (var reader = org.apache.lucene.index.DirectoryReader.open(index.lucene().getIndexWriter())) { documents = reader.numDocs(); }
            Node source = fixture.read(() -> PublicNameProjection.nameSourceToken(fixture.data, SENTINEL));
            String basis = fixture.read(() -> TemplateIndexService.workAdoptionBasis(fixture.data, SENTINEL));
            Snapshot before = fixture.snapshot();
            Node recipe = fixture.write(() -> PublicNameProjection.beginWorkNameRecipe(fixture.data, SENTINEL,
                uri("urn:recipe:actual-text:begin"), Long.MAX_VALUE));
            var result = fixture.write(() -> PublicNameProjection.advanceWorkNameRecipe(fixture.data, recipe,
                uri("urn:recipe:actual-text:turn"), Long.MAX_VALUE));
            assertTrue(result.complete()); assertEquals(1, result.copies());
            try (var reader = org.apache.lucene.index.DirectoryReader.open(index.lucene().getIndexWriter())) {
                assertEquals(documents, reader.numDocs());
                var searcher = new org.apache.lucene.search.IndexSearcher(reader);
                assertEquals(0, searcher.count(new org.apache.lucene.search.TermQuery(new org.apache.lucene.index.Term(
                    index.getDocDef().getGraphField(), PublicNameProjection.REPAIR.getURI()))));
            }
            Snapshot after = fixture.snapshot();
            assertEquals(before.singleton(), after.singleton()); assertEquals(before.proof(), after.proof());
            assertEquals(source, after.source()); assertEquals(basis, after.basis());
            assertEquals(before.complete(), after.complete());
            assertEquals(before.rdf().stream().filter(q -> !q.getGraph().equals(PublicNameProjection.REPAIR)).collect(java.util.stream.Collectors.toSet()),
                after.rdf().stream().filter(q -> !q.getGraph().equals(PublicNameProjection.REPAIR)).collect(java.util.stream.Collectors.toSet()));
            index.getDocDef().set("accidentalRecipeMapping", PublicNameProjection.WORK_NAME_RECIPE_LITERAL);
            assertThrows(IllegalStateException.class, () -> fixture.write(() -> PublicNameProjection.beginWorkNameRecipe(fixture.data, SENTINEL,
                uri("urn:recipe:must-refuse-mapping"), Long.MAX_VALUE)));
            assertFalse(fixture.read(() -> PublicNameProjection.workNameRecipeComplete(fixture.data, recipe, Long.MAX_VALUE)));
            assertThrows(IllegalStateException.class, () -> fixture.write(() -> PublicNameProjection.advanceWorkNameRecipe(fixture.data, recipe,
                uri("urn:recipe:must-refuse-copy"), Long.MAX_VALUE)));
            System.out.println("Work recipe actualLucene documentsUnchanged=" + documents + " privateRecipeDocuments=0 ownerFanout=0");
        }
    }
}
