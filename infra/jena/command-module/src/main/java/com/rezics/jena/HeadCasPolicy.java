package com.rezics.jena;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** Exact head transitions are checked against the prestate and receipt in one write transaction. */
final class HeadCasPolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node HEAD = rv("head");
    private static final Node SELECTION_HEAD = rv("selectionHead");

    private record Key(Node subject, Node predicate) {}
    private record Transition(Key key, Node before, Node next) {}
    record Snapshot(List<Transition> transitions, String error) {}

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify))
            return new Snapshot(List.of(), null);
        Map<Key, List<Node>> inserted = new HashMap<>();
        Map<Key, List<Node>> deleted = new HashMap<>();
        collect(modify.getInsertQuads(), inserted);
        collect(modify.getDeleteQuads(), deleted);
        Set<Key> keys = new HashSet<>(inserted.keySet());
        keys.addAll(deleted.keySet());
        List<Transition> transitions = new ArrayList<>();
        for (Key key : keys) {
            List<Node> beforeValues = values(data, CURRENT, key.subject(), key.predicate());
            boolean transition = SELECTION_HEAD.equals(key.predicate())
                || !beforeValues.isEmpty() || deleted.containsKey(key);
            if (!transition) continue; // A fresh component's first head is covered by its canonical shape.
            List<Node> nextValues = inserted.getOrDefault(key, List.of());
            List<Node> oldTemplate = deleted.getOrDefault(key, List.of());
            if (beforeValues.size() > 1 || nextValues.size() != 1 || !nextValues.getFirst().isURI()
                || oldTemplate.size() != 1 || !key.subject().isURI())
                return new Snapshot(List.of(), "head transition template or prestate is ambiguous");
            Node before = beforeValues.isEmpty() ? null : beforeValues.getFirst();
            Node deletedValue = oldTemplate.getFirst();
            if (before != null && !(deletedValue.isVariable() || deletedValue.equals(before)))
                return new Snapshot(List.of(), "head deletion differs from prestate");
            if (before == null && !deletedValue.isVariable())
                return new Snapshot(List.of(), "absent head requires an optional predecessor binding");
            transitions.add(new Transition(key, before, nextValues.getFirst()));
        }
        if (transitions.size() > 1) return new Snapshot(List.of(), "one head transition required");
        if (!transitions.isEmpty()) {
            Node before = transitions.getFirst().before();
            List<Node> declared = new ArrayList<>();
            for (Quad quad : modify.getInsertQuads()) {
                if (RECEIPTS.equals(quad.getGraph()) && uri(receipt).equals(quad.getSubject())
                    && rv("expectedHead").equals(quad.getPredicate())) declared.add(quad.getObject());
            }
            if (before == null ? !declared.isEmpty()
                : declared.size() != 1 || !before.equals(declared.getFirst()))
                return new Snapshot(List.of(), "receipt expected head differs from transaction prestate");
        }
        return new Snapshot(List.copyOf(transitions), null);
    }

    static String check(DatasetGraph data, String receipt, Snapshot snapshot) {
        if (snapshot.error() != null) return snapshot.error();
        if (snapshot.transitions().isEmpty()) return null;
        Transition transition = snapshot.transitions().getFirst();
        Node own = uri(receipt);
        Node subject = transition.key().subject();
        Node before = transition.before();
        Node next = transition.next();
        List<Node> actual = values(data, CURRENT, subject, transition.key().predicate());
        if (actual.size() != 1 || !actual.getFirst().equals(next))
            return "head poststate differs from exact successor";
        List<Node> expected = values(data, RECEIPTS, own, rv("expectedHead"));
        if (before == null ? !expected.isEmpty()
            : expected.size() != 1 || !before.equals(expected.getFirst()))
            return "receipt expected head differs from transaction prestate";
        if (!data.contains(RECEIPTS, own, rv("outcome"), rv("Succeeded")))
            return "head transition requires a successful receipt";
        Node admission = one(data, RECEIPTS, own, rv("admissionId"));
        Node epoch = one(data, RECEIPTS, own, rv("authorityEpoch"));
        Node scope = one(data, RECEIPTS, own, rv("admittedScope"));
        if (admission == null || !admission.isLiteral()
            || !admission.getLiteralLexicalForm().matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            || epoch == null || !epoch.isLiteral()
            || !epoch.getLiteralLexicalForm().matches("[0-9]+")
            || scope == null || !scope.isLiteral()) return "head transition lacks an exact Access admission";

        String requiredScope;
        if (HEAD.equals(transition.key().predicate())) {
            if (before == null || !same(data, RECEIPTS, own, "work", subject)
                || !same(data, RECEIPTS, own, "workRevision", next))
                return "Work edit head differs from its receipt";
            requiredScope = "work:edit:" + subject.getURI();
        } else if (same(data, RECEIPTS, own, "selection", next)) {
            Node realm = one(data, RECEIPTS, own, rv("realm"));
            if (realm == null) {
                if (!same(data, RECEIPTS, own, "mainVersion", subject)
                    || one(data, RECEIPTS, own, rv("slot")) != null)
                    return "Main selection head differs from its receipt";
                requiredScope = "publication:select:" + subject.getURI();
            } else {
                if (!realm.isURI() || !same(data, RECEIPTS, own, "slot", subject))
                    return "Realm selection head differs from its receipt";
                requiredScope = "publication:adopt:" + realm.getURI();
            }
        } else if (same(data, RECEIPTS, own, "rejection", next)) {
            Node realm = one(data, RECEIPTS, own, rv("realm"));
            if (realm == null || !realm.isURI() || !same(data, RECEIPTS, own, "slot", subject))
                return "Realm rejection head differs from its receipt";
            requiredScope = "publication:reject:" + realm.getURI();
        } else return "selection head lacks its result receipt";
        if (!requiredScope.equals(scope.getLiteralLexicalForm()))
            return "head transition Access scope differs from target";
        if (!data.contains(REVISIONS, next, rv("component"), subject)
            || before != null && !data.contains(REVISIONS, next, rv("predecessor"), before)
            || before == null && data.contains(REVISIONS, next, rv("predecessor"), Node.ANY)
            || !data.contains(REVISIONS, next, RDF.type.asNode(), rv("RevisionAnchor")))
            return "head successor revision differs from prestate or component";
        return null;
    }

    private static boolean same(DatasetGraph data, Node graph, Node subject, String predicate, Node value) {
        return value.equals(one(data, graph, subject, rv(predicate)));
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        List<Node> found = values(data, graph, subject, predicate);
        return found.size() == 1 ? found.getFirst() : null;
    }
    private static List<Node> values(DatasetGraph data, Node graph, Node subject, Node predicate) {
        List<Node> found = new ArrayList<>();
        data.find(graph, subject, predicate, Node.ANY).forEachRemaining(quad -> found.add(quad.getObject()));
        return found;
    }
    private static void collect(List<Quad> quads, Map<Key, List<Node>> target) {
        for (Quad quad : quads) if (CURRENT.equals(quad.getGraph()) && isHead(quad.getPredicate())) {
            target.computeIfAbsent(new Key(quad.getSubject(), quad.getPredicate()), ignored -> new ArrayList<>())
                .add(quad.getObject());
        }
    }
    private static boolean isHead(Node predicate) {
        return HEAD.equals(predicate) || SELECTION_HEAD.equals(predicate);
    }
    private static Node rv(String name) { return uri(RV + name); }
    private static Node uri(String name) { return NodeFactory.createURI(name); }
    private HeadCasPolicy() {}
}
