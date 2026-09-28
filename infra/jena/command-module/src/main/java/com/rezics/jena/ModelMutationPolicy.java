package com.rezics.jena;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Preserve prestate shape selection and validate bounded reverse dependencies
 * inside the same command transaction. Cost: at most 100 touched subjects from
 * CommandPolicy, 1,024 indexed inbound quads, 100 prior shape checks and 256
 * dependent shape checks.
 * A larger dependency fanout must be staged. */
final class ModelMutationPolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final int MAX_REVERSE_DEPENDENTS = 256;
    private static final int MAX_INBOUND_QUADS = 1_024;
    private static final Node CURRENT = NodeFactory.createURI(CommandPolicy.CURRENT);
    private static final Node REVISIONS = NodeFactory.createURI(CommandPolicy.REVISIONS);
    private static final Node RECEIPTS = NodeFactory.createURI(CommandPolicy.RECEIPTS);

    record Subject(Node graph, CanonicalPolicy.Selection selection, Map<String, Set<Node>> selectors,
                   Set<Node> types) {}
    record Snapshot(Map<String, Subject> current, Map<String, Subject> revisions) {}

    static Snapshot capture(ProfileRegistry profiles, DatasetGraph data, CommandPolicy.Plan plan) {
        return new Snapshot(captureGraph(profiles, data, CURRENT, plan.current(), false),
            captureGraph(profiles, data, REVISIONS, plan.revisions(), true));
    }

    private static Map<String, Subject> captureGraph(ProfileRegistry profiles, DatasetGraph data,
                                                      Node graph, Set<String> names, boolean revision) {
        Map<String, Subject> result = new LinkedHashMap<>();
        for (String name : names) {
            Node node = NodeFactory.createURI(name);
            if (!data.find(graph, node, Node.ANY, Node.ANY).hasNext()) continue;
            CanonicalPolicy.Selection selected = CanonicalPolicy.select(profiles, data, name, revision);
            Map<String, Set<Node>> selectors = new HashMap<>();
            if (selected != null) for (String path : selected.selectors())
                selectors.put(path, values(data, graph, node, NodeFactory.createURI(path)));
            if (!revision && selected != null && selected.type().equals(RV + "RouteBinding"))
                selectors.put(RV + "routeRevision", values(data, graph, node,
                    NodeFactory.createURI(RV + "routeRevision")));
            result.put(name, new Subject(graph, selected, Map.copyOf(selectors),
                values(data, graph, node, RDF.type.asNode())));
        }
        return Map.copyOf(result);
    }

    static Map<String, Object> check(ProfileRegistry profiles, DatasetGraph data, CommandPolicy.Plan plan,
                                     String receipt, Snapshot before) {
        for (var entry : before.current().entrySet()) {
            Map<String, Object> invalid = checkSubject(profiles, data, receipt, entry.getKey(), entry.getValue());
            if (invalid != null) return invalid;
        }
        for (var entry : before.revisions().entrySet()) {
            Map<String, Object> invalid = checkSubject(profiles, data, receipt, entry.getKey(), entry.getValue());
            if (invalid != null) return invalid;
        }
        Set<String> dependentCurrent = new HashSet<>();
        Set<String> dependentRevisions = new HashSet<>();
        int[] inboundQuads = { 0 };
        for (var entry : before.current().entrySet()) {
            // Structure head and generation-count edits preserve both resource types.
            // Their inbound occurrence/revision links constrain the referenced class,
            // not these mutable scalar fields; validating each sibling would turn a
            // bounded edit into a whole-Structure dependency scan.
            if (stableStructureType(data, entry.getKey(), entry.getValue())) continue;
            boolean agentTombstone = agentCompensation(data, receipt, entry.getKey(), entry.getValue());
            String overflow = dependents(profiles, data, entry.getKey(), plan,
                dependentCurrent, dependentRevisions, inboundQuads,
                typeChanged(data, entry.getKey(), entry.getValue()), agentTombstone);
            if (overflow != null) return CommandService.invalid(overflow);
        }
        for (var entry : before.revisions().entrySet()) {
            String overflow = dependents(profiles, data, entry.getKey(), plan,
                dependentCurrent, dependentRevisions, inboundQuads,
                typeChanged(data, entry.getKey(), entry.getValue()), false);
            if (overflow != null) return CommandService.invalid(overflow);
        }
        for (String subject : dependentCurrent) {
            Map<String, Object> invalid = CanonicalPolicy.validate(profiles, data, subject, false);
            if (invalid != null) return invalid;
        }
        for (String subject : dependentRevisions) {
            Map<String, Object> invalid = CanonicalPolicy.validate(profiles, data, subject, true);
            if (invalid != null) return invalid;
        }
        return null;
    }

    private static Map<String, Object> checkSubject(ProfileRegistry profiles, DatasetGraph data,
                                                    String receipt, String name, Subject before) {
        CanonicalPolicy.Selection selected = before.selection();
        if (selected == null) return null;
        Node node = NodeFactory.createURI(name);
        if (!data.contains(before.graph(), node, RDF.type.asNode(), NodeFactory.createURI(selected.type()))) {
            if (agentCompensation(data, receipt, name, before))
                return CanonicalPolicy.validate(profiles, data, name, false);
            return CommandService.invalid("prestate canonical type removed: " + name);
        }
        boolean changed = before.selectors().entrySet().stream().anyMatch(entry ->
            !entry.getValue().equals(values(data, before.graph(), node, NodeFactory.createURI(entry.getKey()))));
        if (changed) {
            if (!routeLifecycle(data, receipt, name, before))
                return CommandService.invalid("prestate canonical selector changed: " + name);
            return null;
        }
        return CanonicalPolicy.validateSelected(profiles, data, name, selected);
    }

    /** A receipted Agent compensation replaces its public identity with a
     * canonical tombstone while retaining the creation receipt. */
    private static boolean agentCompensation(DatasetGraph data, String receipt,
                                             String name, Subject before) {
        if (!before.graph().equals(CURRENT) || before.selection() == null
            || !before.selection().type().equals(RV + "Agent")
            || !receipt.startsWith("urn:rezics:receipt:agent-compensation:")) return false;
        String id = receipt.substring("urn:rezics:receipt:agent-compensation:".length());
        Node agent = NodeFactory.createURI(name);
        Node compensatedFrom = NodeFactory.createURI("urn:rezics:receipt:agent-provision:" + id);
        Node receiptNode = NodeFactory.createURI(receipt);
        return data.contains(CURRENT, agent, RDF.type.asNode(), NodeFactory.createURI(RV + "AgentTombstone"))
            && !data.contains(CURRENT, agent, RDF.type.asNode(), NodeFactory.createURI(RV + "Agent"))
            && data.contains(CURRENT, agent, NodeFactory.createURI(RV + "compensatedFrom"), compensatedFrom)
            && data.contains(RECEIPTS, compensatedFrom, NodeFactory.createURI(RV + "agent"), agent)
            && data.contains(RECEIPTS, receiptNode, RDF.type.asNode(), NodeFactory.createURI(RV + "OperationReceipt"))
            && data.contains(RECEIPTS, receiptNode, NodeFactory.createURI(RV + "outcome"),
                NodeFactory.createURI(RV + "Succeeded"));
    }

    /** Current RouteBinding may advance only with the exact successor revision and receipt. */
    private static boolean routeLifecycle(DatasetGraph data, String receipt, String name, Subject before) {
        if (!before.graph().equals(CURRENT) || before.selection() == null
            || !before.selection().type().equals(RV + "RouteBinding")) return false;
        Node address = NodeFactory.createURI(name);
        Node oldState = NodeFactory.createURI(RV + "routeState");
        Node oldRevision = NodeFactory.createURI(RV + "routeRevision");
        Set<Node> previous = values(data, CURRENT, address, oldRevision);
        // The old revision is captured separately below; the poststate must point to a new one.
        Set<Node> priorRevision = before.selectors().get(RV + "routeRevision");
        if (priorRevision == null || priorRevision.size() != 1
            || !before.selectors().getOrDefault(RV + "routeState", Set.of())
                .equals(Set.of(NodeFactory.createURI(RV + "Current")))
            || previous.size() != 1) return false;
        Node next = previous.iterator().next();
        Node prior = priorRevision.iterator().next();
        if (!next.isURI() || next.equals(prior)) return false;
        Set<Node> states = values(data, CURRENT, address, oldState);
        if (states.size() != 1) return false;
        Node state = states.iterator().next();
        if (!state.equals(NodeFactory.createURI(RV + "Redirected"))
            && !state.equals(NodeFactory.createURI(RV + "Retired"))) return false;
        Node receiptNode = NodeFactory.createURI(receipt);
        return data.contains(REVISIONS, next, NodeFactory.createURI(RV + "component"), address)
            && data.contains(REVISIONS, next, NodeFactory.createURI(RV + "previousRevision"), prior)
            && data.contains(REVISIONS, next, oldState, state)
            && data.contains(RECEIPTS, receiptNode, NodeFactory.createURI(RV + "sourceAddress"), address)
            && data.contains(RECEIPTS, receiptNode, NodeFactory.createURI(RV + "sourceRevision"), next);
    }

    private static boolean typeChanged(DatasetGraph data, String name, Subject before) {
        return !before.types().equals(values(data, before.graph(), NodeFactory.createURI(name), RDF.type.asNode()));
    }

    private static boolean stableStructureType(DatasetGraph data, String name, Subject before) {
        if (before.selection() == null || typeChanged(data, name, before)) return false;
        String type = before.selection().type();
        return type.equals(RV + "Structure") || type.equals(RV + "StructureGeneration");
    }

    private static String dependents(ProfileRegistry profiles, DatasetGraph data, String child,
                                     CommandPolicy.Plan plan, Set<String> current, Set<String> revisions,
                                     int[] inboundQuads, boolean typeChanged, boolean agentTombstone) {
        Node object = NodeFactory.createURI(child);
        for (Node graph : new Node[] { CURRENT, REVISIONS }) {
            var matches = data.find(graph, Node.ANY, Node.ANY, object);
            while (matches.hasNext()) {
                var inbound = matches.next();
                Node parent = inbound.getSubject();
                if (++inboundQuads[0] > MAX_INBOUND_QUADS)
                    return "reverse dependency inbound footprint exceeds " + MAX_INBOUND_QUADS;
                if (!parent.isURI()) continue;
                String name = parent.getURI();
                if (graph.equals(CURRENT)) {
                    if (!plan.current().contains(name)) current.add(name);
                } else if (!plan.revisions().contains(name)) {
                    // Untyped/generic historical revisions have no registry-selected shape.
                    // Their dependency on a changed child type cannot be certified here.
                    boolean historicalAgentAnchor = agentTombstone
                        && inbound.getPredicate().equals(NodeFactory.createURI(RV + "component"))
                        && data.contains(REVISIONS, parent, RDF.type.asNode(),
                            NodeFactory.createURI(RV + "RevisionAnchor"));
                    boolean historicalWorkAnchor = typeChanged
                        && inbound.getPredicate().equals(NodeFactory.createURI(RV + "component"))
                        && data.contains(CURRENT, object, RDF.type.asNode(),
                            NodeFactory.createURI("https://schema.org/CreativeWork"))
                        && data.contains(REVISIONS, parent, RDF.type.asNode(),
                            NodeFactory.createURI(RV + "RevisionAnchor"))
                        && data.contains(REVISIONS, parent, NodeFactory.createURI(RV + "modelRevision"),
                            NodeFactory.createURI("https://rezics.com/definition/work-metadata-v1"))
                        && data.contains(REVISIONS, parent, NodeFactory.createURI(RV + "shapeRevision"),
                            NodeFactory.createURI("https://rezics.com/definition/work-metadata-v1"))
                        && profiles.get("work-type-v1") != null
                        && CommandService.validateOne(data, new CommandService.Validation(
                            "work-type-v1", profiles.get("work-type-v1"),
                            "https://rezics.com/definition/work-type-v1/work-revision-shape",
                            List.of(name), List.of(CommandPolicy.CURRENT, CommandPolicy.REVISIONS), Map.of())) == null;
                    if (typeChanged && !historicalAgentAnchor && !historicalWorkAnchor
                        && CanonicalPolicy.select(profiles, data, name, true) == null)
                        return "uncanonical reverse revision dependency requires staged lifecycle: " + name;
                    revisions.add(name);
                }
                if (current.size() + revisions.size() > MAX_REVERSE_DEPENDENTS)
                    return "reverse dependency footprint exceeds " + MAX_REVERSE_DEPENDENTS;
            }
        }
        return null;
    }

    private static Set<Node> values(DatasetGraph data, Node graph, Node subject, Node predicate) {
        Set<Node> result = new HashSet<>();
        data.find(graph, subject, predicate, Node.ANY).forEachRemaining(quad -> result.add(quad.getObject()));
        return Set.copyOf(result);
    }

    private ModelMutationPolicy() {}
}
