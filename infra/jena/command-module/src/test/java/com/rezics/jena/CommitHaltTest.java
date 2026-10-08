package com.rezics.jena;

import static org.junit.Assert.*;

import java.lang.reflect.Proxy;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.apache.jena.sparql.core.DatasetGraph;
import org.junit.Test;

/** A failed commit stops the process. A normal commit does not, and no dataset commit bypasses that helper. */
public class CommitHaltTest {
    /** Stands in for a journal commit point written before a component fails. */
    private static final class PartialCommit extends RuntimeException {
        PartialCommit() { super("Out of bounds: (limit 10) 20\nwriter lock held"); }
    }

    @Test public void partialCommitAbortsLogsAndHaltsOnceWhileANormalCommitDoesNot() {
        List<String> failed = new ArrayList<>();
        DatasetGraph broken = dataset(
            () -> { failed.add("commit-point"); throw new PartialCommit(); },
            () -> { failed.add("abort"); throw new IllegalStateException("abort failed"); },
            () -> { failed.add("end"); throw new IllegalStateException("end failed"); });
        List<Integer> halts = new ArrayList<>();
        List<String> lines = new ArrayList<>();
        HaltScope scope = observe(halts, lines);
        try {
            PartialCommit thrown = assertThrows(PartialCommit.class, () -> CommitHalt.commit(broken));
            assertEquals("Out of bounds: (limit 10) 20\nwriter lock held", thrown.getMessage());
        } finally { scope.restore(); }
        assertEquals(List.of("commit-point", "abort", "end"), failed);
        assertEquals(List.of(CommitHalt.STATUS), halts);
        assertEquals(1, lines.size());
        String line = lines.get(0);
        assertFalse(line.contains("\n"));
        assertTrue(line.contains(PartialCommit.class.getName()));
        assertTrue(line.contains("Out of bounds: (limit 10) 20"));
        assertTrue(line.contains("writer lock held"));

        List<String> normal = new ArrayList<>();
        AtomicInteger commits = new AtomicInteger();
        DatasetGraph sound = dataset(
            () -> { commits.incrementAndGet(); normal.add("commit"); },
            () -> normal.add("abort"),
            () -> normal.add("end"));
        List<Integer> quietHalts = new ArrayList<>();
        List<String> quietLines = new ArrayList<>();
        scope = observe(quietHalts, quietLines);
        try { CommitHalt.commit(sound); }
        finally { scope.restore(); }
        assertEquals(1, commits.get());
        assertEquals(List.of("commit"), normal);
        assertEquals(List.of(), quietHalts);
        assertEquals(List.of(), quietLines);
    }

    /** Every dataset {@code commit()} in the command module goes through {@link CommitHalt}. */
    @Test public void datasetCommitStaysInsideTheHelper() throws Exception {
        Path root = Path.of("src/main/java");
        assertTrue(root.toAbsolutePath() + " is not the command-module source root", Files.isDirectory(root));
        List<String> offenders = new ArrayList<>();
        int delegated = 0;
        try (var files = Files.walk(root)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
                String name = root.relativize(file).toString().replace('\\', '/');
                boolean helper = name.endsWith("CommitHalt.java");
                for (String line : stripComments(Files.readString(file)).split("\n", -1)) {
                    // Helper calls are the required route. What remains is a direct commit.
                    String direct = line.replace("CommitHalt.commit(", "");
                    if (!direct.contains(".commit(") && !direct.contains("::commit")) continue;
                    if (helper && direct.contains("data.commit()")) { delegated++; continue; }
                    if (rankOrLuceneCommit(name, direct)) continue;
                    offenders.add(name + ": " + line.trim());
                }
            }
        }
        assertEquals(offenders.toString(), List.of(), offenders);
        assertEquals(1, delegated);
    }

    /** Rank-cursor getters and the Lucene writer are not a TDB2 dataset commit. */
    private static boolean rankOrLuceneCommit(String name, String line) {
        if (!name.endsWith("FilteredGraphTextIndex.java")) return false;
        String trimmed = line.trim();
        return trimmed.contains("after.commit()") || trimmed.contains("page.commit()")
            || trimmed.contains("lucene::commit");
    }

    private static DatasetGraph dataset(Runnable commit, Runnable abort, Runnable end) {
        return (DatasetGraph) Proxy.newProxyInstance(DatasetGraph.class.getClassLoader(),
            new Class<?>[] { DatasetGraph.class }, (proxy, method, args) -> {
                switch (method.getName()) {
                    case "commit" -> commit.run();
                    case "abort" -> abort.run();
                    case "end" -> end.run();
                    case "toString" -> { return "commit-halt-fixture"; }
                    default -> throw new UnsupportedOperationException(method.getName());
                }
                return null;
            });
    }

    private static HaltScope observe(List<Integer> halts, List<String> lines) {
        HaltScope scope = new HaltScope(CommitHalt.halt, CommitHalt.logged);
        CommitHalt.halt = halts::add;
        CommitHalt.logged = lines::add;
        return scope;
    }

    private record HaltScope(CommitHalt.Halt halt, java.util.function.Consumer<String> logged) {
        void restore() { CommitHalt.halt = halt; CommitHalt.logged = logged; }
    }

    static String stripComments(String source) {
        StringBuilder out = new StringBuilder(source.length());
        boolean lineComment = false, block = false, string = false, character = false, escape = false;
        for (int i = 0; i < source.length(); i++) {
            char c = source.charAt(i);
            char next = i + 1 < source.length() ? source.charAt(i + 1) : 0;
            if (lineComment) {
                if (c == '\n') { lineComment = false; out.append(c); }
                continue;
            }
            if (block) {
                if (c == '*' && next == '/') { block = false; i++; }
                else if (c == '\n') out.append('\n');
                continue;
            }
            if (string || character) {
                out.append(c);
                if (escape) { escape = false; continue; }
                if (c == '\\') { escape = true; continue; }
                if (string && c == '"') string = false;
                if (character && c == '\'') character = false;
                continue;
            }
            if (c == '/' && next == '/') { lineComment = true; i++; continue; }
            if (c == '/' && next == '*') { block = true; i++; continue; }
            if (c == '"') string = true;
            if (c == '\'') character = true;
            out.append(c);
        }
        return out.toString();
    }
}
