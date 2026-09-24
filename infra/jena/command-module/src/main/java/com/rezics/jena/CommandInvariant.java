package com.rezics.jena;

import java.math.BigInteger;
import java.util.HashSet;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.Triple;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.syntax.Element;
import org.apache.jena.sparql.syntax.ElementGroup;
import org.apache.jena.sparql.syntax.ElementNamedGraph;
import org.apache.jena.sparql.syntax.ElementPathBlock;
import org.apache.jena.sparql.syntax.ElementTriplesBlock;
import org.apache.jena.vocabulary.RDF;

/** Checks the committed envelope against the control state in the same TDB2 transaction. */
final class CommandInvariant {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String XSD_INTEGER = "http://www.w3.org/2001/XMLSchema#integer";
    private static final Node PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node CONTROL = uri(CommandPolicy.CONTROL);
    private static final Node RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node OUTBOX = uri(CommandPolicy.OUTBOX);
    private static final Node PUBLIC_SEARCH = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node PUBLIC_ANCHOR = uri(CommandPolicy.PUBLIC_ANCHOR);

    record Control(Node epoch, Node routing, BigInteger sequence, Node marker, boolean held,
        Node priorEpoch, BigInteger priorSequence, BigInteger cursor, Node textGeneration) {}

    static String preflight(DatasetGraph data, String receipt, CommandPolicy.Plan plan) {
        if (data.contains(RECEIPTS, uri(receipt), Node.ANY, Node.ANY)) return "receipt already has triples";
        if (plan.bootstrap()) {
            if (plan.hasDelete() || data.find().hasNext()) return "bootstrap requires an empty dataset and insert-only update";
            return null;
        }
        Control control = readControl(data);
        if (control == null) return "product control record is missing or ambiguous";
        if (plan.rebuild()) {
            if (control.held()) return "rebuild cannot run during a graph restore hold";
            boolean open = data.contains(PUBLIC_SEARCH, PUBLIC_ANCHOR, RDF.type.asNode(), rv("SearchGraphAnchor"));
            if (receipt.startsWith("urn:rezics:receipt:content-rebuild:quarantine:") != open)
                return "rebuild quarantine state differs";
        }
        return null;
    }

    static Control readControl(DatasetGraph data) {
        Node epoch = one(data, CONTROL, PRODUCT, rv("dataEpoch"));
        Node routing = one(data, CONTROL, PRODUCT, rv("routingEpoch"));
        BigInteger sequence = number(one(data, CONTROL, PRODUCT, rv("sequence")));
        Node marker = one(data, CONTROL, PRODUCT, rv("restoreCutover"));
        if (epoch == null || !epoch.isLiteral() || routing == null || !routing.isLiteral()
            || sequence == null || sequence.signum() < 0) return null;
        return new Control(epoch, routing, sequence, marker,
            data.contains(CONTROL, PRODUCT, rv("restoreHold"), NodeFactory.createLiteralByValue(true,
                org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean)),
            marker == null ? null : one(data, CONTROL, marker, rv("priorDataEpoch")),
            marker == null ? null : number(one(data, CONTROL, marker, rv("priorSequence"))),
            marker == null ? null : number(one(data, CONTROL, marker, rv("reconciledPriorSequence"))),
            one(data, CONTROL, PRODUCT, rv("textIndexGeneration")));
    }

