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
        try { action.run(); data.commit(); } finally { data.end(); }
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
    private static Map<String,Object> prepare(DatasetGraph data, JsonObject request) {
        return TemplateIndexService.membershipPrepare(data, request, PROFILES);
    }
    private static Set<Quad> snapshot(DatasetGraph data) {
        data.begin(ReadWrite.READ);
        try { return new HashSet<>(Iter.toList(data.find())); } finally { data.end(); }
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
