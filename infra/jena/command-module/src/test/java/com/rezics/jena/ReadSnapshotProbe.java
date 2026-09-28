package com.rezics.jena;

import static org.junit.Assert.*;

import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.tdb2.TDB2Factory;

/** Opt-in native cost experiment; no server or product endpoint is installed.
 * Run via services/main/tests/read-snapshot-native.test.ts with
 * REZICS_READ_SNAPSHOT_PROBE=1. Its source volume is mounted read-only; this JVM
 * opens only a private copy. The corpus is the retained 100k Work / 10k MatchUnit
 * fixture, not synthetic scale substituted for qualified background data.
 */
public class ReadSnapshotProbe {
    private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
    private static final Node TYPE = NodeFactory.createURI("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
    private static final Node WORK = NodeFactory.createURI("https://schema.org/CreativeWork");
    private static final Node HEAD = NodeFactory.createURI("https://rezics.com/vocab/head");
    private static final int COMMITS = 300;
    private static final long COPY_DEADLINE_NS = TimeUnit.SECONDS.toNanos(10);
    private static final long COPY_HEAP_BYTES = 256L * 1024 * 1024;

    // A dedicated thread owns begin/query/end. A production lease needs a bounded
    // queue, cancellation, fixed TTL and shutdown handling in addition to this probe.
    private static final class Pin implements AutoCloseable {
        private final ExecutorService executor = Executors.newSingleThreadExecutor(Thread.ofVirtual().factory());
        private final DatasetGraph data;
        Pin(DatasetGraph data) throws Exception {
            this.data = data;
            call(() -> { data.begin(ReadWrite.READ); return true; });
        }
        <T> T call(Callable<T> operation) throws Exception {
            return executor.submit(operation).get(10, TimeUnit.SECONDS);
        }
        @Override public void close() throws Exception {
            try { call(() -> { data.end(); return true; }); }
            finally { executor.shutdownNow(); }
        }
    }

    private static long heap() { return ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed(); }
    private static long resident() throws IOException {
        for (String line : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (line.startsWith("VmRSS:")) return Long.parseLong(line.trim().split("\\s+")[1]) * 1024;
        }
        throw new IOException("RSS unavailable");
    }
    private static long written() throws IOException {
        for (String line : Files.readAllLines(Path.of("/proc/self/io"))) {
            if (line.startsWith("write_bytes:")) return Long.parseLong(line.trim().split("\\s+")[1]);
        }
        throw new IOException("process write accounting unavailable");
    }
    private static long bytes(Path directory) throws IOException {
        try (var paths = Files.walk(directory)) {
            return paths.filter(Files::isRegularFile).mapToLong(path -> {
                try { return Files.size(path); } catch (IOException ex) { throw new java.io.UncheckedIOException(ex); }
            }).sum();
        }
    }
    private static void copy(Path source, Path target) throws IOException {
        try (var paths = Files.walk(source)) {
            for (Path path : paths.toList()) {
                Path destination = target.resolve(source.relativize(path));
                if (Files.isDirectory(path)) Files.createDirectories(destination);
                else Files.copy(path, destination);
            }
        }
    }
    private static void emit(String phase, Map<String, Object> metrics) {
        var result = new JsonObject();
        result.put("phase", phase);
        metrics.forEach((key, value) -> {
            if (value instanceof Double number) result.put(key, JSON.parse("{\"n\":" + number + "}").get("n"));
            else if (value instanceof Number number) result.put(key, number.longValue());
            else if (value instanceof Boolean bool) result.put(key, bool);
            else result.put(key, String.valueOf(value));
        });
        System.out.println("READ_SNAPSHOT_PROBE " + JSON.toString(result).replace("\n", ""));
    }
    private static Node head(DatasetGraph data, Node work) {
        var rows = data.find(CURRENT, work, HEAD, Node.ANY);
        try { return rows.next().getObject(); }
        finally { Iter.close(rows); }
    }

    private static void nativePins(Path source, Path target, int pinCount) throws Exception {
        long preparation = System.nanoTime();
        copy(source, target);
        DatasetGraph data = TDB2Factory.connectDataset(target.toString()).asDatasetGraph();
        var pins = new ArrayList<Pin>();
        try {
            var works = new ArrayList<Node>();
            data.begin(ReadWrite.READ);
            try {
                long count = 0;
                var rows = data.find(CURRENT, Node.ANY, TYPE, WORK);
                try { while (rows.hasNext()) {
                    Node work = rows.next().getSubject();
                    if (works.size() < 100) works.add(work);
                    count++;
                } }
                finally { Iter.close(rows); }
                assertEquals("qualified fixture Work count", 100_000, count);
                var units = data.find(NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH), Node.ANY, TYPE,
                    NodeFactory.createURI("https://rezics.com/vocab/MatchUnit"));
                try { assertEquals("qualified fixture MatchUnit count", 10_000, Iter.count(units)); }
                finally { Iter.close(units); }
            } finally { data.end(); }
            assertEquals(100, works.size());
            System.gc();
            long heapBefore = heap(), rssBefore = resident();
            long peakHeap = heapBefore, peakRss = rssBefore;
            var pinnedHeads = new ArrayList<Node>();
            long pinNs = 0;
            // Distinct versions: interleave pin creation with writes. Pin count
            // is the number of live dataset versions, not requests at one version.
            for (int i = 0; i < pinCount; i++) {
                long at = System.nanoTime();
                Pin pin = new Pin(data);
                pins.add(pin);
                pinnedHeads.add(pin.call(() -> head(data, works.getFirst())));
                pinNs += System.nanoTime() - at;
                write(data, works.getFirst(), "pin-" + i);
            }
            long diskBefore = bytes(target), writtenBefore = written();
            var durations = new double[COMMITS];
            long at = System.nanoTime();
            for (int i = 0; i < COMMITS; i++) {
                long start = System.nanoTime();
                write(data, works.get(i % works.size()), "commit-" + i);
                durations[i] = (System.nanoTime() - start) / 1e6;
                if (i % 10 == 0) {
                    peakHeap = Math.max(peakHeap, heap());
                    peakRss = Math.max(peakRss, resident());
                }
            }
            double writesMs = (System.nanoTime() - at) / 1e6;
            for (int i = 0; i < pins.size(); i++) {
                assertEquals(pinnedHeads.get(i), pins.get(i).call(() -> head(data, works.getFirst())));
            }
            peakHeap = Math.max(peakHeap, heap());
            peakRss = Math.max(peakRss, resident());
            System.gc();
            long heldHeap = heap();
            for (Pin pin : pins) pin.close();
            pins.clear();
            System.gc();
            Arrays.sort(durations);
            emit("native", Map.ofEntries(Map.entry("pins", pinCount), Map.entry("commits", COMMITS),
                Map.entry("preparationAndRunMs", (System.nanoTime() - preparation) / 1e6),
                Map.entry("pinTotalMs", pinNs / 1e6), Map.entry("writesMs", writesMs),
                Map.entry("writeP50Ms", durations[COMMITS / 2]), Map.entry("writeP95Ms", durations[(int)(COMMITS * .95) - 1]),
                Map.entry("writeMaxMs", durations[COMMITS - 1]), Map.entry("heapBeforeBytes", heapBefore),
                Map.entry("heapPeakBytes", peakHeap), Map.entry("rssBeforeBytes", rssBefore),
                Map.entry("rssPeakBytes", peakRss), Map.entry("heapHeldAfterGcBytes", heldHeap),
                Map.entry("heapReleasedAfterGcBytes", heap()), Map.entry("processWriteBytes", written() - writtenBefore),
                Map.entry("fileGrowthBytes", bytes(target) - diskBefore), Map.entry("stable", true)));
        } finally {
            for (Pin pin : pins) pin.close();
            data.close();
        }
    }
    private static void write(DatasetGraph data, Node work, String version) {
        data.begin(ReadWrite.WRITE);
        try {
            data.delete(CURRENT, work, HEAD, head(data, work));
            data.add(CURRENT, work, HEAD, NodeFactory.createURI("urn:rezics:snapshot-probe:" + version));
            data.commit();
        } finally { data.end(); }
    }