    static String check(DatasetGraph data, String receipt, String digest, CommandPolicy.Plan plan, Control before) {
        Node own = uri(receipt);
        Node rd = one(data, RECEIPTS, own, rv("requestDigest"));
        Node dataset = one(data, RECEIPTS, own, rv("datasetId"));
        Node epoch = one(data, RECEIPTS, own, rv("dataEpoch"));
        BigInteger sequence = number(one(data, RECEIPTS, own, rv("sequence")));
        if (!data.contains(RECEIPTS, own, RDF.type.asNode(), rv("OperationReceipt"))
            || count(data, RECEIPTS, own, RDF.type.asNode()) != 1
            || rd == null || !rd.isLiteral() || !digest.equals(rd.getLiteralLexicalForm())
            || !PRODUCT.equals(dataset) || epoch == null || !epoch.isLiteral()
            || sequence == null || sequence.signum() < 0)
            return "receipt type, digest, dataset, epoch or sequence is invalid";
        Control after = readControl(data);
        if (after == null) return "product control record is missing or ambiguous";
        if (plan.bootstrap()) {
            if (before != null || after.sequence().signum() != 0 || !epoch.equals(after.epoch())
                || plan.graphs().contains(CommandPolicy.OUTBOX)) return "invalid bootstrap position";
            return null;
        }
        if (before == null) return "product control record was absent";
        boolean activation = receipt.startsWith("urn:rezics:receipt:content-rebuild:activate:");
        if (plan.rebuild() && data.contains(PUBLIC_SEARCH, PUBLIC_ANCHOR,
            RDF.type.asNode(), rv("SearchGraphAnchor")) != activation)
            return "rebuild public search anchor differs";
        if (receipt.startsWith("urn:rezics:receipt:restore-cutover:")) {
            if (!plan.graphs().stream().allMatch(g -> g.equals(CommandPolicy.CONTROL)
                    || g.equals(CommandPolicy.RECEIPTS)) || !hasControlGuards(plan, before)
                || !cutoverWritesOnlyLineage(plan, after.marker()) || before.held() || !after.held()
                || before.epoch().equals(after.epoch()) || !routingIncreases(before.routing(), after.routing())
                || after.marker() == null || !before.epoch().equals(after.priorEpoch())
                || !before.sequence().equals(after.priorSequence())
                || after.sequence().signum() != 0 || !epoch.equals(after.epoch())
                || sequence.signum() != 0) return "invalid restore cutover";
            return null;
        }
        if (receipt.startsWith("urn:rezics:receipt:restore-release:")) {
            if (!plan.graphs().stream().allMatch(g -> g.equals(CommandPolicy.CONTROL)
                    || g.equals(CommandPolicy.RECEIPTS)) || !hasControlGuards(plan, before)
                || !releaseDeletesOnlyHold(plan) || !before.held() || after.held()
                || !before.epoch().equals(after.epoch()) || !before.routing().equals(after.routing())
                || !java.util.Objects.equals(before.marker(), after.marker())
                || after.sequence().signum() != 0 || before.sequence().signum() != 0
                || !epoch.equals(after.epoch()) || sequence.signum() != 0)
                return "invalid restore release";
            return null;
        }
        if (!hasControlGuards(plan, before)) return "data epoch, routing epoch and sequence guards required";
        if (before.held()) {
            Node marker = before.marker();
            if (marker == null || !marker.equals(after.marker()) || !after.held()
                || !before.epoch().equals(after.epoch()) || !before.routing().equals(after.routing())
                || !before.sequence().equals(after.sequence()) || before.sequence().signum() != 0)
                return "invalid held recovery control";
            BigInteger previous = before.cursor() == null ? before.priorSequence() : before.cursor();
            if (before.priorEpoch() == null || before.priorSequence() == null || previous == null
                || !before.priorEpoch().equals(after.priorEpoch())
                || !before.priorSequence().equals(after.priorSequence())
                || !epoch.equals(before.priorEpoch())
                || after.cursor() == null || !after.cursor().equals(sequence)
                || !sequence.equals(previous.add(BigInteger.ONE))
                || !hasRecoveryCursorWrite(plan, marker))
                return "invalid held recovery cursor";
        } else {
            if (after.held() || !before.epoch().equals(after.epoch())
                || !before.routing().equals(after.routing())
                || !after.sequence().equals(before.sequence().add(BigInteger.ONE))
                || !epoch.equals(after.epoch()) || !sequence.equals(after.sequence())
                || !(activation ? controlWritesOnlySequenceAndGeneration(plan)
                    && before.textGeneration() != null && after.textGeneration() != null
                    && !before.textGeneration().equals(after.textGeneration())
                    : controlWritesOnlySequence(plan)
                    && (!plan.rebuild() || java.util.Objects.equals(before.textGeneration(), after.textGeneration()))))
                return "invalid sequence advance";
        }
        Node outcome = one(data, RECEIPTS, own, rv("outcome"));
        if (!(before.held() && receipt.startsWith("urn:rezics:receipt:retained-zero:"))
            && (outcome == null || !outcome.isURI()
                || !(outcome.equals(rv("Succeeded")) || outcome.equals(rv("Cancelled")))))
            return "normal receipt outcome is invalid";
        if (activation) {
            Node sourceEpoch = one(data, RECEIPTS, own, rv("ownerDataEpoch"));
            BigInteger sourceSequence = number(one(data, RECEIPTS, own, rv("ownerSequence")));
            Node priorGeneration = one(data, RECEIPTS, own, rv("priorIndexGeneration"));
            Node nextGeneration = one(data, RECEIPTS, own, rv("textIndexGeneration"));
            Node indexDigest = one(data, RECEIPTS, own, rv("indexRebuildDigest"));
            if (sourceEpoch == null || !sourceEpoch.isLiteral()
                || !sourceEpoch.getLiteralLexicalForm().matches("[0-9a-fA-F-]{36}")
                || sourceSequence == null || sourceSequence.signum() < 0
                || !java.util.Objects.equals(priorGeneration, before.textGeneration())
                || !java.util.Objects.equals(nextGeneration, after.textGeneration())
                || indexDigest == null || !indexDigest.isLiteral()
                || !indexDigest.getLiteralLexicalForm().matches("[0-9a-f]{64}"))
                return "activation receipt lacks exact source and offline-index evidence";
        }
        return checkOutbox(data, receipt, plan, epoch, sequence);
    }

