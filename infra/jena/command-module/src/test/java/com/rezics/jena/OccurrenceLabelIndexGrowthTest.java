package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
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
        long rebuild() {
            long total = 0;
            for (int turn = 0; pending(); turn++) {
                assertTrue("rebuild must terminate", turn < 1000);
                total += write(() -> {
                    try (var work = new CommandWork()) {
                        OccurrenceLabelIndex.project(data, GENERATION, REVISION);
                        return visited(work);
                    }
                });
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
}