    private static void materialize(Path source, Path target, boolean named) throws Exception {
        copy(source, target);
        DatasetGraph data = TDB2Factory.connectDataset(target.toString()).asDatasetGraph();
        DatasetGraph memory = named ? null : DatasetGraphFactory.createTxnMem();
        try {
            data.begin(named ? ReadWrite.WRITE : ReadWrite.READ);
            if (memory != null) memory.begin(ReadWrite.WRITE);
            boolean committed = false;
            try {
                System.gc();
                long heapBefore = heap(), rssBefore = resident(), diskBefore = bytes(target), peak = heapBefore;
                long at = System.nanoTime(), count = 0;
                boolean complete = true;
                // Graph-specific iteration avoids traversing newly copied graphs.
                for (String graph : List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
                    CommandPolicy.PUBLIC_SEARCH, CommandPolicy.CONTROL)) {
                    Node original = NodeFactory.createURI(graph);
                    Node copied = NodeFactory.createURI("urn:rezics:snapshot-probe:copy:" + graph);
                    var rows = data.find(original, Node.ANY, Node.ANY, Node.ANY);
                    try {
                        while (rows.hasNext()) {
                            Quad row = rows.next();
                            if (named) data.add(copied, row.getSubject(), row.getPredicate(), row.getObject());
                            else memory.add(row);
                            count++;
                            if (count % 1000 == 0) {
                                peak = Math.max(peak, heap());
                                if (System.nanoTime() - at > COPY_DEADLINE_NS || heap() - heapBefore > COPY_HEAP_BYTES) {
                                    complete = false;
                                    break;
                                }
                            }
                        }
                    } finally { Iter.close(rows); }
                    if (!complete) break;
                }
                // Budget includes commit. Incomplete named copies are aborted;
                // their measured elapsed time is a lower bound for a full copy.
                if (complete) {
                    if (named) data.commit(); else memory.commit();
                    committed = true;
                }
                emit(named ? "named-copy" : "memory-copy", Map.ofEntries(Map.entry("complete", complete),
                    Map.entry("quadsCopied", count), Map.entry("elapsedMs", (System.nanoTime() - at) / 1e6),
                    Map.entry("heapBeforeBytes", heapBefore), Map.entry("heapPeakBytes", Math.max(peak, heap())),
                    Map.entry("rssBeforeBytes", rssBefore), Map.entry("rssAfterBytes", resident()),
                    Map.entry("fileGrowthBeforeAbortBytes", bytes(target) - diskBefore),
                    Map.entry("writeTransaction", named), Map.entry("deadlineMs", 10_000),
                    Map.entry("heapGrowthLimitBytes", COPY_HEAP_BYTES)));
            } finally {
                if (memory != null) { if (!committed) memory.abort(); memory.end(); }
                if (named && !committed) data.abort();
                data.end();
            }
        } finally { if (memory != null) memory.close(); data.close(); }
    }

    public static void main(String[] args) throws Exception {
        Path source = Path.of(args[0]), target = Path.of(args[1]);
        if (!Files.isDirectory(source) || Files.exists(target)) throw new IllegalArgumentException("fresh target required");
        Files.createDirectories(target);
        emit("environment", Map.of("java", System.getProperty("java.version"), "processors", Runtime.getRuntime().availableProcessors(),
            "heapLimitBytes", Runtime.getRuntime().maxMemory(), "sourceFileBytes", bytes(source),
            "fixture", "fx-medium-c9f6e4fdcb52", "works", 100_000, "publicUnits", 10_000));
        // Each trial runs in a fresh JVM, so TDB mappings/caches from a previous
        // trial cannot count as this trial's retained heap or resident memory.
        String mode = args[2];
        if (mode.equals("memory") || mode.equals("named")) materialize(source, target.resolve(mode), mode.equals("named"));
        else nativePins(source, target.resolve("native"), Integer.parseInt(mode));
    }
}
