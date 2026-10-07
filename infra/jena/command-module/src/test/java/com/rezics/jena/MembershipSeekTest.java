package com.rezics.jena;

import static org.junit.Assert.*;

import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.*;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.tdb2.sys.TDBInternal;
import org.apache.jena.tdb2.store.tupletable.TupleIndexRecord;
import org.apache.jena.tdb2.store.tupletable.TupleIndexWrapper;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

/** Real tuple reads, including normalized skips, must fit each preparation turn. */
public class MembershipSeekTest {
    private static final String RV = "https://rezics.com/vocab/", SCHEMA = "https://schema.org/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        CONTROL = uri(CommandPolicy.CONTROL), PRODUCT = uri("urn:rezics:dataset:product"),
        STRUCTURE = id(1), GENERATION = id(2), SEGMENT = id(3), HEAD = id(4);
    private static final Node LIST = uri("urn:rezics:item-list:" + hash(GENERATION.getURI() + '\0' + STRUCTURE.getURI()));
    private static final ProfileRegistry PROFILES = ProfileRegistry.load(Path.of("profiles"));
    private static long maxFocusedRows;
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node s(String value) { return uri(SCHEMA + value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node id(int value) { return uri("https://rezics.com/id/00000000-0000-4000-8000-%012d".formatted(value)); }
    private static String hash(String value) { return StatementUpgradePolicy.templateDigest(value); }
    private static void write(DatasetGraph data, Runnable action) {
        data.begin(ReadWrite.WRITE);
        try { MembershipNormalFormPolicy.invalidate(data); action.run(); data.commit(); } finally { data.end(); }
    }
    private static DatasetGraph fixture(int legacy, int normalized, int removed, int unrelated) {
        var data = TDB2Factory.createDataset().asDatasetGraph();
        write(data, () -> {
            data.add(CONTROL, PRODUCT, p("dataEpoch"), text("epoch"));
            data.add(CONTROL, PRODUCT, p("routingEpoch"), text("routing"));
            data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(7, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
            data.add(CURRENT, STRUCTURE, RDF.type.asNode(), p("Structure"));
            data.add(CURRENT, STRUCTURE, p("structureProfile"), p("BookComposition"));
            data.add(CURRENT, STRUCTURE, p("structureHead"), HEAD);
            data.add(CURRENT, STRUCTURE, p("selectedGeneration"), GENERATION);
            data.add(CURRENT, GENERATION, RDF.type.asNode(), p("StructureGeneration"));
            data.add(CURRENT, GENERATION, p("structure"), STRUCTURE);
            data.add(CURRENT, SEGMENT, RDF.type.asNode(), p("OrderSegment"));
            data.add(CURRENT, SEGMENT, p("generation"), GENERATION);
            data.add(CURRENT, SEGMENT, p("parent"), STRUCTURE);
            data.add(CURRENT, SEGMENT, p("segmentKey"), text("0"));
            data.add(REVISIONS, HEAD, RDF.type.asNode(), p("StructureRevision"));
            data.add(REVISIONS, HEAD, p("manifest"), uri("urn:rezics:sha256:" + "a".repeat(64)));
            for (int i = 0; i < legacy + normalized + removed; i++) {
                Node placement = id(10000 + i), occurrence = id(100000 + i), target = id(200000 + i);
                data.add(CURRENT, occurrence, RDF.type.asNode(), s("ListItem"));
                data.add(CURRENT, placement, RDF.type.asNode(), p(i >= legacy + normalized ? "RemovedPlacement" : "OccurrencePlacement"));
                data.add(CURRENT, placement, p("generation"), GENERATION);
                data.add(CURRENT, placement, p("occurrence"), occurrence);
                data.add(CURRENT, placement, p("occurrenceRole"), p("ChapterRole"));
                if (i >= legacy + normalized) {
                    data.add(CURRENT, placement, p("lastParent"), STRUCTURE);
                    data.add(CURRENT, placement, p("removedBy"), HEAD);
                } else {
                    data.add(CURRENT, placement, p("orderSegment"), SEGMENT);
                    data.add(CURRENT, placement, p("orderKey"), text(Integer.toString(i + 1, 36)));
                }
                if (i >= legacy && i < legacy + normalized) normalize(data, placement, target, i);
                else data.add(CURRENT, placement, p("target"), target);
            }
            for (int i = 0; i < unrelated; i++) {
                data.add(CURRENT, id(500000 + i), RDF.type.asNode(), p("UnrelatedType"));
                data.add(CURRENT, id(500000 + i), p("unrelatedValue"), text("unrelated " + i));
            }
        });
        return data;
    }
    private static void normalize(DatasetGraph data, Node placement, Node target, int i) {
        data.add(CURRENT, placement, RDF.type.asNode(), s("ListItem"));
        data.add(CURRENT, placement, s("item"), target);
        data.add(CURRENT, placement, s("position"), text("0-" + Integer.toString(i + 1, 36)));
        data.add(CURRENT, LIST, RDF.type.asNode(), s("ItemList"));
        data.add(CURRENT, LIST, p("generation"), GENERATION);
        data.add(CURRENT, LIST, p("parent"), STRUCTURE);
        data.add(CURRENT, LIST, s("itemListElement"), placement);
    }
    private static JsonObject request() {
        var request = new JsonObject();
        request.put("operation", "membership-prepare"); request.put("dataEpoch", "epoch"); request.put("routingEpoch", "routing");
        request.put("requestId", UUID.randomUUID().toString()); request.put("deadline", System.currentTimeMillis() + 60_000);
        return request;
    }
    private static JsonObject request(String epoch, String routing) {
        JsonObject request = request(); request.put("dataEpoch", epoch); request.put("routingEpoch", routing); return request;
    }
    private static Map<String,Object> prepare(DatasetGraph data, JsonObject request) {
        return TemplateIndexService.membershipPrepare(data, request, PROFILES);
    }
    private static Set<Quad> snapshot(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try { return new HashSet<>(Iter.toList(data.find())); } finally { data.end(); }
    }
    private static Set<Quad> completedProof(DatasetGraph data) {
        return snapshot(data).stream().filter(quad -> quad.getGraph().equals(uri(TemplateIndexService.STATE))
            && quad.getSubject().equals(uri("urn:rezics:membership-preparation"))
            && quad.getPredicate().equals(p("membershipCompletedForm"))).collect(java.util.stream.Collectors.toSet());
    }
    private static boolean needsPreparation(DatasetGraph data) {
        var request = new JsonObject(); request.put("operation", "membership-status");
        return Boolean.TRUE.equals(TemplateIndexService.read(data, request).get("needsPreparation"));
    }
    /** Count actual range iterator reads instead of trusting the response's examined count. */
    private static long[] countPhysicalRows(DatasetGraph data) {
        var table = TDBInternal.requireStorage(DatasetGraphWrapper.unwrap(data)).getQuadTable().getNodeTupleTable().getTupleTable();
        var original = table.selectIndex("GPOS");
        var record = (TupleIndexRecord) original.baseTupleIndex();
        long[] visited = {0};
        var range = (org.apache.jena.dboe.index.RangeIndex) Proxy.newProxyInstance(
            org.apache.jena.dboe.index.RangeIndex.class.getClassLoader(), new Class<?>[]{org.apache.jena.dboe.index.RangeIndex.class},
            (proxy, method, args) -> {
                Object result = method.invoke(record.getRangeIndex(), args);
                if (method.getName().equals("iterator")) return Iter.map((Iterator<?>) result, value -> { visited[0]++; return value; });
                return result;
            });
        var counted = new TupleIndexRecord(4, original.getMapping(), "GPOS", range.getRecordFactory(), range);
        for (int i = 0; i < table.numIndexes(); i++) if (table.getIndex(i) == original)
            table.setTupleIndex(i, new TupleIndexWrapper(original) {
                @Override public org.apache.jena.tdb2.store.tupletable.TupleIndex baseTupleIndex() { return counted; }
            });
        return visited;
    }
    private static final class Focused extends DatasetGraphWrapper {
        long returned;
        Focused(DatasetGraph data) { super(data); }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            if (graph.equals(CURRENT) && predicate.equals(Node.ANY) && object.equals(Node.ANY))
                fail("native preparation must read authored fields instead of complete subjects");
            if (graph.equals(CURRENT) && predicate.equals(s("itemListElement")) && object.equals(Node.ANY))
                fail("native preparation must not revisit the parent's complete membership population");
            return Iter.map(super.find(graph, subject, predicate, object), quad -> {
                if (quad.getGraph().equals(CURRENT) && quad.getPredicate().equals(s("itemListElement")) && object.equals(Node.ANY))
                    fail("broad parent reads must not filter membership edges after visiting them");
                returned++; return quad;
            });
        }
    }
    private static int drain(DatasetGraph data, long[] records, int maxTurns) {
        int converted = 0;
        for (int turn = 0; turn < maxTurns; turn++) {
            long before = records[0];
            var focused = new Focused(data);
            var result = prepare(focused, request());
            assertEquals(result.toString(), "committed", result.get("status"));
            assertTrue("tuple reads exceeded turn bound: " + (records[0] - before), records[0] - before <= 256);
            maxFocusedRows = Math.max(maxFocusedRows, focused.returned);
            assertTrue("focused row reads exceeded turn bound: " + focused.returned, focused.returned <= 10_000);
            assertTrue(((Number) result.get("examined")).intValue() <= 256);
            assertTrue(((Number) result.get("placements")).intValue() <= 24);
            converted += ((Number) result.get("placements")).intValue();
            if (Boolean.TRUE.equals(result.get("complete"))) return converted;
        }
        throw new AssertionError("bounded turns never proved exhaustive membership conversion");
    }
    @Test public void thousandsOfPlacementsAreExhaustiveWithoutRescanningConvertedPrefixesOrUnrelatedGrowth() {
        for (int unrelated : List.of(0, 5000)) {
            var data = fixture(3100, 300, 101, unrelated);
            try {
                var preserved = snapshot(data).stream().filter(q -> q.getGraph().equals(REVISIONS)
                    || q.getPredicate().equals(p("structureHead")) || q.getPredicate().equals(p("selectedGeneration"))).collect(java.util.stream.Collectors.toSet());
                long[] records = countPhysicalRows(data);
                maxFocusedRows = 0;
                long start = System.nanoTime();
                assertEquals(3201, drain(data, records, 300));
                assertTrue("every placement and every edge must have been examined", records[0] >= 6901);
                assertTrue("converted prefix was scanned repeatedly: " + records[0], records[0] < 9000);
                long before = records[0];
                assertFalse(needsPreparation(data)); assertEquals(before, records[0]);
                assertEquals(0, drain(data, records, 1)); assertEquals(before, records[0]);
                data.begin(ReadWrite.READ);
                try {
                    assertFalse(data.contains(CURRENT, Node.ANY, p("target"), Node.ANY));
                    assertEquals(3400, Iter.count(data.find(CURRENT, LIST, s("itemListElement"), Node.ANY)));
                    for (int i = 0; i < 3501; i++) assertTrue(data.contains(CURRENT, id(10000 + i), s("item"), id(200000 + i)));
                    for (Quad q : preserved) assertTrue(data.contains(q));
                } finally { data.end(); }
                System.out.println("membership preparation legacy=3201 normalized=300 unrelated=" + unrelated
                    + " physicalRows=" + records[0] + " maxFocusedRows=" + maxFocusedRows
                    + " elapsedMs=" + (System.nanoTime() - start) / 1_000_000);
            } finally { data.close(); }
        }
    }
    @Test public void lostAcknowledgmentReplaysExactResultWithoutMutatingOrAdvancingContinuation() {
        var data = fixture(80, 0, 0, 0);
        try {
            long[] records = countPhysicalRows(data);
            JsonObject request = request(); var first = prepare(data, request);
            assertEquals("committed", first.get("status")); assertFalse(Boolean.TRUE.equals(first.get("complete")));
            Set<Quad> after = snapshot(data); long before = records[0];
            assertEquals(first, prepare(data, request)); assertEquals(before, records[0]); assertEquals(after, snapshot(data));
            var altered = org.apache.jena.atlas.json.JSON.parse(request.toString());
            altered.put("deadline", request.get("deadline").getAsNumber().value().longValue() + 1);
            assertEquals("conflict", prepare(data, altered).get("status"));
            assertEquals(after, snapshot(data)); assertEquals(before, records[0]);
            write(data, () -> data.add(CURRENT, id(500000), p("unrelatedValue"), text("external write")));
            Set<Quad> changed = snapshot(data);
            assertEquals(first, prepare(data, request)); assertEquals(changed, snapshot(data));
            assertEquals(before, records[0]); assertTrue(needsPreparation(data));
            assertEquals(56, drain(data, records, 30));
            assertEquals(first, prepare(data, request));
            assertFalse(needsPreparation(data));
        } finally { data.close(); }
    }
    @Test public void deadlineAndLineageFailuresLeaveEveryQuadUnchangedAndResumeAtTheCommittedBoundary() {
        var data = fixture(80, 0, 0, 0);
        try {
            long[] records = countPhysicalRows(data); var first = prepare(data, request());
            assertEquals(24, first.get("placements")); Set<Quad> committed = snapshot(data);
            var expired = request(); expired.put("deadline", System.currentTimeMillis() - 1);
            assertEquals("deadline", prepare(data, expired).get("status")); assertEquals(committed, snapshot(data));
            var during = request(); during.put("deadline", System.currentTimeMillis() + 1000);
            var delayed = new DatasetGraphWrapper(data) {
                boolean delayedOnce;
                int attemptedAdds;
                @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                    attemptedAdds++; super.add(graph, subject, predicate, object);
                }
                @Override public Iterator<Quad> find(Node g, Node subject, Node predicate, Node object) {
                    if (!delayedOnce && g.equals(CURRENT)) {
                        delayedOnce = true;
                        try { Thread.sleep(1100); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
                    }
                    return super.find(g, subject, predicate, object);
                }
            };
            assertEquals("deadline", prepare(delayed, during).get("status"));
            assertTrue("deadline must roll back mutations already attempted inside the turn", delayed.attemptedAdds > 0);
            assertEquals(committed, snapshot(data));
            Thread.currentThread().interrupt();
            try { assertEquals("deadline", prepare(data, request()).get("status")); }
            finally { Thread.interrupted(); }
            assertEquals(committed, snapshot(data));
            var wrong = request(); wrong.put("dataEpoch", "other");
            assertEquals("guard-unmatched", prepare(data, wrong).get("status")); assertEquals(committed, snapshot(data));
            write(data, () -> data.add(CONTROL, PRODUCT, p("restoreHold"), NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)));
            Set<Quad> held = snapshot(data);
            assertEquals("guard-unmatched", prepare(data, request()).get("status")); assertEquals(held, snapshot(data));
            write(data, () -> data.deleteAny(CONTROL, PRODUCT, p("restoreHold"), Node.ANY));
            assertEquals(56, drain(data, records, 30));
        } finally { data.close(); }
    }
    @Test public void completionProofIsInvalidatedByExternalWritesAndNoOutputCapCertifiesACompletedPopulation() {
        var data = fixture(0, 600, 0, 0);
        try {
            long[] records = countPhysicalRows(data);
            var first = prepare(data, request()); assertEquals(0, first.get("placements"));
            assertFalse(Boolean.TRUE.equals(first.get("complete"))); assertTrue(needsPreparation(data));
            assertEquals(0, drain(data, records, 30)); assertFalse(needsPreparation(data));
            write(data, () -> data.deleteAny(CURRENT, id(10599), s("position"), Node.ANY));
            assertTrue(needsPreparation(data));
            assertEquals(1, drain(data, records, 30)); assertFalse(needsPreparation(data));
        } finally { data.close(); }
    }
    @Test public void malformedPlacementsAndDanglingExistingMembershipNeverYieldAnExhaustiveSuccess() {
        for (String defect : List.of("generation", "conflicting-target", "dangling-edge", "owner-role", "unknown-profile")) {
            var data = fixture(1, 0, 0, 0);
            try {
                write(data, () -> {
                    if (defect.equals("generation")) data.deleteAny(CURRENT, id(10000), p("generation"), Node.ANY);
                    else if (defect.equals("conflicting-target")) data.add(CURRENT, id(10000), s("item"), id(999));
                    else if (defect.equals("owner-role")) {
                        data.deleteAny(CURRENT, id(10000), p("occurrenceRole"), Node.ANY);
                        data.add(CURRENT, id(10000), p("occurrenceRole"), p("PartRole"));
                    } else if (defect.equals("unknown-profile")) {
                        data.deleteAny(CURRENT, STRUCTURE, p("structureProfile"), Node.ANY);
                        data.add(CURRENT, STRUCTURE, p("structureProfile"), p("UnknownComposition"));
                    }
                    else {
                        normalize(data, id(10000), id(200000), 0);
                        data.deleteAny(CURRENT, id(10000), p("target"), Node.ANY);
                        data.add(CURRENT, LIST, s("itemListElement"), id(999));
                    }
                });
                boolean denied = false;
                for (int turn = 0; turn < 20 && !denied; turn++) {
                    Set<Quad> before = snapshot(data);
                    try {
                        var result = prepare(data, request());
                        if (!"committed".equals(result.get("status"))) { denied = true; assertEquals(before, snapshot(data)); }
                        else assertFalse("malformed membership certified complete: " + defect, Boolean.TRUE.equals(result.get("complete")));
                    } catch (IllegalArgumentException expected) { denied = true; assertEquals(before, snapshot(data)); }
                }
                assertTrue("malformed membership was never rejected: " + defect, denied);
                assertTrue(needsPreparation(data));
            } finally { data.close(); }
        }
    }
    @Test public void copiedPhysicalNodeOrderRestartsUnsafeCheckpointAndStillConvertsEveryRemainingPlacement() {
        var original = fixture(100, 0, 0, 0); List<Quad> quads;
        try {
            assertEquals(24, prepare(original, request()).get("placements"));
            quads = new ArrayList<>(snapshot(original));
        } finally { original.close(); }
        var copy = TDB2Factory.createDataset().asDatasetGraph();
        try {
            write(copy, () -> {
                // Allocate subjects in the opposite order before copying durable progress.
                for (int i = 99; i >= 0; i--) copy.add(CURRENT, id(10000 + i), p("temporary"), text("allocate"));
                quads.forEach(copy::add);
                copy.deleteAny(CURRENT, Node.ANY, p("temporary"), Node.ANY);
            });
            assertTrue(needsPreparation(copy));
            long[] records = countPhysicalRows(copy); var restarted = prepare(copy, request());
            assertTrue(Boolean.TRUE.equals(restarted.get("restarted")));
            int first = ((Number) restarted.get("placements")).intValue();
            assertEquals(76, first + drain(copy, records, 30)); assertFalse(needsPreparation(copy));
            copy.begin(ReadWrite.READ);
            try { assertEquals(100, Iter.count(copy.find(CURRENT, LIST, s("itemListElement"), Node.ANY))); }
            finally { copy.end(); }
        } finally { copy.close(); }
    }
    @Test public void partRoleQualifierAndStructuralGroupKeepCanonicalMeaningAndOrderKeys() {
        var data = fixture(3, 0, 1, 0);
        try {
            write(data, () -> {
                data.deleteAny(CURRENT, STRUCTURE, p("structureProfile"), Node.ANY);
                data.add(CURRENT, STRUCTURE, p("structureProfile"), p("WorkComposition"));
                for (int i = 0; i < 4; i++) {
                    data.deleteAny(CURRENT, id(10000 + i), p("occurrenceRole"), Node.ANY);
                    data.add(CURRENT, id(10000 + i), p("occurrenceRole"), p(i == 2 ? "GroupRole" : "PartRole"));
                }
                data.deleteAny(CURRENT, id(10001), p("target"), Node.ANY);
                data.add(CURRENT, id(10001), p("qualifier"), id(400001));
                data.deleteAny(CURRENT, id(10002), p("target"), Node.ANY);
            });
            long[] records = countPhysicalRows(data); assertEquals(4, drain(data, records, 20));
            data.begin(ReadWrite.READ);
            try {
                assertTrue(data.contains(CURRENT, id(10000), s("item"), id(200000)));
                assertTrue(data.contains(CURRENT, id(10001), s("item"), id(400001)));
                assertTrue(data.contains(CURRENT, id(10002), s("item"), id(100002)));
                assertTrue(data.contains(CURRENT, id(10003), s("item"), id(200003)));
                assertFalse(data.contains(CURRENT, id(10003), RDF.type.asNode(), s("ListItem")));
                for (int i = 0; i < 3; i++) {
                    assertTrue(data.contains(CURRENT, id(10000 + i), p("orderKey"), text(Integer.toString(i + 1, 36))));
                    assertTrue(data.contains(CURRENT, id(10000 + i), s("position"), text("0-" + Integer.toString(i + 1, 36))));
                }
            } finally { data.end(); }
        } finally { data.close(); }
    }
    @Test public void unrelatedExtensionPropertiesOnThePlacementDoNotInflatePreparationOrDisappear() {
        List<Long> baseline = null;
        for (int extensions : List.of(0, 2000)) {
            var data = fixture(1, 0, 0, 0);
            try {
                if (extensions > 0) write(data, () -> {
                    for (int i = 0; i < extensions; i++)
                        data.add(CURRENT, id(10000), uri("urn:rezics:extension:" + i), text("extension value " + i));
                });
                long[] physical = countPhysicalRows(data); var focused = new Focused(data);
                var result = prepare(focused, request());
                assertEquals("committed", result.get("status")); assertTrue(Boolean.TRUE.equals(result.get("complete")));
                assertEquals(1, result.get("placements"));
                List<Long> cost = List.of(physical[0], focused.returned);
                if (baseline == null) baseline = cost;
                else assertEquals("unrelated extensions increased physical work", baseline, cost);
                data.begin(ReadWrite.READ);
                try {
                    for (int i = 0; i < extensions; i++) assertTrue(data.contains(CURRENT, id(10000),
                        uri("urn:rezics:extension:" + i), text("extension value " + i)));
                } finally { data.end(); }
                System.out.println("membership extension properties=" + extensions + " physicalRows=" + physical[0]
                    + " focusedRows=" + focused.returned);
            } finally { data.close(); }
        }
    }
    @Test public void processRestartAndActualCompactionInvalidatePersistedPhysicalContinuations() throws Exception {
        Files.createDirectories(Path.of(".temp"));
        Path directory = Files.createTempDirectory(Path.of(".temp"), "membership-restart-").toAbsolutePath();
        // TDB's connection cache retains its directory lock after Dataset.close.
        // Only the seed process opens this directory before the restart process.
        assertTrue(probe(directory, "seed").contains("membership persisted first turn: converted=24"));
        String output = probe(directory, "resume");
        assertTrue(output, output.contains("membership restart and compaction: remaining=76"));
        System.out.print(output);
    }
    private static DatasetGraph metadataFixture() {
        var seed = SlimCommandTest.dataset();
        var data = TDB2Factory.createDataset().asDatasetGraph();
        try { Set<Quad> initial = snapshot(seed); write(data, () -> initial.forEach(data::add)); }
        finally { seed.close(); }
        return data;
    }
    private static void completedMetadataFixture(DatasetGraph data) {
        var result = prepare(data, request("test", "0"));
        assertEquals("committed", result.get("status")); assertTrue(Boolean.TRUE.equals(result.get("complete")));
        assertEquals(0, result.get("examined")); assertFalse(needsPreparation(data));
    }
    private static String controlCommand(String receipt) {
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
    private static Map<String,Object> activateInitialModel(CommandService service, DatasetGraph data) {
        String generation = "urn:rezics:model-generation:" + "e".repeat(64), head = "urn:rezics:model:product";
        String receipt = "urn:rezics:receipt:" + hash(generation + '\0' + "model-generation");
        String profile = "https://rezics.com/definition/semantic-model-generation-v1", operation = id(900).getURI();
        String digest = hash("{\"family\":\"model-generation-v1\",\"manifest\":\"" + "e".repeat(64) + "\"}");
        String update = """
            PREFIX rv: <https://rezics.com/vocab/>
            DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n } }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:current> { <%s> a rv:ModelComponent ; rv:generationHead <%s> . }
              GRAPH <urn:rezics:graph:revisions> { <%s> a rv:ModelGeneration, rv:RevisionAnchor ;
                rv:component <%s> ; rv:generationNumber 1 ; rv:manifest <urn:rezics:sha256:%s> ;
                rv:commandModuleVersion "%s" ; rv:entailmentProfile rv:NoEntailment ; rv:identityInference rv:Excluded ;
                rv:validationPosture rv:RejectOnViolation ; rv:operation <%s> ; rv:modelRevision <%s> ; rv:shapeRevision <%s> ;
                rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "test" ; rv:sequence ?next . }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:operation <%s> ; rv:requestDigest "%s" ;
                rv:outcome rv:Succeeded ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "test" ; rv:sequence ?next . }
              GRAPH <urn:rezics:graph:outbox> { <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "test" ; rv:sequence ?next ;
                rv:eventCount 1 ; rv:event <%s:event> . <%s:event> a rv:ModelGenerationRecordedEvent ;
                rv:ordinal 0 ; rv:action "model.generation.record" ; rv:receipt <%s> . }
            } WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "test" ; rv:routingEpoch "0" ; rv:sequence ?n }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:current> { <%s> ?p ?o } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:revisions> { <%s> ?p ?o } }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              BIND(?n + 1 AS ?next)
            }
            """.formatted(head, generation, generation, head, "f".repeat(64), PROFILES.commandModule(), operation, profile, profile,
                receipt, operation, digest, receipt, receipt, receipt, receipt, head, generation, receipt);
        List<String> graphs = List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS);
        List<CommandService.Validation> checks = List.of(
            new CommandService.Validation("semantic-model-generation-v1", PROFILES.get("semantic-model-generation-v1"),
                profile + "/generation-shape", List.of(generation), graphs, Map.of()),
            new CommandService.Validation("semantic-model-generation-v1", PROFILES.get("semantic-model-generation-v1"),
                profile + "/head-shape", List.of(head), graphs, Map.of()));
        return service.runCommand(data, receipt, digest, update, checks, System.nanoTime() + 30_000_000_000L);
    }
    /** A completed representation proof belongs to its owner facts, not every unrelated native transaction. */
    @Test public void completedPreparationRemainsCurrentAfterNormalProductAndSameEpochControlCommands() {
        var data = metadataFixture();
        try {
            completedMetadataFixture(data); long[] physical = countPhysicalRows(data); Set<Quad> completion = completedProof(data);
            assertEquals(1, completion.size());
            var service = SlimCommandTest.service(PROFILES);
            var product = service.runCommand(data, SlimCommandTest.RECEIPT, SlimCommandTest.DIGEST,
                SlimCommandTest.update(SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0),
                SlimCommandTest.validations(PROFILES, SlimCommandTest.NEW), System.nanoTime() + 30_000_000_000L);
            assertEquals(product.toString(), "committed", product.get("status"));
            String receipt = SlimCommandTest.RECEIPT + ":control";
            var control = service.runCommand(data, receipt, SlimCommandTest.DIGEST, controlCommand(receipt),
                List.of(), System.nanoTime() + 30_000_000_000L);
            assertEquals(control.toString(), "committed", control.get("status"));
            var model = activateInitialModel(service, data);
            assertEquals(model.toString(), "committed", model.get("status"));
            assertEquals("unrelated native commands must not rewrite the owner completion marker", completion, completedProof(data));
            data.begin(ReadWrite.READ);
            try {
                assertTrue(data.contains(CURRENT, uri(SlimCommandTest.COMPONENT), p("metadataHead"), uri(SlimCommandTest.NEW)));
                assertEquals("3", CommandInvariant.readControl(data).sequence().toString());
            } finally { data.end(); }
            System.out.println("membership completed proof: normal product=committed same-epoch control=committed model activation=committed");
            Set<Quad> before = snapshot(data); long beforeSeek = physical[0];
            boolean needs = needsPreparation(data);
            assertEquals("readiness must not scan membership after unrelated native commands", beforeSeek, physical[0]);
            assertEquals("readiness must not mutate the completed owner proof", before, snapshot(data));
            assertFalse("completed owner preparation became dirty after unrelated admitted native commands", needs);
        } finally { data.close(); }
    }
    @Test public void completedPreparationRemainsCurrentAfterSlimProductAndSignedCommitProofRetirement() throws Exception {
        var data = metadataFixture();
        try {
            completedMetadataFixture(data); long[] physical = countPhysicalRows(data); Set<Quad> completion = completedProof(data);
            assertEquals(1, completion.size());
            var service = SlimCommandTest.service(PROFILES);
            var slim = SlimCommandTest.run(service, data, PROFILES, SlimCommandTest.RECEIPT, SlimCommandTest.OLD, SlimCommandTest.NEW, 0);
            assertEquals(slim.toString(), "committed", slim.get("status"));
            var unsigned = new CommandService.Retirement(SlimCommandTest.RECEIPT, SlimCommandTest.DIGEST,
                SlimCommandTest.PAYLOAD, "test", "1", "1", "");
            var mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec("3".repeat(64).getBytes(java.nio.charset.StandardCharsets.US_ASCII), "HmacSHA256"));
            var evidence = new CommandService.Retirement(unsigned.receipt(), unsigned.digest(), unsigned.payloadSha256(),
                unsigned.dataEpoch(), unsigned.sequence(), unsigned.streamSequence(),
                HexFormat.of().formatHex(mac.doFinal(CommandService.retirementPayload(unsigned).getBytes(java.nio.charset.StandardCharsets.UTF_8))));
            var retired = service.retireProof(data, evidence);
            assertEquals(retired.toString(), "retired", retired.get("status"));
            assertEquals("slim/proof-only commits must not rewrite the owner completion marker", completion, completedProof(data));
            data.begin(ReadWrite.READ);
            try {
                assertNull(CommandInvariant.commitProof(data, SlimCommandTest.RECEIPT));
                assertEquals("1", CommandInvariant.readControl(data).sequence().toString());
            } finally { data.end(); }
            System.out.println("membership completed proof: slim product=committed signed proof=retired");
            Set<Quad> before = snapshot(data); long beforeSeek = physical[0];
            boolean needs = needsPreparation(data);
            assertEquals("readiness must not scan membership after proof retirement", beforeSeek, physical[0]);
            assertEquals("readiness must be read-only after proof retirement", before, snapshot(data));
            assertFalse("completed owner preparation became dirty after slim/proof-only native commits", needs);
        } finally { data.close(); }
    }
    @Test public void completedPreparationRemainsCurrentAndReadOnlyAfterANewJvmStarts() throws Exception {
        Files.createDirectories(Path.of(".temp"));
        Path directory = Files.createTempDirectory(Path.of(".temp"), "membership-completed-restart-").toAbsolutePath();
        assertTrue(probe(directory, "seed-complete").contains("membership persisted completion: complete=true"));
        String output = probe(directory, "resume-complete");
        assertTrue(output, output.contains("membership completed restart: current=true physicalRows=0"));
        System.out.print(output);
    }
    private static String membershipCommand(String receipt, String deletes, String inserts, String guard) {
        return """
            PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
            DELETE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?n }
              GRAPH <urn:rezics:graph:current> { %s }
            }
            INSERT {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?next }
              GRAPH <urn:rezics:graph:current> { %s }
              GRAPH <urn:rezics:graph:receipts> { <%s> a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
                rv:requestDigest "%s" ; rv:datasetId <urn:rezics:dataset:product> ; rv:dataEpoch "epoch" ; rv:sequence ?next }
              GRAPH <urn:rezics:graph:outbox> { <%s:batch> a rv:OutboxBatch ; rv:dataEpoch "epoch" ; rv:sequence ?next ;
                rv:eventCount 1 ; rv:event <%s:event> . <%s:event> a rv:StructureCommandEvent ; rv:ordinal 0 ;
                rv:action "structure.command" ; rv:receipt <%s> . }
            } WHERE {
              GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:dataEpoch "epoch" ; rv:routingEpoch "routing" ; rv:sequence ?n }
              GRAPH <urn:rezics:graph:current> { %s }
              FILTER NOT EXISTS { GRAPH <urn:rezics:graph:receipts> { <%s> ?p ?o } }
              BIND(?n + 1 AS ?next)
            }
            """.formatted(deletes, inserts, receipt, SlimCommandTest.DIGEST, receipt, receipt, receipt, receipt, guard, receipt);
    }
    private static Map<String,Object> nativeMembershipWrite(DatasetGraph data, String receipt, String deletes, String inserts, String guard) {
        String facts = deletes + inserts;
        List<CommandService.Validation> validations = new ArrayList<>();
        Map<String,Node> focuses = Map.of("placement", id(10000), "item-list", LIST, "segment", SEGMENT);
        for (var focus : focuses.entrySet()) if (facts.contains("<" + focus.getValue().getURI() + ">"))
            validations.add(new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/" + focus.getKey() + "-shape",
                List.of(focus.getValue().getURI()), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
        return SlimCommandTest.service(PROFILES).runCommand(data, receipt, SlimCommandTest.DIGEST,
            membershipCommand(receipt, deletes, inserts, guard), validations, System.nanoTime() + 30_000_000_000L);
    }
    @Test public void malformedNativeMembershipWritesRefuseAtomicallyAndPreserveCompletedProof() {
        for (String defect : List.of("legacy-target", "position", "missing-parent-edge", "list-skeleton")) {
            var data = fixture(1, 0, 0, 0);
            try {
                assertEquals(1, drain(data, countPhysicalRows(data), 10));
                Set<Quad> before = snapshot(data); assertEquals(1, completedProof(data).size());
                String deletes = "", inserts = "", guard = "<" + id(10000).getURI() + "> rv:orderKey \"1\" .";
                if (defect.equals("legacy-target")) inserts = "<" + id(10000).getURI() + "> rv:target <" + id(200000).getURI() + "> .";
                else if (defect.equals("position")) {
                    deletes = "<" + id(10000).getURI() + "> schema:position \"0-1\" .";
                    inserts = "<" + id(10000).getURI() + "> schema:position \"0-2\" .";
                } else if (defect.equals("missing-parent-edge")) deletes = "<" + LIST.getURI() + "> schema:itemListElement <" + id(10000).getURI() + "> .";
                else {
                    deletes = "<" + LIST.getURI() + "> rv:parent <" + STRUCTURE.getURI() + "> .";
                    inserts = "<" + LIST.getURI() + "> rv:parent <" + id(999).getURI() + "> .";
                }
                var result = nativeMembershipWrite(data, "urn:rezics:receipt:membership-invalid:" + defect, deletes, inserts, guard);
                assertEquals(result.toString(), "invalid", result.get("status"));
                String reason = Map.of("legacy-target", "legacy rv:target", "position", "position differs",
                    "missing-parent-edge", "deterministic ItemList", "list-skeleton", "skeleton is immutable").get(defect);
                assertTrue(result.toString(), result.get("report").toString().contains(reason));
                assertEquals("rejected membership mutation must roll back all facts and native bookkeeping", before, snapshot(data));
                assertFalse(needsPreparation(data));
            } finally { data.close(); }
        }
    }
    @Test public void legalNativePlacementReorderPreservesTheCompletedMarkerByteForByte() {
        var data = fixture(1, 0, 0, 0);
        try {
            assertEquals(1, drain(data, countPhysicalRows(data), 10)); Set<Quad> proof = completedProof(data);
            String placement = "<" + id(10000).getURI() + ">";
            var result = nativeMembershipWrite(data, "urn:rezics:receipt:membership-reorder",
                placement + " rv:orderKey \"1\" ; schema:position \"0-1\" .",
                placement + " rv:orderKey \"2\" ; schema:position \"0-2\" .",
                placement + " rv:orderKey \"1\" ; schema:position \"0-1\" .");
            assertEquals(result.toString(), "committed", result.get("status"));
            assertEquals(proof, completedProof(data)); assertFalse(needsPreparation(data));
            data.begin(ReadWrite.READ);
            try {
                assertTrue(data.contains(CURRENT, id(10000), p("orderKey"), text("2")));
                assertTrue(data.contains(CURRENT, id(10000), s("position"), text("0-2")));
                assertTrue(data.contains(CURRENT, LIST, s("itemListElement"), id(10000)));
            } finally { data.end(); }
        } finally { data.close(); }
    }
    private static final Node NEW_PLACEMENT = id(90000), NEW_OCCURRENCE = id(400000);
    private static DatasetGraph populatedParent(int population) {
        var data = fixture(0, population, 0, 0);
        write(data, () -> {
            data.add(CURRENT, NEW_OCCURRENCE, RDF.type.asNode(), s("ListItem"));
            data.add(CURRENT, NEW_OCCURRENCE, p("structure"), STRUCTURE);
            data.add(CURRENT, NEW_OCCURRENCE, p("introducedBy"), HEAD);
        });
        assertEquals(0, drain(data, countPhysicalRows(data), 40)); assertFalse(needsPreparation(data));
        return data;
    }
    private static Map<String,Object> insertIntoPopulatedParent(DatasetGraph data, String suffix) {
        return insertIntoPopulatedParent(data, suffix, List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS));
    }
    private static Map<String,Object> insertIntoPopulatedParent(DatasetGraph data, String suffix, List<String> listGraphs) {
        String placement = "<" + NEW_PLACEMENT.getURI() + ">";
        String insert = placement + " a rv:OccurrencePlacement, schema:ListItem ; rv:generation <" + GENERATION.getURI()
            + "> ; rv:occurrence <" + NEW_OCCURRENCE.getURI() + "> ; rv:occurrenceRole rv:ChapterRole ; rv:orderSegment <"
            + SEGMENT.getURI() + "> ; rv:orderKey \"zzz\" ; schema:item <" + id(200000).getURI()
            + "> ; schema:position \"0-zzz\" . <" + LIST.getURI() + "> schema:itemListElement " + placement + " .";
        String receipt = "urn:rezics:receipt:membership-parent-insertion:" + suffix;
        List<CommandService.Validation> checks = List.of(
            new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/placement-shape", List.of(NEW_PLACEMENT.getURI()),
                List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
            new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/item-list-shape", List.of(LIST.getURI()),
                listGraphs, Map.of()));
        return SlimCommandTest.service(PROFILES).runCommand(data, receipt, SlimCommandTest.DIGEST,
            membershipCommand(receipt, "", insert, "<" + LIST.getURI() + "> a schema:ItemList ."), checks,
            System.nanoTime() + 30_000_000_000L);
    }
    /** Watches the whole command pipeline, including canonical and explicit SHACL. */
    private static final class ParentReads extends DatasetGraphWrapper {
        final boolean allowWitness;
        long returnedRows;
        int populationProbes, populationHasNext, populationNext;
        ParentReads(DatasetGraph data, boolean allowWitness) { super(data); this.allowWitness = allowWitness; }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            boolean population = (graph.equals(CURRENT) || graph.equals(Node.ANY) || Quad.isUnionGraph(graph)) && subject.equals(LIST)
                && predicate.equals(s("itemListElement")) && object.equals(Node.ANY);
            if (population) {
                populationProbes++;
                assertTrue("completed parent insertion must not open ANY-member population reads anywhere in the native pipeline", allowWitness);
            }
            var rows = super.find(graph, subject, predicate, object);
            return new org.apache.jena.util.iterator.NiceIterator<Quad>() {
                @Override public boolean hasNext() {
                    if (population) populationHasNext++;
                    return rows.hasNext();
                }
                @Override public Quad next() {
                    Quad quad = rows.next(); returnedRows++;
                    if (population) { populationNext++; assertTrue("prestate witness must not iterate a parent population", populationNext <= 1); }
                    if (!population && quad.getGraph().equals(CURRENT) && quad.getSubject().equals(LIST)
                        && quad.getPredicate().equals(s("itemListElement")) && object.equals(Node.ANY))
                        fail("broad subject reads must not enumerate membership edges before filtering");
                    return quad;
                }
                @Override public void close() { Iter.close(rows); }
            };
        }
        @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
            var rows = find(graph, subject, predicate, object);
            try { return rows.hasNext(); } finally { Iter.close(rows); }
        }
        @Override public boolean contains(Quad quad) {
            return contains(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public Iterator<Quad> find(Quad quad) {
            return find(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject());
        }
        @Override public Iterator<Quad> findNG(Node graph, Node subject, Node predicate, Node object) {
            return Iter.filter(find(graph, subject, predicate, object), quad -> !quad.isDefaultGraph());
        }
        @Override public org.apache.jena.graph.Graph getGraph(Node graph) {
            return org.apache.jena.sparql.core.GraphView.createNamedGraph(this, graph);
        }
        @Override public org.apache.jena.graph.Graph getDefaultGraph() {
            return org.apache.jena.sparql.core.GraphView.createDefaultGraph(this);
        }
        @Override public org.apache.jena.graph.Graph getUnionGraph() {
            return org.apache.jena.sparql.core.GraphView.createUnionGraph(this);
        }
    }
    @Test public void nativeInsertionIntoACompletedHighDegreeParentNeverWalksItsPopulationForAnyValidation() {
        Long baseline = null;
        for (int population : List.of(130, 500, 3500)) {
            var data = populatedParent(population);
            try {
                Set<Quad> proof = completedProof(data); var counted = new ParentReads(data, false);
                var result = insertIntoPopulatedParent(counted, "complete-" + population);
                assertEquals(result.toString(), "committed", result.get("status"));
                assertEquals(0, counted.populationProbes);
                assertEquals(proof, completedProof(data)); assertFalse(needsPreparation(data));
                assertTrue("parent insertion exceeded its fixed observed field work: " + counted.returnedRows, counted.returnedRows <= 2000);
                if (baseline == null) baseline = counted.returnedRows;
                else assertEquals("native insertion work grew with unrelated existing members", baseline.longValue(), counted.returnedRows);
                data.begin(ReadWrite.READ);
                try {
                    assertTrue(data.contains(CURRENT, LIST, s("itemListElement"), NEW_PLACEMENT));
                    assertTrue(data.contains(CURRENT, NEW_PLACEMENT, s("position"), text("0-zzz")));
                    assertEquals(population + 1, Iter.count(data.find(CURRENT, LIST, s("itemListElement"), Node.ANY)));
                } finally { data.end(); }
                System.out.println("membership native parent insertion population=" + population + " focusedRows=" + counted.returnedRows + " populationProbes=0");
            } finally { data.close(); }
        }
    }
    @Test public void populatedParentWithoutAnExhaustiveProofRefusesAtOnePrestateWitness() {
        for (int population : List.of(130, 3500)) {
            var data = populatedParent(population);
            try {
                write(data, () -> {}); assertTrue(needsPreparation(data));
                Set<Quad> before = snapshot(data); var counted = new ParentReads(data, true);
                var result = insertIntoPopulatedParent(counted, "uncertified-" + population);
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertTrue(result.toString(), result.get("report").toString().contains("populated ItemList requires completed membership preparation"));
                assertEquals(1, counted.populationProbes);
                // CurrentScope's concat/distinct checks availability twice and
                // prefetches one physical row for the outer hasNext witness.
                // That witness must never advance into the remaining population.
                assertTrue("prestate witness availability was repeatedly reprobed", counted.populationHasNext > 0 && counted.populationHasNext <= 2);
                assertTrue("prestate witness iterated beyond its first member", counted.populationNext <= 1);
                assertEquals(before, snapshot(data)); assertTrue(needsPreparation(data));
                System.out.println("membership uncertified parent insertion population=" + population + " populationProbes="
                    + counted.populationProbes + " hasNext=" + counted.populationHasNext + " iteratedMembers=" + counted.populationNext);
            } finally { data.close(); }
        }
    }
    @Test public void boundedParentValidationRejectsNonstandardGraphScopesWithoutChangingFacts() {
        var data = populatedParent(130);
        try {
            Set<Quad> before = snapshot(data);
            for (List<String> scope : List.of(List.of(CommandPolicy.CURRENT),
                List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS, CommandPolicy.PUBLIC_SEARCH))) {
                var counted = new ParentReads(data, false);
                var result = insertIntoPopulatedParent(counted, "unsupported-scope-" + scope.size(), scope);
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertTrue(result.toString(), result.get("report").toString().contains("requires the owner current/revisions scope"));
                assertEquals(0, counted.populationProbes); assertEquals(before, snapshot(data)); assertFalse(needsPreparation(data));
            }
        } finally { data.close(); }
    }
    @Test public void unsafeHighDegreeSegmentRewriteStopsAtTheBoundedDependentClosure() {
        for (int population : List.of(130, 500)) {
            var data = fixture(0, population, 0, 0);
            try {
                write(data, () -> data.add(CURRENT, SEGMENT, p("memberCount"),
                    NodeFactory.createLiteralByValue(population, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger)));
                assertEquals(0, drain(data, countPhysicalRows(data), 20)); Set<Quad> before = snapshot(data);
                var counted = new DatasetGraphWrapper(data) {
                    int dependentRows;
                    @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
                        if (graph.equals(CURRENT) && predicate.equals(s("itemListElement")) && object.equals(Node.ANY))
                            fail("segment mutation must not enumerate parent membership adjacency");
                        var rows = super.find(graph, subject, predicate, object);
                        if (graph.equals(CURRENT) && subject.equals(Node.ANY) && predicate.equals(p("orderSegment")) && object.equals(SEGMENT))
                            return Iter.map(rows, row -> { dependentRows++; return row; });
                        return rows;
                    }
                };
                String segment = "<" + SEGMENT.getURI() + ">";
                var result = nativeMembershipWrite(counted, "urn:rezics:receipt:membership-segment-rewrite:" + population,
                    segment + " rv:segmentKey \"0\" .", segment + " rv:segmentKey \"1\" .", segment + " rv:segmentKey \"0\" .");
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertTrue(result.toString(), result.get("report").toString().contains("membership dependent"));
                assertTrue("dependent closure was never consulted", counted.dependentRows > 0);
                assertTrue("dependent closure exceeded its bounded refusal probe: " + counted.dependentRows, counted.dependentRows <= 129);
                assertEquals(before, snapshot(data)); assertFalse(needsPreparation(data));
                System.out.println("membership unsafe segment population=" + population + " dependentRows=" + counted.dependentRows);
            } finally { data.close(); }
        }
    }
    @Test public void restoredEpochAndHoldInvalidateCompletionAndCannotReuseAnOldExhaustedCursor() {
        var data = fixture(1, 0, 0, 0);
        try {
            assertEquals(1, drain(data, countPhysicalRows(data), 10)); assertFalse(needsPreparation(data));
            write(data, () -> {
                data.deleteAny(CONTROL, PRODUCT, p("dataEpoch"), Node.ANY);
                data.add(CONTROL, PRODUCT, p("dataEpoch"), text("restored-epoch"));
                data.deleteAny(CONTROL, PRODUCT, p("sequence"), Node.ANY);
                data.add(CONTROL, PRODUCT, p("sequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                Node stream = uri(CommandInvariant.MAIN_STREAM_SCOPE);
                data.deleteAny(CONTROL, stream, Node.ANY, Node.ANY);
                data.add(CONTROL, stream, p("dataEpoch"), text("restored-epoch"));
                data.add(CONTROL, stream, p("streamSequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.add(CONTROL, stream, p("legacyThroughSequence"), NodeFactory.createLiteralByValue(0, org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
                data.add(CONTROL, PRODUCT, p("restoreHold"), NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
                data.deleteAny(CURRENT, id(10000), s("position"), Node.ANY);
            });
            assertTrue(needsPreparation(data)); Set<Quad> held = snapshot(data);
            assertEquals("guard-unmatched", prepare(data, request("restored-epoch", "routing")).get("status"));
            assertEquals(held, snapshot(data));
            write(data, () -> data.deleteAny(CONTROL, PRODUCT, p("restoreHold"), Node.ANY));
            var repaired = prepare(data, request("restored-epoch", "routing"));
            assertEquals(repaired.toString(), "committed", repaired.get("status")); assertEquals(1, repaired.get("placements"));
            assertTrue(Boolean.TRUE.equals(repaired.get("complete"))); assertFalse(needsPreparation(data));
        } finally { data.close(); }
    }
    private static java.net.http.HttpResponse<String> rawUpdate(int port, String queryString, String update) throws Exception {
        var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://127.0.0.1:" + port + "/data/update" + queryString))
            .header("Content-Type", "application/sparql-update").timeout(java.time.Duration.ofSeconds(10))
            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(update)).build();
        return java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
    }
    @Test public void guardedRawUpdateInvalidatesCompletionInItsTransactionAndRejectsProofForgery() throws Exception {
        var data = fixture(1, 0, 0, 0);
        var server = org.apache.jena.fuseki.main.FusekiServer.create().port(0).add("/data", data)
            .registerOperation(org.apache.jena.fuseki.server.Operation.Update, new TemplateIndexService.RawMembershipUpdate()).build().start();
        try {
            assertEquals(1, drain(data, countPhysicalRows(data), 10)); assertFalse(needsPreparation(data));
            Set<Quad> before = snapshot(data);
            List<String> rejected = List.of(
                "INSERT DATA { GRAPH <" + TemplateIndexService.STATE + "> { <urn:rezics:membership-preparation> <" + RV + "membershipCompletedForm> \"forged\" } }",
                "WITH <" + TemplateIndexService.STATE + "> INSERT { <urn:rezics:membership-preparation> <" + RV
                    + "membershipCompletedForm> \"forged\" ; <" + RV + "membershipCheckpoint> \"{}\" } WHERE {}",
                "INSERT DATA { <" + NEW_PLACEMENT.getURI() + "> a <" + RV + "OccurrencePlacement> }",
                "INSERT { GRAPH ?g { <" + id(10000).getURI() + "> <" + SCHEMA + "position> \"0-2\" } } WHERE { BIND(<" + CommandPolicy.CURRENT + "> AS ?g) }");
            for (String update : rejected) {
                var response = rawUpdate(server.getPort(), "", update);
                assertEquals(response.body(), 400, response.statusCode()); assertEquals(before, snapshot(data));
                assertFalse(needsPreparation(data));
            }
            var using = rawUpdate(server.getPort(), "?using-graph-uri=" + java.net.URLEncoder.encode(CommandPolicy.CURRENT, java.nio.charset.StandardCharsets.UTF_8),
                "INSERT DATA { GRAPH <" + CommandPolicy.CURRENT + "> { <urn:rezics:test:raw> <urn:test:value> \"value\" } }");
            assertEquals(using.body(), 400, using.statusCode()); assertEquals(before, snapshot(data));
            String delete = "DELETE WHERE { GRAPH <" + CommandPolicy.CURRENT + "> { <" + id(10000).getURI()
                + "> <" + SCHEMA + "position> ?position } }; # a trailing maintenance comment\n";
            var deleted = rawUpdate(server.getPort(), "", delete);
            assertTrue(deleted.body(), deleted.statusCode() == 200 || deleted.statusCode() == 204);
            assertTrue(needsPreparation(data)); assertTrue(completedProof(data).isEmpty());
            data.begin(ReadWrite.READ);
            try { assertFalse(data.contains(CURRENT, id(10000), s("position"), Node.ANY)); }
            finally { data.end(); }
            assertEquals(1, drain(data, countPhysicalRows(data), 10)); assertFalse(needsPreparation(data));
        } finally { server.stop(); data.close(); }
    }
    @Test public void defaultGraphLegacyMembershipCannotHideBehindNamedSeekExhaustionOrARetainedProof() {
        for (boolean retainProof : List.of(false, true)) {
            var data = fixture(1, 0, 0, 0);
            try {
                assertEquals(1, drain(data, countPhysicalRows(data), 10)); Set<Quad> proof = completedProof(data);
                Runnable restore = () -> {
                    data.add(Quad.defaultGraphNodeGenerated, id(600000), RDF.type.asNode(), p("OccurrencePlacement"));
                    data.add(Quad.defaultGraphNodeGenerated, id(600000), p("target"), id(200000));
                };
                if (retainProof) {
                    // Simulate stopped-store tampering which bypasses even the
                    // registered raw writer's transaction-local invalidation.
                    data.begin(ReadWrite.WRITE);
                    try { restore.run(); data.commit(); } finally { data.end(); }
                    assertEquals(proof, completedProof(data));
                } else write(data, restore);
                Set<Quad> before = snapshot(data); long[] physical = countPhysicalRows(data);
                assertTrue(needsPreparation(data));
                var result = prepare(data, request());
                assertEquals(result.toString(), "invalid", result.get("status"));
                assertTrue(result.toString(), result.get("report").toString().contains("ordered membership requires named current storage"));
                assertEquals("default storage witness must refuse before opening named membership seeks", 0, physical[0]);
                assertEquals(before, snapshot(data));
            } finally { data.close(); }
        }
    }
    @Test public void nativeMembershipCannotRedirectAQualifiedParentInsertionIntoDefaultMetadataStorage() {
        var data = fixture(0, 3500, 0, 0);
        try {
            write(data, () -> {
                data.add(CURRENT, NEW_OCCURRENCE, RDF.type.asNode(), s("ListItem"));
                data.add(CURRENT, NEW_OCCURRENCE, p("structure"), STRUCTURE);
                data.add(CURRENT, NEW_OCCURRENCE, p("introducedBy"), HEAD);
                data.add(Quad.defaultGraphNodeGenerated, NEW_PLACEMENT, uri("urn:rezics:test:untyped-metadata"), text("existing default metadata"));
            });
            // Untyped default metadata is valid C6 storage and must not turn
            // named membership preparation into an unrelated default scan.
            assertEquals(0, drain(data, countPhysicalRows(data), 40)); assertFalse(needsPreparation(data));
            Set<Quad> before = snapshot(data); var counted = new ParentReads(data, false);
            var result = insertIntoPopulatedParent(counted, "default-redirect");
            assertEquals(result.toString(), "invalid", result.get("status"));
            assertTrue(result.toString(), result.get("report").toString().contains("ordered membership cannot be redirected into default metadata storage"));
            assertEquals(0, counted.populationProbes); assertEquals(before, snapshot(data)); assertFalse(needsPreparation(data));
        } finally { data.close(); }
    }
    private static final List<String> DEFAULT_OWNER_CASES = List.of("structure", "generation", "segment",
        "segment-fields", "structure-profile", "generation-owner", "segment-key");
    private static void moveOwnerFactsToDefault(DatasetGraph data, String defect) {
        Node subject = defect.startsWith("structure") ? STRUCTURE : defect.startsWith("generation") ? GENERATION : SEGMENT;
        var facts = Iter.toList(data.find(CURRENT, subject, Node.ANY, Node.ANY));
        for (Quad quad : facts) {
            boolean move = switch (defect) {
                case "segment-fields" -> !quad.getPredicate().equals(RDF.type.asNode());
                case "structure-profile" -> quad.getPredicate().equals(p("structureProfile"));
                case "generation-owner" -> quad.getPredicate().equals(p("structure"));
                case "segment-key" -> quad.getPredicate().equals(p("segmentKey"));
                default -> true;
            };
            if (move) {
                data.delete(quad);
                data.add(Quad.defaultGraphNodeGenerated, quad.getSubject(), quad.getPredicate(), quad.getObject());
            }
        }
    }
    private static void unplacedOccurrence(DatasetGraph data) {
        data.add(CURRENT, NEW_OCCURRENCE, RDF.type.asNode(), s("ListItem"));
        data.add(CURRENT, NEW_OCCURRENCE, p("structure"), STRUCTURE);
        data.add(CURRENT, NEW_OCCURRENCE, p("introducedBy"), HEAD);
    }
    private static Map<String,Object> insertFirstOwnedPlacement(DatasetGraph data, String suffix) {
        String placement = "<" + NEW_PLACEMENT.getURI() + ">";
        String insert = placement + " a rv:OccurrencePlacement, schema:ListItem ; rv:generation <" + GENERATION.getURI()
            + "> ; rv:occurrence <" + NEW_OCCURRENCE.getURI() + "> ; rv:occurrenceRole rv:ChapterRole ; rv:orderSegment <"
            + SEGMENT.getURI() + "> ; rv:orderKey \"zzz\" ; schema:item <" + id(200000).getURI()
            + "> ; schema:position \"0-zzz\" . <" + LIST.getURI() + "> a schema:ItemList ; rv:generation <"
            + GENERATION.getURI() + "> ; rv:parent <" + STRUCTURE.getURI() + "> ; schema:itemListElement " + placement + " .";
        String receipt = "urn:rezics:receipt:membership-first-owned-placement:" + suffix;
        List<CommandService.Validation> checks = List.of(
            new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/placement-shape", List.of(NEW_PLACEMENT.getURI()),
                List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()),
            new CommandService.Validation("structure-composition-v1", PROFILES.get("structure-composition-v1"),
                "https://rezics.com/definition/structure-composition-v1/item-list-shape", List.of(LIST.getURI()),
                List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of()));
        return SlimCommandTest.service(PROFILES).runCommand(data, receipt, SlimCommandTest.DIGEST,
            membershipCommand(receipt, "", insert, "<" + NEW_OCCURRENCE.getURI() + "> a schema:ListItem ."), checks,
            System.nanoTime() + 30_000_000_000L);
    }
    @Test public void emptyNamedMembershipCannotCertifyDefaultOwnersOrSplitOwnerFields() {
        for (String defect : DEFAULT_OWNER_CASES) {
            var data = fixture(0, 0, 0, 0);
            try {
                write(data, () -> moveOwnerFactsToDefault(data, defect));
                Set<Quad> before = snapshot(data); long[] physical = countPhysicalRows(data);
                assertTrue(needsPreparation(data));
                var result = prepare(data, request());
                assertEquals(defect + ": " + result, "invalid", result.get("status"));
                assertTrue(result.toString(), result.get("report").toString().contains("ordered membership requires named current storage"));
                assertEquals("owner default witness must refuse before empty named seeks are certified", 0, physical[0]);
                assertTrue(completedProof(data).isEmpty()); assertEquals(before, snapshot(data));
            } finally { data.close(); }
        }
    }
    @Test public void nativeInsertionCannotUseUnchangedDefaultOwnersOrMixedGraphReferencesBehindAnOldProof() {
        var named = fixture(0, 0, 0, 0);
        try {
            write(named, () -> unplacedOccurrence(named));
            assertEquals(0, drain(named, countPhysicalRows(named), 1)); Set<Quad> proof = completedProof(named);
            var admitted = insertFirstOwnedPlacement(named, "named-control");
            assertEquals(admitted.toString(), "committed", admitted.get("status"));
            assertEquals(proof, completedProof(named)); assertFalse(needsPreparation(named));
        } finally { named.close(); }
        for (String defect : DEFAULT_OWNER_CASES) {
            var data = fixture(0, 0, 0, 0);
            try {
                write(data, () -> unplacedOccurrence(data));
                assertEquals(0, drain(data, countPhysicalRows(data), 1)); assertFalse(needsPreparation(data));
                Set<Quad> proof = completedProof(data); assertEquals(1, proof.size());
                // The owner references change outside admission after a stopped
                // restore. The old marker remains byte-identical and in epoch.
                data.begin(ReadWrite.WRITE);
                try { moveOwnerFactsToDefault(data, defect); data.commit(); } finally { data.end(); }
                assertEquals(proof, completedProof(data)); assertTrue(needsPreparation(data));
                Set<Quad> before = snapshot(data);
                var result = insertFirstOwnedPlacement(data, defect);
                assertEquals(defect + ": " + result, "invalid", result.get("status"));
                assertEquals("default owner admission must leave no placement, list, receipt or projection changes", before, snapshot(data));
                assertEquals(proof, completedProof(data)); assertTrue(needsPreparation(data));
            } finally { data.close(); }
        }
    }
    private static String probe(Path directory, String mode) throws Exception {
        String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
            "-Xmx384m", "-cp", classpath, MembershipSeekTest.class.getName(), directory.toString(), mode).redirectErrorStream(true).start();
        boolean finished = process.waitFor(60, java.util.concurrent.TimeUnit.SECONDS);
        if (!finished) process.destroyForcibly();
        assertTrue("restart probe timed out", finished);
        String output = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        assertEquals(output, 0, process.exitValue());
        return output;
    }
    /** Separate JVM: persisted cursor must never trust the old process's NodeIds. */
    public static void main(String[] args) throws Exception {
        var disk = TDB2Factory.connectDataset(args[0]).asDatasetGraph();
        try {
            if (args[1].equals("seed-complete")) {
                var source = fixture(1, 0, 0, 0);
                try {
                    Set<Quad> initial = snapshot(source); write(disk, () -> initial.forEach(disk::add));
                    var result = prepare(disk, request());
                    assertEquals("committed", result.get("status")); assertTrue(Boolean.TRUE.equals(result.get("complete")));
                    assertFalse(needsPreparation(disk));
                    System.out.println("membership persisted completion: complete=true");
                } finally { source.close(); }
                return;
            }
            if (args[1].equals("resume-complete")) {
                long[] physical = countPhysicalRows(disk); Set<Quad> before = snapshot(disk); Set<Quad> proof = completedProof(disk);
                boolean needs = needsPreparation(disk);
                assertEquals(0, physical[0]); assertEquals(before, snapshot(disk));
                assertFalse("a new JVM must not dirty an exhaustive durable membership proof", needs);
                org.apache.jena.tdb2.DatabaseMgr.compact(disk, true);
                long[] compacted = countPhysicalRows(disk); Set<Quad> afterCompaction = snapshot(disk);
                assertFalse("physical compaction must preserve an exhaustive semantic owner proof", needsPreparation(disk));
                assertEquals(0, compacted[0]); assertEquals(proof, completedProof(disk));
                assertEquals(afterCompaction, snapshot(disk));
                System.out.println("membership completed restart: current=true physicalRows=" + physical[0]);
                return;
            }
            if (args[1].equals("seed")) {
                var source = fixture(100, 0, 0, 0);
                try {
                    Set<Quad> initial = snapshot(source); write(disk, () -> initial.forEach(disk::add));
                    JsonObject turn = request(); var result = prepare(disk, turn);
                    assertEquals(24, result.get("placements"));
                    Files.writeString(Path.of(args[0], "membership-replay-request.json"), turn.toString());
                    Files.writeString(Path.of(args[0], "membership-replay-result.json"), CommandService.jsonObject(result).toString());
                    System.out.println("membership persisted first turn: converted=24");
                } finally { source.close(); }
                return;
            }
            assertTrue(needsPreparation(disk));
            Set<Quad> beforeReplay = snapshot(disk);
            var oldRequest = org.apache.jena.atlas.json.JSON.parse(Files.readString(Path.of(args[0], "membership-replay-request.json")));
            String serializedResult = Files.readString(Path.of(args[0], "membership-replay-result.json"));
            var oldResult = org.apache.jena.atlas.json.JSON.parse(serializedResult);
            var replay = CommandService.jsonObject(prepare(disk, oldRequest));
            assertEquals(serializedResult, replay.toString());
            assertEquals(new HashSet<>(oldResult.keys()), new HashSet<>(replay.keys()));
            for (String key : oldResult.keys()) assertEquals(key, oldResult.get(key).toString(), replay.get(key).toString());
            assertEquals(beforeReplay, snapshot(disk)); assertTrue(needsPreparation(disk));
            var restarted = prepare(disk, request());
            assertTrue(Boolean.TRUE.equals(restarted.get("restarted")));
            int converted = ((Number) restarted.get("placements")).intValue();
            org.apache.jena.tdb2.DatabaseMgr.compact(disk, true);
            assertTrue(needsPreparation(disk));
            var compacted = prepare(disk, request());
            assertTrue(Boolean.TRUE.equals(compacted.get("restarted")));
            converted += ((Number) compacted.get("placements")).intValue();
            converted += drain(disk, countPhysicalRows(disk), 30);
            assertEquals(76, converted); assertFalse(needsPreparation(disk));
            System.out.println("membership restart and compaction: remaining=" + converted);
        } finally { disk.close(); }
    }
}
