package com.rezics.jena;

import java.math.BigInteger;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.graph.Triple;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.syntax.ElementGroup;
import org.apache.jena.sparql.syntax.ElementNamedGraph;
import org.apache.jena.sparql.syntax.ElementTriplesBlock;
import org.apache.jena.vocabulary.RDF;

/** One retained classification position and its native representation, under the
 * existing authenticated maintenance transport. No live admission is created. */
final class StatementRestorePolicy {
    private static final String RV = "https://rezics.com/vocab/";
    private static final String CLASSIFICATION = "https://rezics.com/definition/classification-direct-decision-v1";
    private static final Node CONTROL = uri(CommandPolicy.CONTROL), CURRENT = uri(CommandPolicy.CURRENT);
    private static final Node REVISIONS = uri(CommandPolicy.REVISIONS), RECEIPTS = uri(CommandPolicy.RECEIPTS);
    private static final Node OUTBOX = uri(CommandPolicy.OUTBOX), PRODUCT = uri("urn:rezics:dataset:product");
    private static final Node GLOBAL = uri("urn:rezics:classification-context:global");
    private static final Set<Node> OWN_FIELDS = fields("commandFamily", "requestDigest", "datasetId", "dataEpoch",
        "sequence", "outcome", "statementUpgrade", "convertedApplication", "convertedDecision", "statement",
        "statementRevision", "decisionSlot", "statementDecision", "restoredReceipt");

