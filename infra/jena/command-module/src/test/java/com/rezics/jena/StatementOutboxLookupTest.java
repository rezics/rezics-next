package com.rezics.jena;

import static org.junit.Assert.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.datatypes.xsd.XSDDatatype;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.Triple;
import org.apache.jena.query.ARQ;
import org.apache.jena.query.Dataset;
import org.apache.jena.query.DatasetFactory;
import org.apache.jena.query.Query;
import org.apache.jena.query.QueryExecution;
import org.apache.jena.query.QueryFactory;
import org.apache.jena.query.ReadWrite;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.DatasetGraphWrapperView;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.core.Var;
import org.apache.jena.sparql.graph.GraphWrapper;
import org.apache.jena.sparql.syntax.ElementData;
import org.apache.jena.sparql.syntax.ElementPathBlock;
import org.apache.jena.sparql.syntax.ElementSubQuery;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
import org.apache.jena.tdb2.TDB2Factory;
import org.apache.jena.util.iterator.ExtendedIterator;
import org.apache.jena.vocabulary.RDF;
import org.junit.Assume;
import org.junit.Test;

/** The TypeScript caller exports the actual production query strings as .rq files. */
public class StatementOutboxLookupTest {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node OUTBOX = uri("urn:rezics:graph:outbox");
    private static final Node REVISIONS = uri("urn:rezics:graph:revisions");
    private static final Node SEQUENCE = p("sequence");
    private static final Node EPOCH = NodeFactory.createLiteralString("epoch");
    private static final List<Integer> REQUESTED = List.of(63, 64);

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String name) { return uri(RV + name); }
    private static Node id(String kind, int sequence) {
        return uri("urn:rezics:test:" + kind + ":" + sequence);
    }
    private static Node sequence(int value) {
        return NodeFactory.createLiteralDT(Integer.toString(value), XSDDatatype.XSDinteger);
    }
    private static boolean unbound(Node node) {
        return node == null || node == Node.ANY || node.isVariable();
    }

    private static void add(DatasetGraph data, Node graph, Node subject, Node type,
                            Node epoch, int value, Node component) {
        data.add(graph, subject, RDF.type.asNode(), type);
        data.add(graph, subject, p("dataEpoch"), epoch);
        data.add(graph, subject, SEQUENCE, sequence(value));
        if (OUTBOX.equals(graph)) data.add(graph, subject, p("eventCount"), sequence(0));
        if (component != null) data.add(graph, subject, p("component"), component);
    }

    private static Dataset fixture(int population) {
        Dataset dataset = TDB2Factory.createDataset();
        dataset.begin(ReadWrite.WRITE);
        try {
            DatasetGraph data = dataset.asDatasetGraph();
            for (int value = 1; value <= population; value++) {
                add(data, OUTBOX, id("batch", value), p("OutboxBatch"), EPOCH, value, null);
                add(data, REVISIONS, id("statement-revision", value), p("StatementRevision"),
                    EPOCH, value, id("statement", value));
                add(data, REVISIONS, id("semantic-revision", value), p("SemanticRevision"),
                    EPOCH, value, id("coordinate", value));
            }
            for (int value : REQUESTED) {
                for (String kind : List.of("batch", "statement-revision", "semantic-revision")) {
                    Node graph = kind.equals("batch") ? OUTBOX : REVISIONS;
                    Node type = p(kind.equals("batch") ? "OutboxBatch"
                        : kind.equals("statement-revision") ? "StatementRevision" : "SemanticRevision");
                    Node component = kind.equals("batch") ? null
                        : id(kind.equals("statement-revision") ? "other-statement" : "other-coordinate", value);
                    add(data, graph, id("other-epoch-" + kind, value), type,
                        NodeFactory.createLiteralString("other-epoch"), value, component);
                    add(data, graph, id("wrong-type-" + kind, value), p("UnrelatedRevision"),
                        EPOCH, value, component);
                }
            }
            dataset.commit();
        } finally { dataset.end(); }
        return dataset;
    }

    private static final class Store implements AutoCloseable {
        final Dataset dataset;
        Store(int population) { dataset = fixture(population); }
        @Override public void close() { dataset.close(); }
    }

    private record Lookup(Node graph, Node subject, Node predicate, Node object) {}

    // View prevents ARQ from unwrapping the observer and bypassing its graph reads.
    private static final class Measured extends DatasetGraphWrapper implements DatasetGraphWrapperView {
        long triples;
        final Set<Node> visitedSubjects = new HashSet<>();
        final List<Lookup> lookups = new ArrayList<>();
        Measured(DatasetGraph data) { super(data); }
        private Triple emitted(Triple triple) {
            triples++;
            visitedSubjects.add(triple.getSubject());
            return triple;
        }
        private Quad emitted(Quad quad) {
            emitted(quad.asTriple());
            return quad;
        }
        @Override public Iterator<Quad> find(Node graph, Node subject, Node predicate, Node object) {
            lookups.add(new Lookup(graph, subject, predicate, object));
            return Iter.map(super.find(graph, subject, predicate, object), this::emitted);
        }
        @Override public Iterator<Quad> findNG(Node graph, Node subject, Node predicate, Node object) {
            lookups.add(new Lookup(graph, subject, predicate, object));
            return Iter.map(super.findNG(graph, subject, predicate, object), this::emitted);
        }
        @Override public Graph getGraph(Node graph) {
            return new GraphWrapper(super.getGraph(graph)) {
                @Override public ExtendedIterator<Triple> find(Triple pattern) {
                    lookups.add(new Lookup(graph, pattern.getMatchSubject(),
                        pattern.getMatchPredicate(), pattern.getMatchObject()));
                    return super.find(pattern).mapWith(Measured.this::emitted);
                }
                @Override public ExtendedIterator<Triple> find(Node subject, Node predicate, Node object) {
                    lookups.add(new Lookup(graph, subject, predicate, object));
                    return super.find(subject, predicate, object).mapWith(Measured.this::emitted);
                }
            };
        }
    }

    private record Run(List<Map<String, Node>> rows, long triples, int subjects, List<Lookup> lookups) {}

    private static Run run(Dataset dataset, Query query) {
        dataset.begin(ReadWrite.READ);
        try {
            Measured measured = new Measured(dataset.asDatasetGraph());
            List<Map<String, Node>> rows = new ArrayList<>();
            try (QueryExecution execution = QueryExecution.create(query, DatasetFactory.wrap(measured))) {
                // Keep production ARQ optimization enabled; a textual ordering assertion alone
                // cannot prove that VALUES bindings reach the first graph lookup.
                execution.getContext().set(ARQ.optimization, true);
                var results = execution.execSelect();
                while (results.hasNext()) {
                    var solution = results.next();
                    Map<String, Node> row = new HashMap<>();
                    for (String name : query.getResultVars()) {
                        if (name.equals("event")) {
                            assertFalse("empty batch unexpectedly returned an event", solution.contains(name));
                            continue;
                        }
                        assertTrue("unbound result variable: " + name, solution.contains(name));
                        row.put(name, solution.get(name).asNode());
                    }
                    rows.add(row);
                }
            }
            return new Run(rows, measured.triples, measured.visitedSubjects.size(), measured.lookups);
        } finally { dataset.end(); }
    }

    private static Set<Node> requested(Query query) {
        Set<Node> values = new HashSet<>();
        ElementWalker.walk(query.getQueryPattern(), new ElementVisitorBase() {
            @Override public void visit(ElementData data) {
                for (var row : data.getRows()) {
                    Node value = row.get(Var.alloc("sequence"));
                    if (value != null) values.add(value);
                }
            }
            @Override public void visit(ElementPathBlock block) {
                block.patternElts().forEachRemaining(path -> {
                    if (path.isTriple() && SEQUENCE.equals(path.getPredicate()) && path.getObject().isLiteral())
                        values.add(path.getObject());
                });
            }
            @Override public void visit(ElementSubQuery subquery) { values.addAll(requested(subquery.getQuery())); }
        });
        assertFalse("query must bind at least one requested sequence", values.isEmpty());
        for (Node value : values) assertTrue("unexpected requested sequence: " + value,
            REQUESTED.contains(Integer.parseInt(value.getLiteralLexicalForm())));
        return values;
    }

    private static Set<Map<String, Node>> expected(Query query) {
        Set<Map<String, Node>> rows = new HashSet<>();
        for (Node requested : requested(query)) {
            int value = Integer.parseInt(requested.getLiteralLexicalForm());
            Map<String, Node> all = Map.of("sequence", sequence(value), "batch", id("batch", value),
                "statement", id("statement", value), "coordinate", id("coordinate", value), "count", sequence(0));
            Map<String, Node> row = new HashMap<>();
            for (String name : query.getResultVars()) {
                if (name.equals("event")) continue;
                assertTrue("unexpected production result variable: " + name, all.containsKey(name));
                row.put(name, all.get(name));
            }
            rows.add(row);
        }
        return rows;
    }

    private static void assertPerValueStart(String name, Query query, Run run) {
        Set<Node> starts = new HashSet<>();
        for (Lookup lookup : run.lookups()) {
            if (SEQUENCE.equals(lookup.predicate()) && unbound(lookup.subject())) {
                assertFalse(name + " enumerated sequences without a bound value", unbound(lookup.object()));
                starts.add(lookup.object());
            }
        }
        assertEquals(name + " must start a lookup for each VALUES binding",
            requested(query), starts);
    }

    @Test public void productionLookupsKeepTheSameVisitedWorkAtSixteenTimesTheHistory() throws Exception {
        String directory = System.getProperty("rezics.statement.seek.queries");
        Assume.assumeTrue("production queries are exported by the TypeScript test", directory != null);
        List<Path> paths;
        try (var files = Files.list(Path.of(directory))) {
            paths = files.filter(path -> path.getFileName().toString().endsWith(".rq")).sorted().toList();
        }
        assertFalse("no production lookup queries supplied", paths.isEmpty());
        try (Store small = new Store(64); Store large = new Store(1024)) {
            for (Path path : paths) {
                String name = path.getFileName().toString();
                Query query = QueryFactory.create(Files.readString(path));
                Run before = run(small.dataset, query), after = run(large.dataset, query);
                Set<Map<String, Node>> expected = expected(query);
                assertEquals(name + " selected other-epoch/wrong-type or missing rows", expected, new HashSet<>(before.rows()));
                assertEquals(name + " duplicated results", expected.size(), before.rows().size());
                assertEquals(name + " result changed with unrelated history", new HashSet<>(before.rows()), new HashSet<>(after.rows()));
                assertEquals(name + " duplicated results after growth", expected.size(), after.rows().size());
                assertPerValueStart(name, query, before);
                assertPerValueStart(name, query, after);
                assertTrue(name + " observer missed graph execution", before.triples() > 0);
                assertEquals(name + " visited more triples as history grew", before.triples(), after.triples());
                assertEquals(name + " visited more subjects as history grew", before.subjects(), after.subjects());
                assertTrue(name + " exceeded the fixed lookup budget", after.triples() <= 64);
                System.out.println("Statement lookup " + name + ": visited triples=" + before.triples() + "/" + after.triples()
                    + ", subjects=" + before.subjects() + "/" + after.subjects());
            }

            Query old = QueryFactory.create("PREFIX rv: <" + RV + "> SELECT ?sequence ?batch WHERE { "
                + "VALUES ?sequence { 63 64 } GRAPH <" + OUTBOX.getURI() + "> { "
                + "?batch a rv:OutboxBatch ; rv:dataEpoch \"epoch\" ; rv:sequence ?sequence } }");
            Run before = run(small.dataset, old), after = run(large.dataset, old);
            assertEquals(expected(old), new HashSet<>(before.rows()));
            assertEquals(new HashSet<>(before.rows()), new HashSet<>(after.rows()));
            assertTrue("negative control failed to observe the type-first history scan: "
                + before.triples() + "/" + after.triples(), after.triples() >= before.triples() * 8);
            assertTrue("negative control missed unrelated batches", after.subjects() >= 1024);
            System.out.println("Statement lookup type-first negative control: visited triples=" + before.triples()
                + "/" + after.triples() + ", subjects=" + before.subjects() + "/" + after.subjects());
        }
    }
}
