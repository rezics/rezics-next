package com.rezics.jena;

import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.Set;
import org.apache.jena.atlas.iterator.Iter;
import org.apache.jena.graph.Graph;
import org.apache.jena.graph.Node;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.DatasetGraphWrapper;
import org.apache.jena.sparql.core.DatasetGraphWrapperView;
import org.apache.jena.sparql.core.GraphView;
import org.apache.jena.sparql.core.Quad;

/** Bounded item savepoint without a corpus copy or a nested TDB transaction.
 * Reads retain the underlying indexes. RDF and Lucene mutations reach the
 * shared writer only after the item's complete validation succeeds. */
final class CommandOverlay extends DatasetGraphWrapper implements DatasetGraphWrapperView {
    private static final int MAX_QUADS = 16_384;
    private final Set<Quad> adds = new LinkedHashSet<>(), deletes = new LinkedHashSet<>();
    CommandOverlay(DatasetGraph parent) { super(parent); }
    private void bound() {
        if (adds.size() + deletes.size() > MAX_QUADS)
            throw new IllegalArgumentException("bulk item exceeds staged quad bound");
    }
    @Override public void add(Quad quad) {
        deletes.remove(quad);
        if (!super.contains(quad)) adds.add(quad);
        bound();
    }
    @Override public void add(Node g, Node s, Node p, Node o) { add(new Quad(g, s, p, o)); }
    @Override public void delete(Quad quad) {
        adds.remove(quad);
        if (super.contains(quad)) deletes.add(quad);
        bound();
    }
    @Override public void delete(Node g, Node s, Node p, Node o) { delete(new Quad(g, s, p, o)); }
    @Override public void deleteAny(Node g, Node s, Node p, Node o) {
        var values = find(g, s, p, o);
        var matches = new java.util.ArrayList<Quad>();
        try {
            while (values.hasNext()) {
                if (matches.size() >= MAX_QUADS) throw new IllegalArgumentException("bulk item delete exceeds quad bound");
                matches.add(values.next());
            }
        } finally { Iter.close(values); }
        matches.forEach(this::delete);
    }
    @Override public Iterator<Quad> find(Node g, Node s, Node p, Node o) {
        if (Quad.isUnionGraph(g)) return Iter.distinct(Iter.map(findNG(Node.ANY, s, p, o),
            quad -> new Quad(Quad.unionGraph, quad.asTriple())));
        Iterator<Quad> original = Iter.filter(super.find(g, s, p, o), quad -> !deletes.contains(quad));
        return Iter.concat(original, adds.stream().filter(quad ->
            matches(g, quad.getGraph()) && matches(s, quad.getSubject())
            && matches(p, quad.getPredicate()) && matches(o, quad.getObject())).iterator());
    }
    private static boolean matches(Node pattern, Node value) {
        return pattern == null || pattern == Node.ANY || pattern.isVariable() || pattern.equals(value);
    }
    @Override public Iterator<Quad> find() { return find(Node.ANY, Node.ANY, Node.ANY, Node.ANY); }
    @Override public Iterator<Quad> find(Quad quad) { return find(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject()); }
    @Override public Iterator<Quad> findNG(Node g, Node s, Node p, Node o) {
        return Iter.filter(find(g, s, p, o), quad -> !quad.isDefaultGraph());
    }
    @Override public boolean contains(Quad quad) { return contains(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject()); }
    @Override public boolean contains(Node g, Node s, Node p, Node o) {
        var values = find(g, s, p, o);
        try { return values.hasNext(); } finally { Iter.close(values); }
    }
    @Override public boolean containsGraph(Node graph) {
        return Quad.isDefaultGraph(graph) || Quad.isUnionGraph(graph) || contains(graph, Node.ANY, Node.ANY, Node.ANY);
    }
    @Override public Iterator<Node> listGraphNodes() {
        return Iter.distinct(Iter.concat(super.listGraphNodes(), adds.stream().map(Quad::getGraph).iterator()));
    }
    @Override public boolean isEmpty() { return !contains(Node.ANY, Node.ANY, Node.ANY, Node.ANY); }
    @Override public java.util.stream.Stream<Quad> stream(Node g, Node s, Node p, Node o) { return Iter.asStream(find(g, s, p, o)); }
    @Override public java.util.stream.Stream<Quad> stream() { return Iter.asStream(find()); }
    @Override public Graph getGraph(Node graph) { return GraphView.createNamedGraph(this, graph); }
    @Override public Graph getDefaultGraph() { return GraphView.createDefaultGraph(this); }
    @Override public Graph getUnionGraph() { return GraphView.createUnionGraph(this); }
    @Override public void clear() { throw new IllegalArgumentException("bulk clear not admitted"); }
    @Override public void addGraph(Node name, Graph graph) { throw new IllegalArgumentException("bulk graph replacement not admitted"); }
    @Override public void removeGraph(Node name) { throw new IllegalArgumentException("bulk graph removal not admitted"); }
    boolean changed() { return !adds.isEmpty() || !deletes.isEmpty(); }
    void apply() {
        // Preserve delete-before-add semantics for the text wrapper, too.
        deletes.forEach(getWrapped()::delete);
        adds.forEach(getWrapped()::add);
    }
}
