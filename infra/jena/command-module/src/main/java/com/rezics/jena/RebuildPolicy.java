package com.rezics.jena;

import java.util.HashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** Inspect only explicit, bounded cleanup subjects in the same TDB2 transaction. */
final class RebuildPolicy {
    private static final Node PUBLIC = NodeFactory.createURI(CommandPolicy.PUBLIC_SEARCH);
    private static final Node MATCH_UNIT = NodeFactory.createURI("https://rezics.com/vocab/MatchUnit");
    private static final Node PROJECTION = NodeFactory.createURI("https://rezics.com/vocab/projection");

    record Snapshot(Set<Quad> before, Set<Node> subjects, String error) {}

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt) {
        if (!receipt.startsWith("urn:rezics:receipt:content-rebuild:clear:"))
            return new Snapshot(Set.of(), Set.of(), null);
        UpdateModify modify = (UpdateModify) plan.request().getOperations().getFirst();
        Set<Node> subjects = new HashSet<>();
        for (Quad quad : modify.getDeleteQuads()) {
            if (PUBLIC.equals(quad.getGraph())) subjects.add(quad.getSubject());
        }
        Set<Quad> before = quads(data, subjects);
        for (Node subject : subjects) {
            if (!data.contains(PUBLIC, subject, RDF.type.asNode(), MATCH_UNIT))
                return new Snapshot(Set.of(), Set.of(), "cleanup target is not a Content MatchUnit");
            var projections = data.find(PUBLIC, subject, PROJECTION, Node.ANY);
            boolean validProjection = false;
            while (projections.hasNext()) {
                Node value = projections.next().getObject();
                if (value.isURI() && value.getURI().startsWith("urn:rezics:content:projection:"))
                    validProjection = true;
            }
            if (!validProjection)
                return new Snapshot(Set.of(), Set.of(), "cleanup target lacks a Content projection");
        }
        return new Snapshot(Set.copyOf(before), Set.copyOf(subjects), null);
    }

    static String check(DatasetGraph data, String receipt, Snapshot snapshot) {
        if (snapshot.error() != null) return snapshot.error();
        if (!receipt.startsWith("urn:rezics:receipt:content-rebuild:clear:")) return null;
        Set<Quad> after = quads(data, snapshot.subjects());
        if (!snapshot.before().containsAll(after)) return "cleanup inserted a public index triple";
        if (snapshot.before().equals(after)) return "cleanup removed no Content MatchUnit";
        if (!after.isEmpty()) return "cleanup left partial Content MatchUnit triples";
        return null;
    }

    private static Set<Quad> quads(DatasetGraph data, Set<Node> subjects) {
        Set<Quad> result = new HashSet<>();
        for (Node subject : subjects) {
            var iter = data.find(PUBLIC, subject, Node.ANY, Node.ANY);
            while (iter.hasNext()) result.add(iter.next());
        }
        return result;
    }

    private RebuildPolicy() {}
}