    private static String checkOutbox(DatasetGraph data, String receipt, CommandPolicy.Plan plan,
                                      Node epoch, BigInteger sequence) {
        if (!plan.graphs().contains(CommandPolicy.OUTBOX)) return "outbox batch required";
        Set<Node> batches = new HashSet<>();
        var iter = data.find(OUTBOX, Node.ANY, rv("sequence"), Node.ANY);
        while (iter.hasNext()) {
            Quad quad = iter.next();
            if (sequence.equals(number(quad.getObject()))
                && data.contains(OUTBOX, quad.getSubject(), rv("dataEpoch"), epoch))
                batches.add(quad.getSubject());
        }
        if (batches.size() != 1) return "exactly one outbox batch required at receipt position";
        Node batch = batches.iterator().next();
        BigInteger count = number(one(data, OUTBOX, batch, rv("eventCount")));
        if (!data.contains(OUTBOX, batch, RDF.type.asNode(), rv("OutboxBatch"))
            || count(data, OUTBOX, batch, RDF.type.asNode()) != 1
            || count(data, OUTBOX, batch, rv("dataEpoch")) != 1
            || count(data, OUTBOX, batch, rv("sequence")) != 1
            || count == null || count.signum() < 0
            || !count.equals(BigInteger.valueOf(count(data, OUTBOX, batch, rv("event")))))
            return "outbox batch shape or event count is invalid";
        if ((!plan.current().isEmpty() || !plan.revisions().isEmpty()
            || plan.graphs().contains(CommandPolicy.PUBLIC_SEARCH)) && count.signum() == 0)
            return "product change requires an outbox event";
        Set<BigInteger> ordinals = new HashSet<>();
        var events = data.find(OUTBOX, batch, rv("event"), Node.ANY);
        while (events.hasNext()) {
            Node event = events.next().getObject();
            BigInteger ordinal = number(one(data, OUTBOX, event, rv("ordinal")));
            if (!event.isURI() || !data.contains(OUTBOX, event, rv("receipt"), uri(receipt))
                || count(data, OUTBOX, event, rv("receipt")) != 1
                || count(data, OUTBOX, event, RDF.type.asNode()) != 1
                || ordinal == null || ordinal.signum() < 0 || ordinal.compareTo(count) >= 0
                || !ordinals.add(ordinal)) return "outbox event receipt or ordinal is invalid";
        }
        // The update may not introduce a second batch at a different position.
        if (plan.request().getOperations().getFirst() instanceof UpdateModify modify) {
            for (Quad quad : modify.getInsertQuads()) {
                if (OUTBOX.equals(quad.getGraph()) && rv("sequence").equals(quad.getPredicate())
                    && !batch.equals(quad.getSubject())) return "extra outbox batch inserted";
            }
            for (Quad quad : modify.getDeleteQuads()) {
                if (OUTBOX.equals(quad.getGraph())) return "outbox deletion not admitted";
            }
        }
        return null;
    }