    static void validateTemplate(CommandPolicy.Plan plan, String receipt) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify))
            throw new IllegalArgumentException("classification restore requires a guarded update");
        Node own = uri(receipt), original = value(modify, RECEIPTS, own, "restoredReceipt");
        Node epoch = value(modify, RECEIPTS, own, "dataEpoch");
        if (!epoch.isLiteral() || !value(modify, RECEIPTS, own, "sequence").isVariable()
            || !value(modify, RECEIPTS, own, "statementUpgrade").equals(uri("urn:rezics:maintenance:statement-upgrade:"
                + hash(epoch.getLiteralLexicalForm())))
            || !value(modify, RECEIPTS, own, "commandFamily").equals(text("statement-upgrade-restore-v1"))
            || !value(modify, RECEIPTS, own, "requestDigest").equals(text(receipt.substring(receipt.lastIndexOf(':') + 1)))
            || !value(modify, RECEIPTS, own, "datasetId").equals(PRODUCT)
            || !value(modify, RECEIPTS, own, "outcome").equals(rv("Succeeded"))
            || !original.isURI() || !original.getURI().matches("urn:rezics:receipt:[0-9a-f]{64}")
            || !plan.graphs().equals(Set.of(CommandPolicy.CONTROL, CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
                CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX)))
            throw new IllegalArgumentException("classification restore envelope differs");
        Node app = value(modify, RECEIPTS, own, "convertedApplication");
        Node source = value(modify, RECEIPTS, own, "convertedDecision");
        Node slot = value(modify, RECEIPTS, own, "decisionSlot");
        Set<Node> ownAllowed = new HashSet<>(OWN_FIELDS); ownAllowed.add(RDF.type.asNode());
        if (!value(modify, RECEIPTS, own, RDF.type.asNode()).equals(rv("OperationReceipt")))
            throw new IllegalArgumentException("classification restore receipt type differs");
        for (String field : List.of("convertedApplication", "convertedDecision", "statement", "statementRevision",
            "decisionSlot", "statementDecision")) if (!value(modify, RECEIPTS, own, field).isURI())
            throw new IllegalArgumentException("classification restore identities must be concrete");
        for (Quad quad : modify.getInsertQuads()) {
            if (!quad.getPredicate().isURI() || !(quad.getObject().isURI() || quad.getObject().isLiteral()
                || quad.getGraph().equals(RECEIPTS) && quad.getSubject().equals(own)
                    && quad.getPredicate().equals(rv("sequence"))
                    && quad.getObject().equals(value(modify, RECEIPTS, own, "sequence"))))
                throw new IllegalArgumentException("classification restore values must be concrete");
            if (quad.getGraph().equals(RECEIPTS) && (!quad.getSubject().equals(original)
                && (!quad.getSubject().equals(own) || !ownAllowed.contains(quad.getPredicate()))))
                throw new IllegalArgumentException("classification restore receipt footprint differs");
        }
        for (Quad quad : modify.getDeleteQuads()) {
            boolean cursor = quad.getGraph().equals(CONTROL) && quad.getPredicate().equals(rv("reconciledPriorSequence"));
            boolean historical = quad.getGraph().equals(REVISIONS) && quad.getSubject().equals(app)
                && quad.getPredicate().equals(rv("decisionHead")) && quad.getObject().isVariable();
            boolean nativeHead = quad.getGraph().equals(CURRENT) && quad.getSubject().equals(slot)
                && quad.getPredicate().equals(rv("decisionHead")) && quad.getObject().isURI();
            if (!(cursor || historical || nativeHead))
                throw new IllegalArgumentException("classification restore delete footprint differs");
        }
        if (new HashSet<>(modify.getInsertQuads()).size() != modify.getInsertQuads().size()
            || modify.getDeleteQuads().size() > 3)
            throw new IllegalArgumentException("classification restore footprint is ambiguous");
        if (app.equals(source)) throw new IllegalArgumentException("classification restore identities overlap");
    }

    static StatementUpgradePolicy.Snapshot capture(DatasetGraph data, String receipt, CommandPolicy.Plan plan,
        CommandInvariant.Control control) {
        try {
            var modify = (UpdateModify) plan.request().getOperations().getFirst();
            Node own = uri(receipt), original = value(modify, RECEIPTS, own, "restoredReceipt");
            Node app = value(modify, RECEIPTS, own, "convertedApplication"), source = value(modify, RECEIPTS, own, "convertedDecision");
            Node epoch = value(modify, RECEIPTS, original, "dataEpoch"), sequence = value(modify, RECEIPTS, original, "sequence");
            BigInteger position = number(sequence), previous = control.cursor() == null ? control.priorSequence() : control.cursor();
            if (!control.held() || control.marker() == null || control.sequence().signum() != 0
                || !control.epoch().equals(value(modify, RECEIPTS, own, "dataEpoch"))
                || !epoch.equals(control.priorEpoch()) || previous == null || position == null
                || !position.equals(previous.add(BigInteger.ONE))
                || data.contains(RECEIPTS, original, Node.ANY, Node.ANY)
                || data.contains(REVISIONS, source, Node.ANY, Node.ANY))
                return failure("classification restore lineage, cursor or source differs");
            Node work = value(modify, RECEIPTS, original, "work"), main = value(modify, RECEIPTS, original, "mainVersion");
            Node sense = value(modify, RECEIPTS, original, "sense"), context = value(modify, RECEIPTS, original, "classificationContext");
            Node operation = value(modify, RECEIPTS, original, "operation"), outcome = value(modify, RECEIPTS, original, "decisionOutcome");
            Node manifest = value(modify, REVISIONS, source, "manifest"), actor = value(modify, REVISIONS, source, "decidedBy");
            Node proposer = value(modify, REVISIONS, app, "proposer");
            String admission = lexical(value(modify, RECEIPTS, original, "admissionId"));
            String scope = lexical(value(modify, RECEIPTS, original, "admittedScope"));
            Node realm = optional(modify, RECEIPTS, original, "realm"), contextRevision = optional(modify, RECEIPTS, original, "contextRevision");
            Node predecessor = optional(modify, RECEIPTS, original, "expectedHead");
            if (!nativeId(work) || !nativeId(main) || !nativeId(sense) || !nativeId(actor)
                || !nativeId(proposer) || !nativeId(operation) || !nativeId(app) || !nativeId(source)
                || !(context.equals(GLOBAL) || nativeId(context))
                || realm != null && !nativeId(realm) || contextRevision != null && !nativeId(contextRevision)
                || predecessor != null && !nativeId(predecessor))
                return failure("classification restore native identities differ");
            String contextJson = context.equals(GLOBAL) ? "{\"kind\":\"global\"}"
                : "{\"kind\":\"realm-classification\",\"id\":\"" + (realm == null ? "" : realm.getURI()) + "\"}";
            String requestJson = "{\"family\":\"classification-direct-decision-v1\",\"context\":" + contextJson
                + ",\"work\":\"" + work.getURI() + "\",\"mainVersion\":\"" + main.getURI()
                + "\",\"sense\":\"" + sense.getURI() + "\",\"expectedDecisionHead\":"
                + (predecessor == null ? "null" : "\"" + predecessor.getURI() + "\"")
                + ",\"outcome\":\"" + (outcome.equals(rv("Accepted")) ? "accepted" : "rejected")
                + "\",\"actingSubject\":\"" + actor.getURI() + "\"}";
            if (!hash(requestJson).equals(lexical(value(modify,RECEIPTS,original,"requestDigest"))))
                return failure("classification restore sealed request digest differs");
            String identity = "[\"statement-storage-restore-v1\",\"" + control.epoch().getLiteralLexicalForm()
                + "\",\"" + control.routing().getLiteralLexicalForm() + "\",\"" + original.getURI() + "\",\""
                + lexical(value(modify,RECEIPTS,original,"requestDigest")) + "\",\"" + epoch.getLiteralLexicalForm()
                + "\",\"" + position + "\"]";
            if (!receipt.endsWith(':' + hash(identity))) return failure("classification restore identity digest differs");
            Node basis = context.equals(GLOBAL) ? rv("GlobalCuratorReview") : rv("RealmManagerReview");
            Node legacySlot = uri("urn:rezics:classification-slot:" + hash("{\"mainVersion\":\"" + main.getURI()
                + "\",\"sense\":\"" + sense.getURI() + "\",\"context\":\"" + context.getURI() + "\",\"channel\":\"curated\"}"));
            if (!admission.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
                || !original.equals(uri("urn:rezics:receipt:" + hash(admission + '\0' + "classification-direct-decision")))
                || !app.equals(value(modify, RECEIPTS, original, "application"))
                || !source.equals(value(modify, RECEIPTS, original, "decision"))
                || !Set.of(rv("Accepted"),rv("Rejected")).contains(outcome)
                || !legacySlot.equals(value(modify, RECEIPTS, original, "slot"))
                || !lexical(value(modify, RECEIPTS, original, "requestDigest")).matches("[0-9a-f]{64}")
                || !lexical(value(modify, RECEIPTS, original, "authorityEpoch")).matches("[0-9]+")
                || (context.equals(GLOBAL) ? realm != null || contextRevision != null || !scope.equals("classification:decide:global")
                    : realm == null || contextRevision == null || !scope.equals("classification:decide:" + realm.getURI())))
                return failure("classification restore original receipt differs");
            Set<Quad> originalRecord = record(RECEIPTS, original, Map.ofEntries(
                Map.entry(RDF.type.asNode(),rv("OperationReceipt")), Map.entry(rv("operation"),operation),
                Map.entry(rv("requestDigest"),value(modify,RECEIPTS,original,"requestDigest")),
                Map.entry(rv("admissionId"),text(admission)), Map.entry(rv("authorityEpoch"),value(modify,RECEIPTS,original,"authorityEpoch")),
                Map.entry(rv("admittedScope"),text(scope)),Map.entry(rv("outcome"),rv("Succeeded")),
                Map.entry(rv("work"),work),Map.entry(rv("mainVersion"),main),Map.entry(rv("sense"),sense),
                Map.entry(rv("classificationContext"),context),Map.entry(rv("slot"),legacySlot),
                Map.entry(rv("application"),app),Map.entry(rv("decision"),source),Map.entry(rv("decisionOutcome"),outcome),
                Map.entry(rv("datasetId"),PRODUCT),Map.entry(rv("dataEpoch"),epoch),Map.entry(rv("sequence"),sequence)));
            optionalAdd(originalRecord,RECEIPTS,original,"realm",realm); optionalAdd(originalRecord,RECEIPTS,original,"contextRevision",contextRevision);
            optionalAdd(originalRecord,RECEIPTS,original,"expectedHead",predecessor);
            Set<Quad> appRecord = record(REVISIONS,app,Map.ofEntries(Map.entry(RDF.type.asNode(),rv("ClassificationApplication")),
                Map.entry(rv("targetMainVersion"),main),Map.entry(rv("sense"),sense),Map.entry(rv("applicationKey"),legacySlot),
                Map.entry(rv("classificationContext"),context),Map.entry(rv("applicationChannel"),rv("Curated")),
                Map.entry(rv("applicationState"),rv("Active")),Map.entry(rv("proposer"),proposer),Map.entry(rv("decisionHead"),source)));
            Set<Quad> sourceRecord = record(REVISIONS,source,Map.ofEntries(Map.entry(RDF.type.asNode(),rv("ClassificationDecision")),
                Map.entry(rv("component"),app),Map.entry(rv("application"),app),Map.entry(rv("operation"),operation),
                Map.entry(rv("outcome"),outcome),Map.entry(rv("decisionBasis"),basis),Map.entry(rv("decidedBy"),actor),
                Map.entry(rv("decisionPolicy"),uri(CLASSIFICATION)),Map.entry(rv("manifest"),manifest),
                Map.entry(rv("modelRevision"),uri(CLASSIFICATION)),Map.entry(rv("shapeRevision"),uri(CLASSIFICATION)),
                Map.entry(rv("datasetId"),PRODUCT),Map.entry(rv("dataEpoch"),epoch),Map.entry(rv("sequence"),sequence)));
            sourceRecord.add(new Quad(REVISIONS,source,RDF.type.asNode(),rv("RevisionAnchor")));
            optionalAdd(sourceRecord,REVISIONS,source,"contextRevision",contextRevision); optionalAdd(sourceRecord,REVISIONS,source,"predecessor",predecessor);
            Set<Quad> priorApp = stored(data,REVISIONS,app);
            if (priorApp.isEmpty() && predecessor != null) {
                // An upgraded old snapshot may retain its raw Application in
                // Current. Read that immutable provenance without moving or
                // rewriting it; this position creates the historical snapshot.
                for (Quad quad : stored(data,CURRENT,app))
                    priorApp.add(new Quad(REVISIONS,quad.getSubject(),quad.getPredicate(),quad.getObject()));
            }
            Set<Quad> appUnchanged = new HashSet<>(appRecord); appUnchanged.removeIf(q -> q.getPredicate().equals(rv("decisionHead")));
            Set<Quad> priorUnchanged = new HashSet<>(priorApp); priorUnchanged.removeIf(q -> q.getPredicate().equals(rv("decisionHead")));
            long priorHeads = priorApp.stream().filter(q -> q.getPredicate().equals(rv("decisionHead"))).count();
            if (priorHeads > 1 || !priorApp.isEmpty() && !appUnchanged.equals(priorUnchanged)
                || predecessor == null && !priorApp.isEmpty()
                || predecessor != null && (!data.contains(REVISIONS,predecessor,RDF.type.asNode(),rv("ClassificationDecision"))
                    || !data.contains(REVISIONS,predecessor,rv("component"),app)
                    || !priorApp.contains(new Quad(REVISIONS,app,rv("decisionHead"),predecessor))))
                return failure("classification restore historical predecessor differs");
            Node batch = uri("urn:rezics:outbox:" + hash(original.getURI())), event = uri("urn:rezics:event:" + hash(operation.getURI()));
            Set<Quad> batchRecord = record(OUTBOX,batch,Map.of(RDF.type.asNode(),rv("OutboxBatch"),rv("dataEpoch"),epoch,
                rv("sequence"),sequence,rv("eventCount"),integer(BigInteger.ONE),rv("event"),event));
            Set<Quad> eventRecord = record(OUTBOX,event,Map.of(RDF.type.asNode(),rv("ClassificationDecisionChangedEvent"),
                rv("ordinal"),integer(BigInteger.ZERO),rv("action"),text("classification.decision.set"),rv("receipt"),original,
                rv("operation"),operation,rv("work"),work,rv("application"),app));
            optionalAdd(eventRecord,OUTBOX,event,"realm",realm);
            var expected = new HashMap<StatementUpgradePolicy.Key,Set<Quad>>();
            expected.put(new StatementUpgradePolicy.Key(REVISIONS,app),appRecord); expected.put(new StatementUpgradePolicy.Key(REVISIONS,source),sourceRecord);
            expected.put(new StatementUpgradePolicy.Key(RECEIPTS,original),originalRecord); expected.put(new StatementUpgradePolicy.Key(OUTBOX,batch),batchRecord);
            expected.put(new StatementUpgradePolicy.Key(OUTBOX,event),eventRecord);
            for (var entry : expected.entrySet()) {
                Set<Quad> writes = subjectQuads(modify.getInsertQuads(),entry.getKey().graph(),entry.getKey().subject());
                if (!writes.equals(entry.getValue())) return failure("classification restore retained footprint differs");
            }
            if (!stored(data,OUTBOX,batch).isEmpty() || !stored(data,OUTBOX,event).isEmpty()) return failure("classification restore outbox already exists");
            var overlay = new CommandOverlay(data);
            sourceRecord.forEach(overlay::add);
            // The conversion policy reads its immutable input through a bounded
            // view; these synthetic Current quads never reach the real dataset.
            overlay.deleteAny(CURRENT,app,Node.ANY,Node.ANY);
            for (Quad quad : appRecord) overlay.add(new Quad(CURRENT,quad.getSubject(),quad.getPredicate(),quad.getObject()));
            var nativeModify = nativeModify(modify,own,app,source);
            var converted = StatementUpgradePolicy.conversion(overlay,nativeModify,own,true);
            if (converted.error() != null) return converted;
            expected.putAll(converted.expected());
            for (Quad quad : modify.getInsertQuads()) {
                if (quad.getGraph().equals(CONTROL)) {
                    if (!quad.equals(new Quad(CONTROL,control.marker(),rv("reconciledPriorSequence"),sequence)))
                        return failure("classification restore control footprint differs");
                } else if (!(quad.getGraph().equals(RECEIPTS) && quad.getSubject().equals(own))
                    && !expected.containsKey(new StatementUpgradePolicy.Key(quad.getGraph(),quad.getSubject())))
                    return failure("classification restore contains unrelated data");
            }
            for (Quad quad : modify.getDeleteQuads()) if (quad.getGraph().equals(CONTROL)
                && (!quad.getSubject().equals(control.marker()) || !quad.getObject().isVariable()))
                return failure("classification restore cursor delete differs");
            return new StatementUpgradePolicy.Snapshot(Map.copyOf(expected),null);
        } catch (IllegalArgumentException | NullPointerException ex) { return failure("classification restore required provenance differs: " + ex.getMessage()); }
    }

    static String originalReceipt(CommandPolicy.Plan plan,String receipt) {
        return value((UpdateModify)plan.request().getOperations().getFirst(),RECEIPTS,uri(receipt),"restoredReceipt").getURI();
    }
    static String checkControl(DatasetGraph data,String receipt,CommandPolicy.Plan plan,CommandInvariant.Control before,Node epoch,BigInteger sequence) {
        if (!epoch.equals(before.epoch()) || sequence.signum() != 0) return "classification restore maintenance position differs";
        String original = originalReceipt(plan,receipt);
        Node digest = data.find(RECEIPTS,uri(original),rv("requestDigest"),Node.ANY).next().getObject();
        return CommandInvariant.check(data,original,lexical(digest),plan,before);
    }
    static CommandPolicy.Plan nativePlan(CommandPolicy.Plan plan,String receipt) {
        UpdateModify modify = (UpdateModify)plan.request().getOperations().getFirst(); Node own = uri(receipt);
        return new CommandPolicy.Plan(plan.request(),plan.graphs(),Set.of(value(modify,RECEIPTS,own,"statement").getURI(),
            value(modify,RECEIPTS,own,"decisionSlot").getURI()),Set.of(value(modify,RECEIPTS,own,"statementRevision").getURI(),
            value(modify,RECEIPTS,own,"statementDecision").getURI()),Set.of(),false,false,plan.hasDelete());
    }
    private static UpdateModify nativeModify(UpdateModify modify,Node own,Node app,Node source) {
        UpdateModify result = new UpdateModify();
        Set<Node> nativeSubjects = Set.of(value(modify,RECEIPTS,own,"statement"),value(modify,RECEIPTS,own,"statementRevision"),
            value(modify,RECEIPTS,own,"decisionSlot"),value(modify,RECEIPTS,own,"statementDecision"));
        for (Quad quad : modify.getInsertQuads()) if (nativeSubjects.contains(quad.getSubject()) || quad.getSubject().equals(own))
            result.getInsertAcc().addQuad(quad);
        for (Quad quad : modify.getDeleteQuads()) if (quad.getGraph().equals(CURRENT)) result.getDeleteAcc().addQuad(quad);
        ElementGroup guards = new ElementGroup(); guards.addElement(modify.getWherePattern());
        ElementTriplesBlock retained = new ElementTriplesBlock(); retained.addTriple(Triple.create(app,rv("decisionHead"),source));
        guards.addElement(new ElementNamedGraph(CURRENT,retained)); result.setElement(guards);
        return result;
    }
    private static StatementUpgradePolicy.Snapshot failure(String error) { return new StatementUpgradePolicy.Snapshot(Map.of(),error); }
    private static Set<Quad> record(Node graph,Node subject,Map<Node,Node> fields) {
        Set<Quad> result = new HashSet<>(); fields.forEach((p,o) -> result.add(new Quad(graph,subject,p,o))); return result;
    }
    private static Set<Quad> stored(DatasetGraph data,Node graph,Node subject) {
        Set<Quad> result = new HashSet<>(); data.find(graph,subject,Node.ANY,Node.ANY).forEachRemaining(result::add); return result;
    }
    private static Set<Quad> subjectQuads(List<Quad> quads,Node graph,Node subject) {
        Set<Quad> result = new HashSet<>(); for (Quad quad : quads) if (quad.getGraph().equals(graph) && quad.getSubject().equals(subject)) result.add(quad); return result;
    }
    private static void optionalAdd(Set<Quad> record,Node graph,Node subject,String predicate,Node value) {
        if (value != null) record.add(new Quad(graph,subject,rv(predicate),value));
    }
    private static Node value(UpdateModify modify,Node graph,Node subject,String predicate) { return value(modify,graph,subject,rv(predicate)); }
    private static Node value(UpdateModify modify,Node graph,Node subject,Node predicate) {
        Node found = null;
        for (Quad quad : modify.getInsertQuads()) if (quad.getGraph().equals(graph) && quad.getSubject().equals(subject) && quad.getPredicate().equals(predicate)) {
            if (found != null) throw new IllegalArgumentException("ambiguous restore field " + predicate); found = quad.getObject();
        }
        if (found == null) throw new IllegalArgumentException("missing restore field " + predicate); return found;
    }
    private static Node optional(UpdateModify modify,Node graph,Node subject,String predicate) {
        boolean present = modify.getInsertQuads().stream().anyMatch(q -> q.getGraph().equals(graph) && q.getSubject().equals(subject) && q.getPredicate().equals(rv(predicate)));
        return present ? value(modify,graph,subject,predicate) : null;
    }
    private static Set<Node> fields(String... values) { Set<Node> result = new HashSet<>(); for (String value : values) result.add(rv(value)); return Set.copyOf(result); }
    private static BigInteger number(Node value) {
        if (!value.isLiteral() || !"http://www.w3.org/2001/XMLSchema#integer".equals(value.getLiteralDatatypeURI())) return null;
        try { return new BigInteger(value.getLiteralLexicalForm()); } catch (NumberFormatException ex) { return null; }
    }
    private static String lexical(Node value) { if (!value.isLiteral()) throw new IllegalArgumentException("restore literal required"); return value.getLiteralLexicalForm(); }
    private static Node integer(BigInteger value) { return NodeFactory.createLiteralByValue(value,org.apache.jena.datatypes.xsd.XSDDatatype.XSDinteger); }
    private static boolean nativeId(Node value) { return value != null && value.isURI()
        && value.getURI().matches("https://rezics.com/id/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}"); }
    private static String hash(String value) { return StatementUpgradePolicy.templateDigest(value); }
    private static Node text(String value) { return NodeFactory.createLiteralString(value); }
    private static Node rv(String value) { return uri(RV + value); }
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private StatementRestorePolicy() {}
}
