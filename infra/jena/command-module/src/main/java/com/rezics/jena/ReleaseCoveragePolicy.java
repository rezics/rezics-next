package com.rezics.jena;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Entry retirement is allowed only within its owner's successful release CAS.
 * Cost: at most 100 captured subjects, 64 entries per release and indexed inbound checks.
 * Immutable release revision payloads retain the removed entry's historical state. */
final class ReleaseCoveragePolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node V3 = uri("https://rezics.com/definition/release-v3");

    static Map<String, Set<Node>> capture(DatasetGraph data, ModelMutationPolicy.Snapshot before) {
        Map<String, Set<Node>> result = new HashMap<>();
        before.current().forEach((name, subject) -> {
            if (subject.selection() != null && subject.selection().type().equals(RV + "Release")
                && subject.selection().route().profile().equals("release-v3")) {
                Set<Node> entries = values(data, CURRENT, uri(name), "coverage");
                if (entries.size() <= 64) result.put(name, entries);
            }
        });
        return Map.copyOf(result);
    }

    static Set<String> retired(DatasetGraph data, String receipt, ModelMutationPolicy.Snapshot before,
                               Map<String, Set<Node>> coverage) {
        Set<String> result = new HashSet<>();
        before.current().forEach((name, subject) -> {
            if (subject.selection() == null || !subject.selection().type().equals(RV + "ReleaseCoverage")
                || !subject.selection().route().profile().equals("release-v3")
                || !subject.types().equals(Set.of(uri(RV + "ReleaseCoverage")))) return;
            Node entry = uri(name);
            if (data.find(CURRENT, entry, Node.ANY, Node.ANY).hasNext()
                || data.find(CURRENT, Node.ANY, Node.ANY, entry).hasNext()
                || data.find(REVISIONS, Node.ANY, Node.ANY, entry).hasNext()) return;
            var owners = coverage.entrySet().stream().filter(row -> row.getValue().contains(entry)).toList();
            if (owners.size() != 1) return;
            String release = owners.get(0).getKey();
            if (successfulCas(data, receipt, release, before.current().get(release))) result.add(name);
        });
        return Set.copyOf(result);
    }

    /** Exclude only certified retired entries from generic poststate shape checks. */
    static ModelMutationPolicy.Snapshot remaining(ModelMutationPolicy.Snapshot before, Set<String> retired) {
        Map<String, ModelMutationPolicy.Subject> current = new HashMap<>(before.current());
        retired.forEach(current::remove);
        return new ModelMutationPolicy.Snapshot(Map.copyOf(current), before.revisions());
    }

    private static boolean successfulCas(DatasetGraph data, String receipt, String name,
                                         ModelMutationPolicy.Subject before) {
        Node release = uri(name), own = uri(receipt);
        Set<Node> heads = values(data, CURRENT, release, "releaseHead");
        Set<Node> expected = values(data, RECEIPTS, own, "expectedHead");
        Set<Node> works = values(data, CURRENT, release, "work");
        if (heads.size() != 1 || expected.size() != 1 || works.size() != 1
            || !expected.equals(before.releaseBasis().get("releaseHead"))
            || !works.equals(before.releaseBasis().get("work"))
            || !values(data, CURRENT, release, "releaseKind").equals(before.releaseBasis().get("releaseKind"))) return false;
        Node head = heads.iterator().next(), prior = expected.iterator().next(), work = works.iterator().next();
        return head.isURI() && prior.isURI() && work.isURI() && !head.equals(prior)
            && values(data, CURRENT, release, "definitionProfile").equals(Set.of(V3))
            && data.contains(CURRENT, release, RDF.type.asNode(), uri(RV + "Release"))
            && data.contains(RECEIPTS, own, uri(RV + "work"), work)
            && data.contains(RECEIPTS, own, uri(RV + "admittedScope"), literal("work:edit:" + work.getURI()))
            && data.contains(RECEIPTS, own, uri(RV + "release"), release)
            && data.contains(RECEIPTS, own, uri(RV + "releaseRevision"), head)
            && data.contains(RECEIPTS, own, uri(RV + "action"), literal("work.edit"))
            && data.contains(RECEIPTS, own, uri(RV + "outcome"), uri(RV + "Succeeded"))
            && data.contains(REVISIONS, head, uri(RV + "component"), release)
            && data.contains(REVISIONS, head, uri(RV + "predecessor"), prior)
            && data.contains(REVISIONS, head, uri(RV + "modelRevision"), V3)
            && data.contains(REVISIONS, head, uri(RV + "shapeRevision"), V3)
            && data.contains(REVISIONS, prior, uri(RV + "component"), release);
    }

    private static Set<Node> values(DatasetGraph data, Node graph, Node subject, String predicate) {
        Set<Node> result = new HashSet<>();
        data.find(graph, subject, uri(RV + predicate), Node.ANY).forEachRemaining(quad -> result.add(quad.getObject()));
        return Set.copyOf(result);
    }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private ReleaseCoveragePolicy() {}
}