    private static boolean controlWritesOnlySequence(CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        for (Quad quad : modify.getInsertQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !rv("sequence").equals(quad.getPredicate()))) return false;
        for (Quad quad : modify.getDeleteQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !rv("sequence").equals(quad.getPredicate()))) return false;
        return true;
    }

    private static boolean controlWritesOnlySequenceAndGeneration(CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        Set<Node> fields = Set.of(rv("sequence"), rv("textIndexGeneration"));
        for (Quad quad : modify.getInsertQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !fields.contains(quad.getPredicate()))) return false;
        for (Quad quad : modify.getDeleteQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !fields.contains(quad.getPredicate()))) return false;
        return true;
    }

    private static boolean cutoverWritesOnlyLineage(CommandPolicy.Plan plan, Node marker) {
        if (marker == null || !(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        Set<Node> productFields = Set.of(rv("dataEpoch"), rv("routingEpoch"), rv("sequence"),
            rv("restoreCutover"), rv("restoreHold"));
        Set<Node> markerFields = Set.of(RDF.type.asNode(), rv("priorDataEpoch"),
            rv("priorSequence"), rv("dataEpoch"));
        for (Quad quad : modify.getInsertQuads()) if (CONTROL.equals(quad.getGraph())
            && !(PRODUCT.equals(quad.getSubject()) && productFields.contains(quad.getPredicate())
                || marker.equals(quad.getSubject()) && markerFields.contains(quad.getPredicate()))) return false;
        for (Quad quad : modify.getDeleteQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !Set.of(rv("dataEpoch"), rv("routingEpoch"),
                rv("sequence")).contains(quad.getPredicate()))) return false;
        return true;
    }

    private static boolean releaseDeletesOnlyHold(CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        for (Quad quad : modify.getInsertQuads()) if (CONTROL.equals(quad.getGraph())) return false;
        for (Quad quad : modify.getDeleteQuads()) if (CONTROL.equals(quad.getGraph())
            && (!PRODUCT.equals(quad.getSubject()) || !rv("restoreHold").equals(quad.getPredicate()))) return false;
        return true;
    }

    private static boolean hasRecoveryCursorWrite(CommandPolicy.Plan plan, Node marker) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        boolean inserted = false;
        for (Quad quad : modify.getInsertQuads()) if (CONTROL.equals(quad.getGraph())) {
            if (!marker.equals(quad.getSubject()) || !rv("reconciledPriorSequence").equals(quad.getPredicate())) return false;
            inserted = true;
        }
        for (Quad quad : modify.getDeleteQuads()) if (CONTROL.equals(quad.getGraph())
            && (!marker.equals(quad.getSubject()) || !rv("reconciledPriorSequence").equals(quad.getPredicate()))) return false;
        return inserted;
    }

    private static boolean hasControlGuards(CommandPolicy.Plan plan, Control before) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return false;
        Set<Node> guards = new HashSet<>();
        collectGuards(modify.getWherePattern(), false, before, guards);
        return guards.contains(rv("dataEpoch")) && guards.contains(rv("routingEpoch"))
            && guards.contains(rv("sequence"));
    }
    private static void collectGuards(Element element, boolean inControl, Control before, Set<Node> guards) {
        if (element instanceof ElementGroup group) {
            for (Element child : group.getElements()) collectGuards(child, inControl, before, guards);
        } else if (element instanceof ElementNamedGraph named && CONTROL.equals(named.getGraphNameNode())) {
            collectGuards(named.getElement(), true, before, guards);
        } else if (inControl && element instanceof ElementPathBlock block) {
            block.patternElts().forEachRemaining(path -> { if (path.isTriple()) guard(path.asTriple(), before, guards); });
        } else if (inControl && element instanceof ElementTriplesBlock block) {
            block.patternElts().forEachRemaining(triple -> guard(triple, before, guards));
        }
    }
    private static void guard(Triple triple, Control before, Set<Node> guards) {
        if (!PRODUCT.equals(triple.getSubject())) return;
        Node predicate = triple.getPredicate(), value = triple.getObject();
        if (rv("dataEpoch").equals(predicate) && before.epoch().equals(value)) guards.add(predicate);
        if (rv("routingEpoch").equals(predicate) && before.routing().equals(value)) guards.add(predicate);
        if (rv("sequence").equals(predicate)
            && (value.isVariable() || before.sequence().equals(number(value)))) guards.add(predicate);
    }

    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
        if (!values.hasNext()) return null;
        Node value = values.next().getObject();
        return values.hasNext() ? null : value;
    }
    private static int count(DatasetGraph data, Node graph, Node subject, Node predicate) {
        int count = 0;
        var values = data.find(graph, subject, predicate, Node.ANY);
        while (values.hasNext()) { values.next(); count++; }
        return count;
    }
    private static BigInteger number(Node node) {
        if (node == null || !node.isLiteral() || !XSD_INTEGER.equals(node.getLiteralDatatypeURI())) return null;
        try { return new BigInteger(node.getLiteralLexicalForm()); }
        catch (NumberFormatException ex) { return null; }
    }
    private static boolean routingIncreases(Node before, Node after) {
        try {
            BigInteger old = new BigInteger(before.getLiteralLexicalForm());
            BigInteger next = new BigInteger(after.getLiteralLexicalForm());
            return old.signum() >= 0 && next.compareTo(old) > 0;
        } catch (NumberFormatException ex) { return false; }
    }
    private static Node rv(String name) { return uri(RV + name); }
    private static Node uri(String name) { return NodeFactory.createURI(name); }
    private CommandInvariant() {}
}
