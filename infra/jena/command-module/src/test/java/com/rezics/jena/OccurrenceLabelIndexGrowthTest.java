package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.vocabulary.RDF;
import org.junit.Test;

public class OccurrenceLabelIndexGrowthTest {
    private static final Node CURRENT = OccurrenceLabelIndex.uri(CommandPolicy.CURRENT),
        CONTROL = OccurrenceLabelIndex.uri(CommandPolicy.CONTROL),
        PRODUCT = OccurrenceLabelIndex.uri("urn:rezics:dataset:product"),
        GENERATION = id(1), STRUCTURE = id(2), REVISION = id(3), SEGMENT = id(4), PARENT = id(5);
    private static Node id(int n) {
        return OccurrenceLabelIndex.uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", n));
    }
    private static Node p(String name) { return OccurrenceLabelIndex.p(name); }
    private static Node text(String value) { return OccurrenceLabelIndex.literal(value); }
    private static final class Fixture implements AutoCloseable {
        final Path directory;
        DatasetGraph data;
        Fixture(int population) throws Exception {
            directory = Files.createTempDirectory("occurrence-growth-");
            open();
            write(() -> {
                data.add(CURRENT, GENERATION, p("structure"), STRUCTURE);
                data.add(CURRENT, STRUCTURE, p("structureProfile"), p("StoryStructure"));
                data.add(CURRENT, STRUCTURE, p("selectedGeneration"), GENERATION);
                data.add(CURRENT, STRUCTURE, p("structureHead"), REVISION);
                data.add(CURRENT, GENERATION, p("generationState"), p("Active"));
                data.add(CURRENT, GENERATION, p("placementCount"), text(Integer.toString(population)));
                data.add(CONTROL, PRODUCT, p("textIndexGeneration"), id(6));
                data.add(CURRENT, SEGMENT, p("parent"), PARENT);
                data.add(CURRENT, SEGMENT, p("segmentKey"), text("a"));
                for (int n = 0; n < population; n++) {
                    Node placement = id(100 + n), occurrence = id(100000 + n);
                    data.add(CURRENT, placement, RDF.type.asNode(), p("OccurrencePlacement"));
                    data.add(CURRENT, placement, p("generation"), GENERATION);
                    data.add(CURRENT, placement, p("occurrence"), occurrence);
                    data.add(CURRENT, placement, p("orderSegment"), SEGMENT);
                    data.add(CURRENT, placement, p("orderKey"), text(String.format("%08d", n)));
                    data.add(CURRENT, placement, p("occurrenceRole"), p("ChapterRole"));
                    data.add(CURRENT, placement, p("occurrenceLabel"), NodeFactory.createLiteralLang("Chapter " + n, "en"));
                    // A full rebuild must also remove every retained projection.
                    Node entity = OccurrenceLabelIndex.uri("urn:old-occurrence:" + n);
                    data.add(OccurrenceLabelIndex.STATE, placement, p("indexedGeneration"), GENERATION);
                    data.add(OccurrenceLabelIndex.STATE, placement, p("projectedEntity"), entity);
                    data.add(OccurrenceLabelIndex.TEXT, entity, p("occurrenceSearchLabels"), text("old"));
                }
                OccurrenceLabelIndex.queue(data, GENERATION, true);
                return null;
            });
        }
        void open() { data = org.apache.jena.tdb2.DatabaseMgr.connectDatasetGraph(directory.toString()); }
        void reopen() { data.close(); open(); }
        <T> T write(Supplier<T> operation) {
            data.begin(ReadWrite.WRITE);
            try { T result = operation.get(); data.commit(); return result; }
            catch (RuntimeException | Error failure) { data.abort(); throw failure; }
            finally { data.end(); }
        }
        boolean pending() {
            data.begin(ReadWrite.READ);
            try { return data.contains(OccurrenceLabelIndex.STATE, GENERATION, p("pending"), Node.ANY); }
            finally { data.end(); }
        }
        Node state(String predicate) {
            data.begin(ReadWrite.READ);
            try { return OccurrenceLabelIndex.one(data, OccurrenceLabelIndex.STATE, GENERATION, p(predicate)); }
            finally { data.end(); }
        }
        Set<Quad> projection() {
            data.begin(ReadWrite.READ);
            try {
                Set<Quad> result = new HashSet<>();
                for (Node graph : new Node[] {OccurrenceLabelIndex.STATE, OccurrenceLabelIndex.TEXT}) {
                    var rows = data.find(graph, Node.ANY, Node.ANY, Node.ANY);
                    try { rows.forEachRemaining(result::add); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                }
                return result;
            } finally { data.end(); }
        }
        long step() {
            return write(() -> {
                try (var work = new CommandWork()) {
                    OccurrenceLabelIndex.project(data, GENERATION, REVISION);
                    assertTrue(CommandWork.currentCount("occurrence_placements_visited") <= OccurrenceLabelIndex.BATCH);
                    assertTrue(CommandWork.currentCount("occurrence_clear_visited") <= OccurrenceLabelIndex.BATCH);
                    return visited(work);
                }
            });
        }
        long rebuild() {
            long total = 0;
            for (int turn = 0; pending(); turn++) {
                assertTrue("rebuild must terminate", turn < 1000);
                total += step();
            }
            data.begin(ReadWrite.READ);
            try { assertTrue(OccurrenceLabelIndex.ready(data, GENERATION, REVISION)); }
            finally { data.end(); }
            return total;
        }
        @Override public void close() throws Exception {
            data.close();
            try (var paths = Files.walk(directory)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
    private static long visited(CommandWork work) {
        long result = 0;
        for (String counter : work.counters().split(",")) {
            String[] parts = counter.split("=");
            if (parts.length == 2 && parts[0].startsWith("occurrence_") && parts[0].endsWith("_visited"))
                result += Long.parseLong(parts[1]);
        }
        return result;
    }
    @Test public void fullRebuildVisitsGrowLinearlyAtThreePopulations() throws Exception {
        int[] populations = {500, 2000, 8000};
        double lowest = Double.POSITIVE_INFINITY, highest = 0;
        for (int population : populations) try (var fixture = new Fixture(population)) {
            long total = fixture.rebuild();
            double perPlacement = (double) total / population;
            System.out.printf("occurrence rebuild population=%d total_visited=%d visits_per_placement=%.3f%n",
                population, total, perPlacement);
            assertTrue("counter must include the complete clear and index passes", total >= population * 2L);
            lowest = Math.min(lowest, perPlacement); highest = Math.max(highest, perPlacement);
        }
        assertTrue("total native visits per placement must stay within 20%: min=" + lowest + " max=" + highest,
            highest <= lowest * 1.20);
    }
    @Test public void clearAndIndexKeysSurviveRestartAndAbortedBatches() throws Exception {
        try (var fixture = new Fixture(130)) {
            fixture.step();
            assertNotNull(fixture.state("indexClearCursor"));
            fixture.reopen();
            Set<Quad> before = fixture.projection();
            fixture.data.begin(ReadWrite.WRITE);
            try { OccurrenceLabelIndex.project(fixture.data, GENERATION, REVISION); fixture.data.abort(); }
            finally { fixture.data.end(); }
            assertEquals("aborted clear must preserve checkpoint and descriptors", before, fixture.projection());
            fixture.step(); fixture.step(); fixture.step();
            assertEquals(text("64"), fixture.state("indexedCount"));
            assertNotNull(fixture.state("indexCursor"));
            assertNull(fixture.state("indexOffset"));
            fixture.reopen(); before = fixture.projection();
            fixture.data.begin(ReadWrite.WRITE);
            try { OccurrenceLabelIndex.project(fixture.data, GENERATION, REVISION); fixture.data.abort(); }
            finally { fixture.data.end(); }
            assertEquals("aborted index must preserve checkpoint and projected text", before, fixture.projection());
            fixture.rebuild();
            assertEquals(130, fixture.projection().stream().filter(q -> q.getGraph().equals(OccurrenceLabelIndex.TEXT)).count());
        }
    }
    @Test public void rawPlacementBudgetIncludesRemovedAndNonPlacementRows() throws Exception {
        try (var fixture = new Fixture(130)) {
            fixture.write(() -> {
                for (int n = 0; n < 128; n++) {
                    if (n < 64) fixture.data.delete(CURRENT, id(100 + n), RDF.type.asNode(), p("OccurrencePlacement"));
                    else fixture.data.add(CURRENT, id(100 + n), p("removedBy"), REVISION);
                }
                fixture.data.deleteAny(CURRENT, GENERATION, p("placementCount"), Node.ANY);
                fixture.data.add(CURRENT, GENERATION, p("placementCount"), text("2"));
                for (int n = 0; n < 200; n++) fixture.data.add(CURRENT, id(300000 + n), p("generation"), GENERATION);
                return null;
            });
            fixture.rebuild();
            assertEquals(text("2"), fixture.state("indexedCount"));
            assertEquals(2, fixture.projection().stream().filter(q -> q.getGraph().equals(OccurrenceLabelIndex.TEXT)).count());
        }
    }
    @Test public void oldOffsetCheckpointRestartsOnceWithoutResettingReceiptSerial() throws Exception {
        try (var fixture = new Fixture(130)) {
            fixture.write(() -> {
                OccurrenceLabelIndex.set(fixture.data, GENERATION, "indexPhase", text("index"));
                OccurrenceLabelIndex.set(fixture.data, GENERATION, "indexOffset", text("64"));
                OccurrenceLabelIndex.set(fixture.data, GENERATION, "indexedCount", text("64"));
                OccurrenceLabelIndex.set(fixture.data, GENERATION, "indexBatch", text("7"));
                return null;
            });
            fixture.step();
            assertEquals(text("8"), fixture.state("indexBatch"));
            assertEquals(text("0"), fixture.state("indexedCount"));
            assertNull(fixture.state("indexOffset"));
            assertNotNull(fixture.state("indexClearCursor"));
            fixture.reopen(); fixture.rebuild();
            assertEquals(text("130"), fixture.state("indexedCount"));
        }
    }
    @Test public void staleTargetsAndPopulationMismatchCannotCommitPartialWork() throws Exception {
        try (var fixture = new Fixture(5)) {
            Set<Quad> before = fixture.projection();
            assertThrows(IllegalStateException.class, () -> fixture.write(() -> {
                OccurrenceLabelIndex.project(fixture.data, GENERATION, id(999)); return null;
            }));
            assertEquals(before, fixture.projection());
            fixture.step();
            fixture.write(() -> {
                fixture.data.deleteAny(CURRENT, GENERATION, p("placementCount"), Node.ANY);
                fixture.data.add(CURRENT, GENERATION, p("placementCount"), text("6"));
                return null;
            });
            before = fixture.projection();
            assertThrows(IllegalStateException.class, fixture::step);
            assertEquals(before, fixture.projection());
        }
        try (var fixture = new Fixture(0)) {
            fixture.rebuild();
            assertEquals(text("0"), fixture.state("indexedCount"));
        }
    }
}
