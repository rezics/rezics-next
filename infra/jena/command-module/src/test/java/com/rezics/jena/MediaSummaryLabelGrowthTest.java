package com.rezics.jena;

import static org.junit.Assert.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.TreeSet;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.algebra.Algebra;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.DatasetGraphWrapperView;
import org.apache.jena.sparql.core.Quad;
import org.junit.Test;

/** Executes the emitted production query, rather than a rewritten cost model. */
public class MediaSummaryLabelGrowthTest {
    private static final String RV = "https://rezics.com/vocab/", RDFS = "http://www.w3.org/2000/01/rdf-schema#";
    private static final Node CURRENT = uri("urn:rezics:graph:current"), REVISIONS = uri("urn:rezics:graph:revisions");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node id(int n) { return uri(String.format("https://rezics.com/id/00000000-0000-4000-8000-%012d", n)); }
    private static Node p(String value) { return uri(RV + value); }
    private static Node type() { return uri("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static void label(DatasetGraph data, Node resource, String value) {
        data.add(CURRENT, resource, uri(RDFS + "label"), NodeFactory.createLiteralLang(value, "en"));
    }
    private static void work(DatasetGraph data, int n, String title) {
        data.add(CURRENT, id(n), type(), uri("https://schema.org/CreativeWork"));
        data.add(CURRENT, id(n), p("mainVersion"), id(1000000 + n));
        data.add(CURRENT, id(n), p("head"), id(2000000 + n));
        label(data, id(n), title);
    }
    private static void agent(DatasetGraph data, int n, boolean named) {
        data.add(CURRENT, id(n), type(), p("Agent"));
        data.add(CURRENT, id(n), p("head"), id(100 + n));
        data.add(REVISIONS, id(100 + n), type(), p("RevisionAnchor"));
        data.add(REVISIONS, id(100 + n), p("component"), id(n));
        data.add(REVISIONS, id(100 + n), p("modelRevision"), uri("https://rezics.com/definition/agent-provision-v1"));
        if (named) label(data, id(n), "Agent " + n);
    }
    private static void zone(DatasetGraph data, int n, boolean ownLabel, boolean spaceLabel) {
        data.add(CURRENT, id(n), type(), p("Zone"));
        data.add(CURRENT, id(n), p("zoneState"), p("Active"));
        data.add(CURRENT, id(n), p("space"), id(3000000 + n));
        data.add(CURRENT, id(n), p("disclosure"), p("Public"));
        if (ownLabel) label(data, id(n), "Zone " + n);
        if (spaceLabel) label(data, id(3000000 + n), "Space " + n);
    }
    private static final class Measured extends DatasetGraphWrapper implements DatasetGraphWrapperView {
        long quads;
        Measured(DatasetGraph source) { super(source); }
        @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
            return org.apache.jena.atlas.iterator.Iter.map(super.find(g, s, p, o), q -> { quads++; return q; });
        }
        @Override public Iterator<Quad> findNG(Node g, Node s, Node p, Node o) {
            return org.apache.jena.atlas.iterator.Iter.map(super.findNG(g, s, p, o), q -> { quads++; return q; });
        }
        @Override public org.apache.jena.graph.Graph getGraph(Node graph) {
            return new org.apache.jena.sparql.graph.GraphWrapper(super.getGraph(graph)) {
                @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(org.apache.jena.graph.Triple pattern) {
                    return super.find(pattern).mapWith(t -> { quads++; return t; });
                }
                @Override public org.apache.jena.util.iterator.ExtendedIterator<org.apache.jena.graph.Triple> find(Node s, Node p, Node o) {
                    return super.find(s, p, o).mapWith(t -> { quads++; return t; });
                }
            };
        }
    }
    private record Read(List<String> rows, long quads) {}
    private static Read read(DatasetGraph data, String query) {
        var measured = new Measured(data);
        List<String> rows = new ArrayList<>();
        try (var run = QueryExecution.create(query, DatasetFactory.wrap(measured))) {
            var result = run.execSelect();
            while (result.hasNext()) {
                var row = result.next();
                if (!row.contains("r") || !row.contains("type")) continue;
                rows.add(row.getResource("r").getURI() + "|" + row.getLiteral("type").getString() + "|"
                    + (row.contains("label") ? row.getLiteral("label").getString() : "<absent>") + "|"
                    + row.getLiteral("public").getBoolean());
            }
        }
        rows.sort(String::compareTo);
        return new Read(rows, measured.quads);
    }
    @Test public void unrelatedLabelsDoNotEnterEitherOptionalInput() throws Exception {
        String bounded = Files.readString(Path.of("summary-bounded.rq"));
        String baseline = Files.readString(Path.of("summary-baseline.rq"));
        assertNotEquals(baseline, bounded);
        for (String name : List.of("bounded", "baseline")) {
            String query = name.equals("bounded") ? bounded : baseline;
            Files.writeString(Path.of("summary-" + name + ".algebra"), Algebra.optimize(Algebra.compile(QueryFactory.create(query))).toString());
        }
        List<Long> fixedWork = new ArrayList<>(), oldWork = new ArrayList<>();
        for (int unrelated : new int[] {26, 200, 2000}) {
            Path directory = Files.createTempDirectory("summary-label-growth-");
            var data = org.apache.jena.tdb2.DatabaseMgr.connectDatasetGraph(directory.toString());
            try {
                data.begin(ReadWrite.WRITE);
                try {
                    Node product = uri("urn:rezics:dataset:product"), control = uri("urn:rezics:graph:control");
                    data.add(control, product, p("dataEpoch"), text("epoch"));
                    data.add(control, product, p("sequence"), text("7"));
                    // Three matching Works; hydration remains one requested card.
                    for (int n = 1; n <= 3; n++) work(data, n, "Work " + n);
                    agent(data, 10, true); agent(data, 11, false);
                    agent(data, 12, true); data.add(CURRENT, id(12), p("profileDisclosure"), p("Private"));
                    agent(data, 13, true); data.add(CURRENT, id(13), p("protectionHead"), id(113));
                    zone(data, 20, true, true); zone(data, 21, false, true); zone(data, 22, false, false);
                    for (int n = 0; n < unrelated; n++) {
                        work(data, 10000 + n, "Unrelated " + n);
                        zone(data, 20000 + n, false, true);
                    }
                    data.commit();
                } finally { data.end(); }
                data.begin(ReadWrite.READ);
                try {
                    Read old = read(data, baseline), fixed = read(data, bounded);
                    assertEquals(List.of(id(1).getURI() + "|work|Work 1|false"), fixed.rows());
                    assertEquals(old.rows(), fixed.rows());
                    oldWork.add(old.quads()); fixedWork.add(fixed.quads());
                    System.out.printf("summary labels unrelated=%d baselineQuads=%d boundedQuads=%d rows=%d%n", unrelated, old.quads(), fixed.quads(), fixed.rows().size());
                    Read semantic = read(data, Files.readString(Path.of("summary-semantics.rq")));
                    assertEquals(new TreeSet<>(List.of(
                        id(1).getURI() + "|work|Work 1|false",
                        id(10).getURI() + "|agent|Agent 10|true", id(11).getURI() + "|agent|<absent>|true",
                        id(20).getURI() + "|zone|Zone 20|true", id(21).getURI() + "|zone|Space 21|true",
                        id(22).getURI() + "|zone|<absent>|true")), new TreeSet<>(semantic.rows()));
                } finally { data.end(); }
            } finally {
                data.close();
                try (var paths = Files.walk(directory)) {
                    for (Path file : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(file);
                }
            }
        }
        assertTrue("the old independent label input must witness growth: " + oldWork, oldWork.get(2) > oldWork.get(1) && oldWork.get(1) > oldWork.get(0));
        assertEquals("fixed requested batch must have flat physical quad visits", fixedWork.get(0), fixedWork.get(1));
        assertEquals("fixed requested batch must have flat physical quad visits", fixedWork.get(0), fixedWork.get(2));
        assertTrue("bounded input must remove unrelated label visits", fixedWork.get(0) < oldWork.get(0));
    }
}
