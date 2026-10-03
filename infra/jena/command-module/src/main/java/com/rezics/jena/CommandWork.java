package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.apache.jena.graph.Node;
import org.apache.jena.query.text.changes.DatasetGraphTextMonitor;
import org.apache.jena.query.text.changes.TextDatasetChanges;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;

/** Request-local native work. Times overlap (text indexing is inside update/commit),
 * so callers must not sum them as disjoint phases. Counters describe mutations,
 * not filesystem allocation or distinct node-table bytes. No RDF values escape. */
final class CommandWork implements AutoCloseable, TextDatasetChanges {
    private static final ThreadLocal<CommandWork> CURRENT = new ThreadLocal<>();
    private final long started = System.nanoTime();
    private final Map<String, Long> nanos = new LinkedHashMap<>();
    private final Map<String, Long> counts = new LinkedHashMap<>();
    private String phase = "parse";
    private long phaseStarted = started;

    CommandWork() {
        if (CURRENT.get() != null) throw new IllegalStateException("nested native command");
        CURRENT.set(this);
        for (String name : java.util.List.of("current_adds", "current_deletes", "current_literal_bytes",
            "revisions_adds", "revisions_deletes", "revisions_literal_bytes", "other_adds", "other_deletes",
            "other_literal_bytes", "max_literal_bytes", "text_adds", "text_updates", "text_deletes", "validation_focuses", "durable_commits"))
            counts.put(name, 0L);
    }
    void phase(String next) {
        nanos.merge(phase, System.nanoTime() - phaseStarted, Long::sum);
        phase = next;
        phaseStarted = System.nanoTime();
    }
    static void enter(String next) {
        CommandWork current = CURRENT.get();
        if (current != null) current.phase(next);
    }
    static DatasetGraph observe(DatasetGraph data) {
        CommandWork current = CURRENT.get();
        return current == null ? data : current.observed(data);
    }
    static <T> T timed(String name, Supplier<T> work) {
        CommandWork current = CURRENT.get();
        if (current == null) return work.get();
        long start = System.nanoTime();
        try { return work.get(); }
        finally { current.nanos.merge(name, System.nanoTime() - start, Long::sum); }
    }
    static void timed(String name, Runnable work) { timed(name, () -> { work.run(); return null; }); }
    static void count(String name, long value) {
        CommandWork current = CURRENT.get();
        if (current != null) current.counts.merge(name, value, Long::sum);
    }
    DatasetGraph observed(DatasetGraph data) {
        return new DatasetGraphTextMonitor(data, this) {
            @Override public void add(org.apache.jena.sparql.core.Quad quad) {
                timed(area(quad.getGraph()) + "_graph", () -> super.add(quad));
            }
            @Override public void add(Node graph, Node subject, Node predicate, Node object) {
                timed(area(graph) + "_graph", () -> super.add(graph, subject, predicate, object));
            }
            @Override public void delete(org.apache.jena.sparql.core.Quad quad) {
                timed(area(quad.getGraph()) + "_graph", () -> super.delete(quad));
            }
            @Override public void delete(Node graph, Node subject, Node predicate, Node object) {
                timed(area(graph) + "_graph", () -> super.delete(graph, subject, predicate, object));
            }
            @Override public void deleteAny(Node graph, Node subject, Node predicate, Node object) {
                timed(area(graph) + "_graph", () -> super.deleteAny(graph, subject, predicate, object));
            }
        };
    }
    @Override public void start() {}
    @Override public void finish() {}
    @Override public void reset() {}
    @Override public void change(TextQuadAction action, Node graph, Node subject, Node predicate, Node object) {
        if (action != TextQuadAction.ADD && action != TextQuadAction.DELETE) return;
        String area = area(graph);
        count(area + (action == TextQuadAction.ADD ? "_adds" : "_deletes"), 1);
        if (action == TextQuadAction.ADD && object.isLiteral()) {
            int bytes = object.getLiteralLexicalForm().getBytes(StandardCharsets.UTF_8).length;
            count(area + "_literal_bytes", bytes);
            counts.merge("max_literal_bytes", (long) bytes, Math::max);
        }
    }
    private static String area(Node graph) {
        return graph.equals(org.apache.jena.graph.NodeFactory.createURI(CommandPolicy.REVISIONS))
            ? "revisions" : graph.equals(org.apache.jena.graph.NodeFactory.createURI(CommandPolicy.CURRENT))
            ? "current" : "other";
    }
    String serverTiming() {
        phase("response");
        StringBuilder result = new StringBuilder("jena;dur=").append(ms(System.nanoTime() - started));
        nanos.forEach((name, value) -> result.append(", ").append(name).append(";dur=").append(ms(value)));
        return result.toString();
    }
    String counters() {
        return counts.entrySet().stream().map(entry -> entry.getKey() + "=" + entry.getValue())
            .collect(java.util.stream.Collectors.joining(","));
    }
    private static String ms(long nanos) { return String.format(java.util.Locale.ROOT, "%.3f", nanos / 1_000_000.0); }
    @Override public void close() { CURRENT.remove(); }
}
