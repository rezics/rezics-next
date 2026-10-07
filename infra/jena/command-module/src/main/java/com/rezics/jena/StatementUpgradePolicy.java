package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
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

/** Offline representation conversion, never a new graph position or a restore cutover. */
final class StatementUpgradePolicy {
    private static final String PREFIX = "urn:rezics:name-migration:statement-upgrade:";
    private static final String RV = "https://rezics.com/vocab/";
    private static final String STATEMENT = "https://rezics.com/definition/statement-v1";
    private static final String DECISION = "https://rezics.com/definition/statement-decision-v1";
    private static final String CLASSIFICATION = "https://rezics.com/definition/classification-direct-decision-v1";
    private static final String PROPOSITION = "https://rezics.com/definition/classification-proposition-v1";
    private static final Node PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node TRUE = NodeFactory.createLiteralByValue(true,
        org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean);
    private static final Set<Node> ENVELOPE = fields("commandFamily", "requestDigest", "datasetId",
        "dataEpoch", "sequence", "outcome", "statementUpgrade");
    private static final Set<Node> CONVERSION = fields("convertedApplication", "convertedDecision", "statement",
        "statementRevision", "decisionSlot", "statementDecision");
    private static final Set<Node> RETIRED = fields("commandFamily", "outcome", "reason", "requestDigest",
        "admissionId", "authorityEpoch", "admittedScope", "datasetId", "dataEpoch", "sequence");

    record Key(Node graph, Node subject) {}
    record Snapshot(Map<Key, Set<Quad>> expected, String error) {}

    static boolean applies(String receipt) { return receipt.startsWith(PREFIX); }
    static boolean retiringReceipt(String receipt) { return receipt.matches(PREFIX + "retire:[0-9a-f]{64}"); }
    static String templateDigest(String update) { return hash(update); }
    static Node templateDigestPredicate() { return rv("statementUpgradeTemplateDigest"); }

    private static String phase(String receipt) {
        if (!receipt.matches(PREFIX + "(acquire|complete|release|retire|convert):[0-9a-f]{64}"))
            throw new IllegalArgumentException("unknown Statement upgrade phase");
        return receipt.substring(PREFIX.length(), receipt.lastIndexOf(':'));
    }

