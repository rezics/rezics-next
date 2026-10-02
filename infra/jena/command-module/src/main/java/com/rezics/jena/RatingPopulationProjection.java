package com.rezics.jena;

import java.math.BigInteger;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** One receipt-backed contribution per current observation, changed atomically
 * with its native head. Reads sum context counters, never traverse rating slots.
 * The online names migration also replays legacy observation identities. */
final class RatingPopulationProjection {
    static final String GRAPH = "urn:rezics:graph:rating-population-counts";
    private static final String RV = "https://rezics.com/vocab/";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node p(String value) { return uri(RV + value); }
    private static final Node COUNTS = uri(GRAPH), CURRENT = uri(CommandPolicy.CURRENT),
        REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS),
        STATE = uri("urn:rezics:rating-population-counts:v1");
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try { return rows.hasNext() ? rows.next().getObject() : null; }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static boolean proven(DatasetGraph data, Node head, String predicate) {
        if (head == null) return false;
        var rows = data.find(RECEIPTS, Node.ANY, p(predicate), head);
        try { while (rows.hasNext()) {
            if (data.contains(RECEIPTS, rows.next().getSubject(), p("outcome"), p("Succeeded"))) return true;
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        return false;
    }
    static void refresh(DatasetGraph data, CommandPolicy.Plan plan, String receipt, List<CommandService.Validation> validations) {
        Set<Node> touched = new LinkedHashSet<>();
        for (String id : plan.current()) touched.add(uri(id));
        for (var validation : validations) for (String id : validation.focus()) touched.add(uri(id));
        for (String id : plan.revisions()) {
            Node component = one(data, REVISIONS, uri(id), p("component"));
            if (component != null) touched.add(component);
        }
        var replay = data.find(RECEIPTS, uri(receipt), p("nameResource"), Node.ANY);
        try { while (replay.hasNext()) touched.add(replay.next().getObject()); }
        finally { org.apache.jena.atlas.iterator.Iter.close(replay); }
        for (Node observation : touched) refresh(data, observation);
        if (plan.bootstrap() || data.contains(RECEIPTS, uri(receipt), p("nameBackfillComplete"),
            NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean))) {
            data.deleteAny(COUNTS, STATE, p("complete"), Node.ANY);
            data.add(COUNTS, STATE, p("complete"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean));
        }
    }
    static void refresh(DatasetGraph data, Node observation) {
        Node previous = one(data, COUNTS, observation, p("countedPopulation"));
        Node head = one(data, CURRENT, observation, p("observationHead"));
        Node context = one(data, CURRENT, observation, p("ratingContext"));
        Node target = one(data, CURRENT, observation, p("targetRelease"));
        if (target == null) target = one(data, CURRENT, observation, p("target"));
        if (target == null) target = one(data, CURRENT, observation, p("targetMainVersion"));
        boolean available = head != null && context != null && target != null
            && one(data, CURRENT, observation, p("ratingSlot")) != null
            && data.contains(REVISIONS, head, p("component"), observation)
            && data.contains(REVISIONS, head, p("ratingAvailability"), p("Available"))
            && data.contains(REVISIONS, head, p("ratingValue"), Node.ANY)
            && !data.contains(REVISIONS, head, RDF.type.asNode(), p("ErasedRevision"))
            && proven(data, head, "observationRevision");
        Node next = available ? counter(context, target) : null;
        if (java.util.Objects.equals(previous, next)) return;
        if (previous != null) bump(data, previous, null, null, -1);
        data.deleteAny(COUNTS, observation, p("countedPopulation"), Node.ANY);
        if (next != null) {
            bump(data, next, context, target, 1);
            data.add(COUNTS, observation, p("countedPopulation"), next);
        }
    }
    private static Node counter(Node context, Node target) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(
                (context.getURI() + "\n" + target.getURI()).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return uri("urn:rezics:rating-population-count:" + java.util.HexFormat.of().formatHex(digest));
        } catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static void bump(DatasetGraph data, Node counter, Node context, Node target, int delta) {
        Node old = one(data, COUNTS, counter, p("availableRatingCount"));
        BigInteger value = (old == null ? BigInteger.ZERO : new BigInteger(old.getLiteralLexicalForm()))
            .add(BigInteger.valueOf(delta));
        if (value.signum() < 0) throw new IllegalStateException("rating population counter underflow");
        data.deleteAny(COUNTS, counter, p("availableRatingCount"), Node.ANY);
        data.add(COUNTS, counter, p("availableRatingCount"), NodeFactory.createLiteralByValue(value,
            org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger));
        if (context != null) {
            data.add(COUNTS, counter, p("populationContext"), context);
            data.add(COUNTS, counter, p("populationTarget"), target);
        }
    }
}