    /** Every caller-written value is concrete except the unchanged guarded sequence. */
    static void validateTemplate(CommandPolicy.Plan plan, String receipt) {
        String phase = phase(receipt);
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify))
            throw new IllegalArgumentException("Statement upgrade requires a guarded update");
        Node own = uri(receipt), marker = required(modify, RECEIPTS, own, rv("statementUpgrade"));
        Node epoch = required(modify, RECEIPTS, own, rv("dataEpoch"));
        Node sequence = required(modify, RECEIPTS, own, rv("sequence"));
        if (!epoch.isLiteral() || !sequence.isVariable()
            || !marker.equals(uri("urn:rezics:maintenance:statement-upgrade:" + hash(epoch.getLiteralLexicalForm())))
            || !required(modify, RECEIPTS, own, RDF.type.asNode()).equals(rv("OperationReceipt"))
            || !required(modify, RECEIPTS, own, rv("requestDigest")).equals(text(receipt.substring(receipt.lastIndexOf(':') + 1)))
            || !required(modify, RECEIPTS, own, rv("commandFamily")).equals(text("statement-upgrade-" + phase + "-v1"))
            || !required(modify, RECEIPTS, own, rv("datasetId")).equals(PRODUCT)
            || !required(modify, RECEIPTS, own, rv("outcome")).equals(rv("Succeeded")))
            throw new IllegalArgumentException("Statement upgrade envelope differs");
        Set<Node> ownFields = new HashSet<>(ENVELOPE);
        ownFields.add(RDF.type.asNode());
        Node retired = null;
        if (phase.equals("retire")) {
            ownFields.add(rv("retiredReceipt"));
            retired = required(modify, RECEIPTS, own, rv("retiredReceipt"));
            if (!retired.isURI() || !retired.getURI().matches("urn:rezics:receipt:[0-9a-f]{64}"))
                throw new IllegalArgumentException("retired receipt identity differs");
            validateRetired(modify, retired, epoch, sequence);
        }
        if (phase.equals("convert")) {
            ownFields.addAll(CONVERSION);
            for (Node field : CONVERSION) if (!required(modify, RECEIPTS, own, field).isURI())
                throw new IllegalArgumentException("Statement conversion identities must be concrete");
        }
        Set<Quad> controlInsert = switch (phase) {
            case "acquire" -> Set.of(new Quad(CONTROL, PRODUCT, rv("restoreHold"), TRUE),
                new Quad(CONTROL, marker, rv("statementUpgradeFence"), TRUE));
            case "complete" -> Set.of(new Quad(CONTROL, marker, rv("outcome"), rv("Succeeded")));
            default -> Set.of();
        };
        Set<Quad> controlDelete = phase.equals("release") ? Set.of(
            new Quad(CONTROL, PRODUCT, rv("restoreHold"), TRUE),
            new Quad(CONTROL, marker, rv("statementUpgradeFence"), TRUE)) : Set.of();
        if (!quads(modify.getInsertQuads(), CONTROL).equals(controlInsert)
            || !quads(modify.getDeleteQuads(), CONTROL).equals(controlDelete))
            throw new IllegalArgumentException("Statement upgrade control footprint differs");
        for (Quad quad : modify.getInsertQuads()) {
            if (!quad.getPredicate().isURI() || !(quad.getObject().isURI() || quad.getObject().isLiteral()
                || quad.getGraph().equals(RECEIPTS) && quad.getPredicate().equals(rv("sequence"))
                    && quad.getObject().equals(sequence)))
                throw new IllegalArgumentException("Statement upgrade values must be concrete");
            if (quad.getGraph().equals(RECEIPTS)) {
                if (quad.getSubject().equals(own)) {
                    if (!ownFields.contains(quad.getPredicate()))
                        throw new IllegalArgumentException("Statement upgrade receipt footprint differs");
                } else if (retired == null || !quad.getSubject().equals(retired))
                    throw new IllegalArgumentException("Statement upgrade may write only its phase receipts");
            } else if (!quad.getGraph().equals(CONTROL) && (!phase.equals("convert")
                || !Set.of(CURRENT, REVISIONS).contains(quad.getGraph())))
                throw new IllegalArgumentException("Statement upgrade graph footprint differs");
        }
        for (Quad quad : modify.getDeleteQuads()) if (!quad.getGraph().equals(CONTROL)
            && (!phase.equals("convert") || !quad.getGraph().equals(CURRENT)
                || !quad.getSubject().equals(required(modify, RECEIPTS, own, rv("decisionSlot")))
                || !quad.getPredicate().equals(rv("decisionHead")) || !quad.getObject().isURI()))
            throw new IllegalArgumentException("Statement conversion deletes only its exact prior slot head");
        Set<Quad> unique = new HashSet<>(modify.getInsertQuads());
        if (unique.size() != modify.getInsertQuads().size() || modify.getDeleteQuads().size() > 2)
            throw new IllegalArgumentException("Statement upgrade footprint is ambiguous");
        // Positive guards cannot be hidden in OPTIONAL, UNION, subqueries or filters.
        if (!positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("dataEpoch"), epoch)
            || !positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("sequence"), sequence))
            throw new IllegalArgumentException("Statement upgrade lineage guards required");
        if (phase.equals("convert") || phase.equals("complete") || phase.equals("release")) {
            if (!positive(modify.getWherePattern(), CONTROL, PRODUCT, rv("restoreHold"), TRUE)
                || !positive(modify.getWherePattern(), CONTROL, marker, rv("statementUpgradeFence"), TRUE))
                throw new IllegalArgumentException("Statement upgrade owned fence guard required");
        }
        if (phase.equals("release") && !positive(modify.getWherePattern(), CONTROL, marker, rv("outcome"), rv("Succeeded")))
            throw new IllegalArgumentException("Statement upgrade completion guard required");
    }

    private static void validateRetired(UpdateModify modify, Node retired, Node epoch, Node sequence) {
        String family = lexical(required(modify, RECEIPTS, retired, rv("commandFamily")));
        String admission = lexical(required(modify, RECEIPTS, retired, rv("admissionId")));
        if (!Set.of("statement-migrate-v1", "statement-cutover-v1").contains(family)
            || !admission.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
            || !retired.equals(uri("urn:rezics:receipt:" + hash(admission + '\0' + family)))
            || !required(modify, RECEIPTS, retired, RDF.type.asNode()).equals(rv("OperationReceipt"))
            || !required(modify, RECEIPTS, retired, rv("outcome")).equals(rv("Cancelled"))
            || !required(modify, RECEIPTS, retired, rv("reason")).equals(rv("Unavailable"))
            || !required(modify, RECEIPTS, retired, rv("datasetId")).equals(PRODUCT)
            || !required(modify, RECEIPTS, retired, rv("dataEpoch")).equals(epoch)
            || !required(modify, RECEIPTS, retired, rv("sequence")).equals(sequence)
            || !lexical(required(modify, RECEIPTS, retired, rv("requestDigest"))).matches("[0-9a-f]{64}")
            || !lexical(required(modify, RECEIPTS, retired, rv("authorityEpoch"))).matches("[0-9]+")
            || lexical(required(modify, RECEIPTS, retired, rv("admittedScope"))).isEmpty())
            throw new IllegalArgumentException("retired Statement cancellation differs");
        Set<Node> fields = new HashSet<>(RETIRED);
        fields.add(RDF.type.asNode());
        for (Quad quad : modify.getInsertQuads()) if (quad.getGraph().equals(RECEIPTS)
            && quad.getSubject().equals(retired) && !fields.contains(quad.getPredicate()))
            throw new IllegalArgumentException("retired Statement receipt footprint differs");
    }

    static Snapshot capture(DatasetGraph data, String receipt, String digest, CommandPolicy.Plan plan) {
        try {
            if (!receipt.endsWith(':' + digest)) return new Snapshot(Map.of(), "Statement upgrade digest differs");
            var modify = (UpdateModify) plan.request().getOperations().getFirst();
            var before = CommandInvariant.readControl(data);
            if (before == null || !CommandInvariant.hasControlGuards(plan, before))
                return new Snapshot(Map.of(), "Statement upgrade epoch, routing and sequence guards differ");
            Node own = uri(receipt), marker = required(modify, RECEIPTS, own, rv("statementUpgrade"));
            String phase = phase(receipt);
            boolean fenced = data.contains(CONTROL, marker, rv("statementUpgradeFence"), TRUE);
            if (phase.equals("acquire") || phase.equals("retire")) {
                if (before.held() || fenced || data.contains(CONTROL, marker, rv("outcome"), Node.ANY))
                    return new Snapshot(Map.of(), "Statement upgrade cannot acquire an unrelated or completed fence");
            } else if (!before.held() || !fenced
                || phase.equals("release") && !data.contains(CONTROL, marker, rv("outcome"), rv("Succeeded"))
                || phase.equals("convert") && data.contains(CONTROL, marker, rv("outcome"), Node.ANY))
                return new Snapshot(Map.of(), "Statement upgrade owned fence is unavailable");
            if (phase.equals("retire")) {
                Node retired = required(modify, RECEIPTS, own, rv("retiredReceipt"));
                if (data.contains(RECEIPTS, retired, Node.ANY, Node.ANY))
                    return new Snapshot(Map.of(), "retired Statement receipt already exists");
            }
            if (!phase.equals("convert")) return new Snapshot(Map.of(), null);
            return conversion(data, modify, own);
        } catch (IllegalArgumentException ex) { return new Snapshot(Map.of(), ex.getMessage()); }
    }

    private static Snapshot conversion(DatasetGraph data, UpdateModify modify, Node own) {
        Node app = required(modify, RECEIPTS, own, rv("convertedApplication"));
        Node source = required(modify, RECEIPTS, own, rv("convertedDecision"));
        Node statement = required(modify, RECEIPTS, own, rv("statement"));
        Node revision = required(modify, RECEIPTS, own, rv("statementRevision"));
        Node slot = required(modify, RECEIPTS, own, rv("decisionSlot"));
        Node decision = required(modify, RECEIPTS, own, rv("statementDecision"));
        Node main = one(data, CURRENT, app, rv("targetMainVersion"));
        Node sense = one(data, CURRENT, app, rv("sense"));
        Node context = one(data, CURRENT, app, rv("classificationContext"));
        Node proposer = one(data, CURRENT, app, rv("proposer"));
        Node outcome = one(data, REVISIONS, source, rv("outcome"));
        Node actor = one(data, REVISIONS, source, rv("decidedBy"));
        Node operation = one(data, REVISIONS, source, rv("operation"));
        Node epoch = one(data, REVISIONS, source, rv("dataEpoch"));
        Node sequence = one(data, REVISIONS, source, rv("sequence"));
        if (!data.contains(CURRENT, app, RDF.type.asNode(), rv("ClassificationApplication"))
            || !data.contains(CURRENT, app, rv("applicationChannel"), rv("Curated"))
            || !data.contains(CURRENT, app, rv("applicationState"), rv("Active"))
            || !source.equals(one(data, CURRENT, app, rv("decisionHead")))
            || !positive(modify.getWherePattern(), CURRENT, app, rv("decisionHead"), source)
            || !data.contains(REVISIONS, source, RDF.type.asNode(), rv("ClassificationDecision"))
            || !app.equals(one(data, REVISIONS, source, rv("component")))
            || !app.equals(one(data, REVISIONS, source, rv("application")))
            || !uri(CLASSIFICATION).equals(one(data, REVISIONS, source, rv("modelRevision")))
            || !uri(CLASSIFICATION).equals(one(data, REVISIONS, source, rv("decisionPolicy")))
            || !nativeId(app) || !nativeId(source) || !nativeId(main) || !nativeId(sense)
            || !(context != null && context.equals(uri("urn:rezics:classification-context:global")) || nativeId(context))
            || !nativeId(proposer) || !nativeId(actor) || !nativeId(operation) || epoch == null || !epoch.isLiteral()
            || number(sequence) == null || number(sequence).signum() < 1
            || outcome == null || !Set.of(rv("Accepted"), rv("Rejected")).contains(outcome)
            || !manifest(one(data, REVISIONS, source, rv("manifest"))))
            return new Snapshot(Map.of(), "retained classification provenance differs");
        Node definition = supplied(data, modify, CURRENT, statement, rv("interpretationDefinition"));
        Node concept = supplied(data, modify, CURRENT, statement, RDF.object.asNode());
        if (!nativeId(definition) || !nativeId(concept)
            || !data.contains(REVISIONS, definition, RDF.type.asNode(), rv("RevisionAnchor"))
            || !sense.equals(one(data, REVISIONS, definition, rv("component")))
            || !definitionConcept(data, definition, sense, concept))
            return new Snapshot(Map.of(), "retained classification DefinitionRef differs");
        // DefinitionRefs bind the historical meaning. Current Sense heads never reinterpret it.
        String meaningJson = "[\"statement-meaning-v1\",\"" + main.getURI() + "\",\"" + RV
            + "classifiedAs\",\"" + PROPOSITION + "\",[\"" + definition.getURI()
            + "\"],[\"resource\",\"" + concept.getURI() + "\"],[]]";
        Node meaning = uri("urn:rezics:meaning:" + hash(meaningJson));
        Node expectedSlot = uri("urn:rezics:decision-slot:" + hash("[\"statement-decision-v1\",\"qualified-fact\",\""
            + meaning.getURI() + "\",\"" + context.getURI() + "\"]"));
        if (!statement.equals(identity(app.getURI(), meaning.getURI()))
            || !revision.equals(identity(statement.getURI(), "revision")) || !slot.equals(expectedSlot)
            || !decision.equals(identity(source.getURI(), "statement-decision")))
            return new Snapshot(Map.of(), "Statement conversion deterministic identities differ");
        Set<Quad> statementRecord = record(CURRENT, statement, Map.ofEntries(
            Map.entry(RDF.type.asNode(), RDF.Statement.asNode()), Map.entry(RDF.subject.asNode(), main),
            Map.entry(RDF.predicate.asNode(), rv("classifiedAs")), Map.entry(RDF.object.asNode(), concept),
            Map.entry(rv("relationDefinition"), uri(PROPOSITION)), Map.entry(rv("interpretationDefinition"), definition),
            Map.entry(rv("speaker"), proposer), Map.entry(rv("meaningKey"), meaning),
            Map.entry(rv("statementState"), rv("Active")), Map.entry(rv("head"), revision), Map.entry(rv("migratedFrom"), app)));
        Set<Quad> revisionRecord = anchor(REVISIONS, revision, statement, uri(STATEMENT), operation, epoch, sequence,
            supplied(data, modify, REVISIONS, revision, rv("manifest")), rv("StatementRevision"));
        revisionRecord.add(new Quad(REVISIONS, revision, rv("recordedBy"), actor));
        revisionRecord.add(new Quad(REVISIONS, revision, rv("statementState"), rv("Active")));
        Node basis = context.equals(uri("urn:rezics:classification-context:global")) ? rv("GlobalCuratorReview") : rv("RealmManagerReview");
        if (!basis.equals(one(data, REVISIONS, source, rv("decisionBasis"))))
            return new Snapshot(Map.of(), "retained classification decision basis differs");
        Set<Quad> decisionRecord = anchor(REVISIONS, decision, slot, uri(DECISION), operation, epoch, sequence,
            supplied(data, modify, REVISIONS, decision, rv("manifest")), rv("StatementDecision"));
        decisionRecord.addAll(record(REVISIONS, decision, Map.of(rv("outcome"), outcome, rv("decisionBasis"), basis,
            rv("decidedBy"), actor, rv("decisionPolicy"), uri(DECISION), rv("support"), statement, rv("convertedFrom"), source)));
        Node contextRevision = optional(data, REVISIONS, source, rv("contextRevision"));
        if (contextRevision != null) decisionRecord.add(new Quad(REVISIONS, decision, rv("contextRevision"), contextRevision));
        Map<Key, Set<Quad>> expected = new HashMap<>();
        expected.put(new Key(CURRENT, statement), statementRecord);
        expected.put(new Key(REVISIONS, revision), revisionRecord);
        if (modify.getInsertQuads().stream().noneMatch(q -> q.getGraph().equals(CURRENT) || q.getGraph().equals(REVISIONS))) {
            if (!modify.getDeleteQuads().isEmpty())
                return new Snapshot(Map.of(), "proof-only Statement conversion cannot delete data");
            Node predecessor = optional(data, REVISIONS, decision, rv("predecessor"));
            if (predecessor != null) {
                if (!data.contains(REVISIONS, predecessor, RDF.type.asNode(), rv("StatementDecision"))
                    || !slot.equals(one(data, REVISIONS, predecessor, rv("component"))))
                    return new Snapshot(Map.of(), "existing native conversion predecessor differs");
                decisionRecord.add(new Quad(REVISIONS, decision, rv("predecessor"), predecessor));
            }
            expected.put(new Key(REVISIONS, decision), decisionRecord);
            if (!slotRecord(data, slot, meaning, context)) return new Snapshot(Map.of(), "existing native slot differs");
            for (var entry : expected.entrySet()) if (!stored(data, entry.getKey()).equals(entry.getValue()))
                return new Snapshot(Map.of(), "existing native conversion provenance differs");
            return new Snapshot(Map.copyOf(expected), null);
        }
        Node prior = optional(data, CURRENT, slot, rv("decisionHead"));
        Set<Quad> slotRecord = record(CURRENT, slot, Map.of(RDF.type.asNode(), rv("DecisionSlot"),
            rv("targetKind"), rv("QualifiedFactTarget"), rv("decisionTarget"), meaning,
            rv("acceptanceContext"), context, rv("decisionHead"), decision));
        if (prior != null) {
            if (!slotRecord(data, slot, meaning, context) || prior.equals(decision)
                || !positive(modify.getWherePattern(), CURRENT, slot, rv("decisionHead"), prior)
                || !quads(modify.getDeleteQuads(), CURRENT).equals(Set.of(new Quad(CURRENT, slot, rv("decisionHead"), prior))))
                return new Snapshot(Map.of(), "Statement conversion slot predecessor differs");
            decisionRecord.add(new Quad(REVISIONS, decision, rv("predecessor"), prior));
        } else if (!stored(data, new Key(CURRENT, slot)).isEmpty() || !quads(modify.getDeleteQuads(), CURRENT).isEmpty())
            return new Snapshot(Map.of(), "Statement conversion slot is ambiguous");
        expected.put(new Key(CURRENT, slot), slotRecord);
        expected.put(new Key(REVISIONS, decision), decisionRecord);
        for (var entry : expected.entrySet()) {
            Key key = entry.getKey();
            Set<Quad> before = stored(data, key);
            Set<Quad> writes = subjectQuads(modify.getInsertQuads(), key);
            if (key.equals(new Key(CURRENT, slot))) {
                if (!writes.equals(slotRecord)) return new Snapshot(Map.of(), "Statement conversion slot footprint differs");
            } else if (!before.isEmpty()) {
                if (!before.equals(entry.getValue()) || !writes.isEmpty())
                    return new Snapshot(Map.of(), "Statement conversion cannot rewrite existing records");
            } else if (!writes.equals(entry.getValue()))
                return new Snapshot(Map.of(), "Statement conversion record footprint differs");
        }
        for (Quad quad : modify.getInsertQuads()) if (Set.of(CURRENT, REVISIONS).contains(quad.getGraph())
            && !expected.containsKey(new Key(quad.getGraph(), quad.getSubject())))
            return new Snapshot(Map.of(), "Statement conversion contains unrelated data");
        return new Snapshot(Map.copyOf(expected), null);
    }

    static String check(DatasetGraph data, Snapshot before) {
        if (before.error() != null) return before.error();
        for (var entry : before.expected().entrySet()) if (!stored(data, entry.getKey()).equals(entry.getValue()))
            return "Statement conversion poststate differs";
        return null;
    }

    static String checkControl(DatasetGraph data, String receipt, CommandPolicy.Plan plan,
        CommandInvariant.Control before, CommandInvariant.Control after, Node epoch, BigInteger sequence) {
        if (!CommandInvariant.hasControlGuards(plan, before) || !before.epoch().equals(after.epoch())
            || !before.routing().equals(after.routing()) || !before.sequence().equals(after.sequence())
            || !Objects.equals(before.marker(), after.marker()) || !Objects.equals(before.priorEpoch(), after.priorEpoch())
            || !Objects.equals(before.priorSequence(), after.priorSequence()) || !Objects.equals(before.cursor(), after.cursor())
            || !Objects.equals(before.textGeneration(), after.textGeneration()) || !epoch.equals(before.epoch())
            || !sequence.equals(before.sequence())) return "Statement upgrade changed dataset lineage or position";
        String phase = phase(receipt);
        if (phase.equals("acquire") ? before.held() || !after.held()
            : phase.equals("release") ? !before.held() || after.held() : before.held() != after.held())
            return "Statement upgrade hold transition differs";
        return null;
    }

    private static boolean definitionConcept(DatasetGraph data, Node definition, Node sense, Node concept) {
        var matches = data.find(RECEIPTS, Node.ANY, rv("definitionRevision"), definition);
        int count = 0;
        while (matches.hasNext()) {
            Node receipt = matches.next().getSubject();
            if (++count > 4) return false;
            if (sense.equals(one(data, RECEIPTS, receipt, rv("sense")))
                && concept.equals(one(data, RECEIPTS, receipt, rv("concept")))
                && rv("Succeeded").equals(one(data, RECEIPTS, receipt, rv("outcome")))) return true;
        }
        return false;
    }
    private static boolean slotRecord(DatasetGraph data, Node slot, Node meaning, Node context) {
        Node head = one(data, CURRENT, slot, rv("decisionHead"));
        return head != null && head.isURI() && data.contains(REVISIONS, head, RDF.type.asNode(), rv("StatementDecision"))
            && slot.equals(one(data, REVISIONS, head, rv("component")))
            && stored(data, new Key(CURRENT, slot)).equals(record(CURRENT, slot, Map.of(
                RDF.type.asNode(), rv("DecisionSlot"), rv("targetKind"), rv("QualifiedFactTarget"),
                rv("decisionTarget"), meaning, rv("acceptanceContext"), context, rv("decisionHead"), head)));
    }
    private static Set<Quad> anchor(Node graph, Node revision, Node component, Node profile, Node operation,
        Node epoch, Node sequence, Node manifest, Node type) {
        if (!manifest(manifest)) throw new IllegalArgumentException("Statement conversion manifest differs");
        Set<Quad> result = record(graph, revision, Map.of(rv("component"), component, rv("operation"), operation,
            rv("modelRevision"), profile, rv("shapeRevision"), profile, rv("manifest"), manifest,
            rv("dataEpoch"), epoch, rv("sequence"), sequence));
        result.add(new Quad(graph, revision, RDF.type.asNode(), type));
        result.add(new Quad(graph, revision, RDF.type.asNode(), rv("RevisionAnchor")));
        return result;
    }
    private static Node supplied(DatasetGraph data, UpdateModify modify, Node graph, Node subject, Node predicate) {
        Node value = optionalTemplate(modify, graph, subject, predicate);
        return value == null ? one(data, graph, subject, predicate) : value;
    }
    private static Node required(UpdateModify modify, Node graph, Node subject, Node predicate) {
        Node value = optionalTemplate(modify, graph, subject, predicate);
        if (value == null) throw new IllegalArgumentException("Statement upgrade required field missing: " + predicate);
        return value;
    }
    private static Node optionalTemplate(UpdateModify modify, Node graph, Node subject, Node predicate) {
        Node result = null;
        for (Quad quad : modify.getInsertQuads()) if (quad.getGraph().equals(graph)
            && quad.getSubject().equals(subject) && quad.getPredicate().equals(predicate)) {
            if (result != null) throw new IllegalArgumentException("Statement upgrade field is ambiguous: " + predicate);
            result = quad.getObject();
        }
        return result;
    }
    private static Node optional(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
        if (!values.hasNext()) return null;
        Node result = values.next().getObject();
        if (values.hasNext()) throw new IllegalArgumentException("Statement upgrade prestate field is ambiguous");
        return result;
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) { return optional(data, graph, subject, predicate); }
    private static Set<Quad> stored(DatasetGraph data, Key key) {
        Set<Quad> result = new HashSet<>();
        data.find(key.graph(), key.subject(), Node.ANY, Node.ANY).forEachRemaining(result::add);
        return result;
    }
    private static Set<Quad> record(Node graph, Node subject, Map<Node, Node> values) {
        Set<Quad> result = new HashSet<>();
        values.forEach((predicate, value) -> result.add(new Quad(graph, subject, predicate, value)));
        return result;
    }
    private static Set<Quad> quads(List<Quad> values, Node graph) {
        Set<Quad> result = new HashSet<>();
        values.stream().filter(q -> q.getGraph().equals(graph)).forEach(result::add);
        return result;
    }
    private static Set<Quad> subjectQuads(List<Quad> values, Key key) {
        Set<Quad> result = new HashSet<>();
        values.stream().filter(q -> q.getGraph().equals(key.graph()) && q.getSubject().equals(key.subject())).forEach(result::add);
        return result;
    }
    private static boolean positive(Element element, Node graph, Node subject, Node predicate, Node object) {
        return positive(element, graph, subject, predicate, object, false);
    }
    private static boolean positive(Element element, Node graph, Node subject, Node predicate, Node object, boolean named) {
        if (element instanceof ElementGroup group) return group.getElements().stream()
            .anyMatch(child -> positive(child, graph, subject, predicate, object, named));
        if (element instanceof ElementNamedGraph target) return graph.equals(target.getGraphNameNode())
            && positive(target.getElement(), graph, subject, predicate, object, true);
        Triple wanted = Triple.create(subject, predicate, object);
        if (named && element instanceof ElementPathBlock block) {
            var paths = block.patternElts();
            while (paths.hasNext()) { var path = paths.next(); if (path.isTriple() && path.asTriple().equals(wanted)) return true; }
        } else if (named && element instanceof ElementTriplesBlock block) {
            var triples = block.patternElts();
            while (triples.hasNext()) if (triples.next().equals(wanted)) return true;
        }
        return false;
    }
    private static boolean resource(Node value) { return value != null && value.isURI(); }
    private static boolean nativeId(Node value) { return resource(value)
        && value.getURI().matches("https://rezics.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static boolean manifest(Node value) { return resource(value) && value.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}"); }
    private static BigInteger number(Node value) {
        if (value == null || !value.isLiteral() || !"http://www.w3.org/2001/XMLSchema#integer".equals(value.getLiteralDatatypeURI())) return null;
        try { return new BigInteger(value.getLiteralLexicalForm()); } catch (NumberFormatException ex) { return null; }
    }
    private static String lexical(Node value) {
        if (!value.isLiteral()) throw new IllegalArgumentException("Statement upgrade literal required");
        return value.getLiteralLexicalForm();
    }
    private static Node identity(String source, String role) {
        String value = hash(source + '\0' + role).substring(0, 32);
        return uri("https://rezics.com/id/" + value.substring(0, 8) + '-' + value.substring(8, 12)
            + '-' + value.substring(12, 16) + '-' + value.substring(16, 20) + '-' + value.substring(20));
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }
    private static Set<Node> fields(String... names) {
        Set<Node> result = new HashSet<>();
        for (String name : names) result.add(rv(name));
        return Set.copyOf(result);
    }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node rv(String name) { return uri(RV + name); }
    private static Node uri(String name) { return NodeFactory.createURI(name); }
    private StatementUpgradePolicy() {}
}
