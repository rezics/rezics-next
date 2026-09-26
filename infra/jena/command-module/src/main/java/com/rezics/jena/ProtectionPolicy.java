package com.rezics.jena;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.jena.atlas.json.JSON;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonValue;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** Exact, single-Work protection and reviewed-title transition inside the TDB2 writer. */
final class ProtectionPolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        RECEIPTS = uri(CommandPolicy.RECEIPTS), OUTBOX = uri(CommandPolicy.OUTBOX);
    private static final Node LABEL = uri("http://www.w3.org/2000/01/rdf-schema#label");
    private static final Node WORK = uri("https://schema.org/CreativeWork");
    private static final Set<String> ACTIONS = Set.of("work.protection.tighten", "work.protection.confirm",
        "work.protection.relax", "work.correction.propose", "work.correction.review");
    record Snapshot(String action, Node work, Node head, Node protection, Node control,
                    Node effect, Node proposal, String outcome, String error) {}
    private static Snapshot error(String reason) { return new Snapshot(null, null, null, null, null, null, null, null, reason); }

    static Snapshot capture(DatasetGraph data, CommandPolicy.Plan plan, String receipt, String digest,
                            String update, JsonValue proof, byte[] key) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node own = uri(receipt);
        Node actionNode = template(modify.getInsertQuads(), RECEIPTS, own, rv("action"));
        String action = text(actionNode);
        boolean named = action != null && ACTIONS.contains(action);
        boolean touchesProtected = false, touchesProtection = false;
        List<Quad> all = new ArrayList<>(modify.getInsertQuads());
        all.addAll(modify.getDeleteQuads());
        for (Quad q : all) {
            if (CURRENT.equals(q.getGraph()) && (rv("protectionHead").equals(q.getPredicate())
                || (rv("proposalHead").equals(q.getPredicate())
                    && (data.contains(CURRENT, q.getSubject(), RDF.type.asNode(), WORK)
                        || all.contains(Quad.create(CURRENT, q.getSubject(), RDF.type.asNode(), WORK)))))) {
                touchesProtection = true;
            }
            if (REVISIONS.equals(q.getGraph()) && RDF.type.asNode().equals(q.getPredicate())
                && Set.of(rv("ProtectionRevision"), rv("CorrectionProposal"), rv("CorrectionDecision"),
                    rv("CorrectionApplication")).contains(q.getObject())) touchesProtection = true;
            if (CURRENT.equals(q.getGraph())
                && Set.of(rv("head"), LABEL, rv("titleControlHead"), rv("protectionHead")).contains(q.getPredicate())) {
                Node protectionHead = one(data, CURRENT, q.getSubject(), rv("protectionHead"));
                if (data.contains(CURRENT, q.getSubject(), rv("protectionHead"), Node.ANY)
                    && (protectionHead == null
                        || !rv("Open").equals(one(data, REVISIONS, protectionHead, rv("protectionMode"))))) {
                    touchesProtected = true;
                }
            }
        }
        if (!named && !touchesProtected && !touchesProtection) return null;
        if (!named) return error("protected Work mutation requires a reviewed protection action");
        for (String subject : plan.revisions()) if (data.contains(REVISIONS, uri(subject), Node.ANY, Node.ANY)) {
            return error("protected command may write only fresh revisions");
        }
        Node result = template(modify.getInsertQuads(), RECEIPTS, own, rv("outcome"));
        if (rv("Cancelled").equals(result) && plan.current().isEmpty() && plan.revisions().isEmpty()
            && plan.graphs().equals(Set.of(CommandPolicy.CONTROL, CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX))) {
            return new Snapshot(action, null, null, null, null, null, null, "cancelled", null);
        }
        if (!rv("Succeeded").equals(result)) return error("protection receipt outcome is incomplete");
        try {
            if (!admitted(modify, receipt, digest, update, action, proof, key)) return error("trusted protection admission required");
            Node work = template(modify.getInsertQuads(), RECEIPTS, own, rv("work"));
            Node head = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedHead"));
            Node expectedProtection = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedProtection"));
            Node expectedControl = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControl"));
            Node expectedEpoch = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedControlEpoch"));
            if (work == null || !work.isURI() || head == null || !head.isURI() || expectedProtection == null
                || !expectedProtection.isURI() || expectedControl == null || !expectedControl.isURI()
                || expectedEpoch == null || number(expectedEpoch) == null
                || !data.contains(CURRENT, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))) {
                return error("protection target or exact basis is incomplete");
            }
            Node beforeHead = one(data, CURRENT, work, rv("head"));
            Node protection = one(data, CURRENT, work, rv("protectionHead"));
            Node control = one(data, CURRENT, work, rv("titleControlHead"));
            BigInteger controlEpoch = control == null ? BigInteger.ZERO : number(one(data, REVISIONS, control, rv("controlEpoch")));
            if (!head.equals(beforeHead) || controlEpoch == null || !controlEpoch.equals(number(expectedEpoch))
                || !(protection == null ? rv("Absent").equals(expectedProtection) : protection.equals(expectedProtection))
                || !(control == null ? rv("Absent").equals(expectedControl) : control.equals(expectedControl))) {
                return error("protection basis changed");
            }
            String scope = text(template(modify.getInsertQuads(), RECEIPTS, own, rv("admittedScope")));
            String prefix = action.startsWith("work.protection.") ? "work:protect:"
                : action.equals("work.correction.propose") ? "work:correct:" : "work:review:";
            if (!((prefix + work.getURI()).equals(scope))) return error("protection scope differs from Work");
            Node effect = action.startsWith("work.protection.")
                ? template(modify.getInsertQuads(), RECEIPTS, own, rv("protectionRevision"))
                : action.equals("work.correction.propose")
                    ? template(modify.getInsertQuads(), RECEIPTS, own, rv("proposalRevision"))
                    : template(modify.getInsertQuads(), RECEIPTS, own, rv("decision"));
            if (effect == null || !effect.isURI() || data.contains(REVISIONS, effect, Node.ANY, Node.ANY))
                return error("protection effect identity is missing or already used");
            Node proposal = action.equals("work.correction.review")
                ? template(modify.getInsertQuads(), RECEIPTS, own, rv("proposalRevision")) : null;
            if (proposal != null && (!proposal.isURI() || !data.contains(REVISIONS, proposal, RDF.type.asNode(), rv("CorrectionProposal"))))
                return error("review has no exact proposal revision");
            if (action.equals("work.correction.review")
                && !rv("Absent").equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedDecision"))))
                return error("review must assert an absent terminal decision");
            if (!footprint(plan, modify, action, work, effect)) return error("protection mutation footprint differs");
            if (action.startsWith("work.protection.") && !protectionBasis(data, modify, action, work, head, protection, control, effect))
                return error("protection revision basis or transition differs");
            if (action.equals("work.correction.propose") && !proposalBasis(data, modify, work, head, protection, control, effect))
                return error("correction proposal basis differs");
            String outcome = action.equals("work.correction.review")
                ? uriValue(template(modify.getInsertQuads(), RECEIPTS, own, rv("reviewOutcome"))) : null;
            if (action.equals("work.correction.review") && !reviewBasis(data, modify, work, head, protection, control,
                proposal, effect, outcome, proof)) return error("reviewed correction basis differs");
            return new Snapshot(action, work, head, protection, control, effect, proposal, outcome, null);
        } catch (Exception ex) { return error("invalid protection admission or basis"); }
    }

    private static boolean admitted(UpdateModify modify, String receipt, String digest, String update,
                                    String action, JsonValue proof, byte[] key) throws Exception {
        if (proof == null || !proof.isObject()) return false;
        JsonObject object = proof.getAsObject();
        String payload = ProfileRegistry.required(object, "payload"), signature = ProfileRegistry.required(object, "signature");
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
        if (!signature.matches("[0-9a-f]{64}") || !MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)),
            HexFormat.of().parseHex(signature))) return false;
        JsonArray claims = JSON.parseAny(payload).getAsArray();
        String commandHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
            .digest(update.getBytes(StandardCharsets.UTF_8)));
        if (claims.size() != 10 || !claims.get(0).getAsString().value().equals("rezics-work-protection-admission-v1")
            || !claims.get(2).getAsString().value().equals(action)
            || !claims.get(5).getAsString().value().equals(receipt)
            || !claims.get(6).getAsString().value().equals(digest)
            || !claims.get(7).getAsString().value().equals(commandHash)
            || !Instant.parse(claims.get(8).getAsString().value()).isAfter(Instant.now())) return false;
        Node own = uri(receipt);
        for (int i : List.of(1, 2, 3, 4)) {
            String property = i == 1 ? "admissionId" : i == 2 ? "action" : i == 3 ? "admittedScope" : "authorityEpoch";
            Node value = template(modify.getInsertQuads(), RECEIPTS, own, rv(property));
            if (value == null || !value.isLiteral() || !value.getLiteralLexicalForm().equals(claims.get(i).getAsString().value()))
                return false;
        }
        return true;
    }

    private static boolean footprint(CommandPolicy.Plan plan, UpdateModify modify, String action, Node work, Node effect) {
        Set<String> graphs = action.equals("work.correction.review") && !plan.current().contains(work.getURI())
            ? Set.of(CommandPolicy.CONTROL, CommandPolicy.REVISIONS, CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX)
            : Set.of(CommandPolicy.CONTROL, CommandPolicy.CURRENT, CommandPolicy.REVISIONS,
                CommandPolicy.RECEIPTS, CommandPolicy.OUTBOX);
        if (!plan.graphs().equals(graphs) || !plan.revisions().contains(effect.getURI())) return false;
        for (Quad q : modify.getDeleteQuads()) if (REVISIONS.equals(q.getGraph()) || OUTBOX.equals(q.getGraph())) return false;
        for (Quad q : modify.getInsertQuads()) if (REVISIONS.equals(q.getGraph()) && !q.getSubject().isURI()) return false;
        if (action.startsWith("work.protection.")) {
            Node control = template(modify.getInsertQuads(), CURRENT, work, rv("titleControlHead"));
            if (control != null && !control.isURI()) return false;
            Set<String> expected = control == null ? Set.of(effect.getURI()) : Set.of(effect.getURI(), control.getURI());
            if (!plan.current().equals(Set.of(work.getURI())) || !plan.revisions().equals(expected)
                || (action.equals("work.protection.confirm") != (control != null))) return false;
            return currentPredicates(modify, work, Set.of(rv("protectionHead"), rv("titleControlHead")));
        }
        if (action.equals("work.correction.propose")) {
            Node candidate = template(modify.getInsertQuads(), REVISIONS, effect, rv("candidateRevision"));
            if (candidate == null || !candidate.isURI() || plan.current().size() != 1
                || plan.current().contains(work.getURI())
                || !plan.revisions().equals(Set.of(effect.getURI(), candidate.getURI()))) return false;
            return currentPredicates(modify, uri(plan.current().iterator().next()),
                Set.of(rv("proposalHead"), rv("proposalCount"), rv("component"),
                    rv("protectedSlot"), rv("adoptionContext"), RDF.type.asNode()));
        }
        if (plan.current().isEmpty()) return plan.revisions().size() == 1;
        Node control = template(modify.getInsertQuads(), CURRENT, work, rv("titleControlHead"));
        // Review applications use a deterministic one-use identity derived from the proposal.
        Node proposal = template(modify.getInsertQuads(), REVISIONS, effect, rv("proposalRevision"));
        if (proposal == null || !proposal.isURI() || control == null || !control.isURI()) return false;
        String applicationId = "urn:rezics:correction-application:" + sha(proposal.getURI());
        return plan.current().equals(Set.of(work.getURI()))
            && plan.revisions().equals(Set.of(effect.getURI(), control.getURI(), applicationId))
            && currentPredicates(modify, work, Set.of(rv("head"), LABEL, rv("titleControlHead")));
    }

    private static boolean currentPredicates(UpdateModify modify, Node subject, Set<Node> allowed) {
        for (Quad q : modify.getInsertQuads()) if (CURRENT.equals(q.getGraph())
            && (!subject.equals(q.getSubject()) || !allowed.contains(q.getPredicate()))) return false;
        for (Quad q : modify.getDeleteQuads()) if (CURRENT.equals(q.getGraph())
            && (!subject.equals(q.getSubject()) || !allowed.contains(q.getPredicate()))) return false;
        return true;
    }

    private static boolean protectionBasis(DatasetGraph data, UpdateModify modify, String action, Node work,
                                           Node head, Node before, Node control, Node effect) {
        if (!effect.equals(template(modify.getInsertQuads(), CURRENT, work, rv("protectionHead")))) return false;
        Node predecessor = template(modify.getInsertQuads(), REVISIONS, effect, rv("predecessor"));
        Node observed = template(modify.getInsertQuads(), REVISIONS, effect, rv("workRevision"));
        Node mode = template(modify.getInsertQuads(), REVISIONS, effect, rv("protectionMode"));
        Node kind = template(modify.getInsertQuads(), REVISIONS, effect, rv("protectionAction"));
        BigInteger priorEpoch = before == null ? BigInteger.ZERO : number(one(data, REVISIONS, before, rv("protectionEpoch")));
        if (priorEpoch == null || !head.equals(observed) || !work.equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("component")))
            || !(before == null ? predecessor == null : before.equals(predecessor))) return false;
        return switch (action) {
            case "work.protection.tighten" -> rv("Tighten").equals(kind) && rv("ReviewRequired").equals(mode)
                && (before == null || rv("Open").equals(one(data, REVISIONS, before, rv("protectionMode"))));
            case "work.protection.confirm" -> rv("Confirm").equals(kind) && rv("ReviewRequired").equals(mode)
                && (before == null || rv("Open").equals(one(data, REVISIONS, before, rv("protectionMode"))))
                && controlSuccessor(modify, work, head, control,
                    template(modify.getInsertQuads(), CURRENT, work, rv("titleControlHead")), data);
            case "work.protection.relax" -> before != null && rv("Relax").equals(kind) && rv("Open").equals(mode)
                && rv("ReviewRequired").equals(one(data, REVISIONS, before, rv("protectionMode")));
            default -> false;
        };
    }

    private static boolean controlSuccessor(UpdateModify modify, Node work, Node revision, Node before,
                                            Node next, DatasetGraph data) {
        if (next == null || !next.isURI() || data.contains(REVISIONS, next, Node.ANY, Node.ANY)) return false;
        BigInteger prior = before == null ? BigInteger.ZERO : number(one(data, REVISIONS, before, rv("controlEpoch")));
        return prior != null && work.equals(template(modify.getInsertQuads(), REVISIONS, next, rv("component")))
            && revision.equals(template(modify.getInsertQuads(), REVISIONS, next, rv("workRevision")))
            && rv("HumanControlled").equals(template(modify.getInsertQuads(), REVISIONS, next, rv("controlMode")))
            && prior.add(BigInteger.ONE).equals(number(template(modify.getInsertQuads(), REVISIONS, next, rv("controlEpoch"))))
            && (before == null ? template(modify.getInsertQuads(), REVISIONS, next, rv("predecessor")) == null
                : before.equals(template(modify.getInsertQuads(), REVISIONS, next, rv("predecessor"))));
    }

    private static boolean proposalBasis(DatasetGraph data, UpdateModify modify, Node work, Node head,
                                         Node protection, Node control, Node effect) {
        return work.equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("component")))
            && head.equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("baseRevision")))
            && (protection == null ? rv("Absent").equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("baseProtection")))
                : protection.equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("baseProtection"))))
            && (control == null ? rv("Absent").equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("baseControl")))
                : control.equals(template(modify.getInsertQuads(), REVISIONS, effect, rv("baseControl"))));
    }

    private static boolean reviewBasis(DatasetGraph data, UpdateModify modify, Node work, Node head,
                                       Node protection, Node control, Node proposal, Node decision,
                                       String outcome, JsonValue proof) {
        if (!rv("Accepted").getURI().equals(outcome) && !rv("Rejected").getURI().equals(outcome)) return false;
        if (!proposal.equals(template(modify.getInsertQuads(), REVISIONS, decision, rv("proposalRevision")))
            || !rv(rv("Accepted").getURI().equals(outcome) ? "Accepted" : "Rejected")
                .equals(template(modify.getInsertQuads(), REVISIONS, decision, rv("outcome")))
            || !java.util.Objects.equals(one(data, REVISIONS, proposal, rv("candidateDigest")),
                template(modify.getInsertQuads(), REVISIONS, decision, rv("candidateDigest")))
            || !work.equals(one(data, REVISIONS, proposal, rv("component")))
            || !head.equals(one(data, REVISIONS, proposal, rv("baseRevision")))
            || !(protection == null ? rv("Absent").equals(one(data, REVISIONS, proposal, rv("baseProtection")))
                : protection.equals(one(data, REVISIONS, proposal, rv("baseProtection"))))
            || !(control == null ? rv("Absent").equals(one(data, REVISIONS, proposal, rv("baseControl")))
                : control.equals(one(data, REVISIONS, proposal, rv("baseControl"))))) return false;
        Node proposerAdmission = one(data, REVISIONS, proposal, rv("proposalAdmission"));
        JsonArray claims = JSON.parseAny(ProfileRegistry.required(proof.getAsObject(), "payload")).getAsArray();
        if (proposerAdmission == null || !proposerAdmission.isLiteral()
            || !proposerAdmission.getLiteralLexicalForm().equals(claims.get(9).getAsString().value())) return false;
        Node expectedDecision = uri("urn:rezics:correction-decision:" + sha(proposal.getURI()));
        if (!expectedDecision.equals(decision) || data.contains(REVISIONS, decision, Node.ANY, Node.ANY)) return false;
        if (rv("Accepted").getURI().equals(outcome)) {
            Node candidate = one(data, REVISIONS, proposal, rv("candidateRevision"));
            if (candidate == null || !candidate.equals(template(modify.getInsertQuads(), CURRENT, work, rv("head")))) return false;
            Node application = uri("urn:rezics:correction-application:" + sha(proposal.getURI()));
            if (data.contains(REVISIONS, application, Node.ANY, Node.ANY)
                || !proposal.equals(template(modify.getInsertQuads(), REVISIONS, application, rv("proposalRevision")))
                || !decision.equals(template(modify.getInsertQuads(), REVISIONS, application, rv("decision")))
                || !candidate.equals(template(modify.getInsertQuads(), REVISIONS, application, rv("workRevision")))) return false;
            Node successor = template(modify.getInsertQuads(), CURRENT, work, rv("titleControlHead"));
            if (!controlSuccessor(modify, work, candidate, control, successor, data)
                || !successor.equals(template(modify.getInsertQuads(), REVISIONS, application, rv("controlRevision"))))
                return false;
            Node title = template(modify.getInsertQuads(), CURRENT, work, LABEL);
            try {
                JsonObject intent = JSON.parse(text(one(data, REVISIONS, proposal, rv("proposalIntent"))));
                if (title == null || !title.isLiteral() || !title.getLiteralLanguage().equals("en")
                    || !title.getLiteralLexicalForm().equals(ProfileRegistry.required(intent, "title"))) return false;
            } catch (Exception ex) { return false; }
        } else if (template(modify.getInsertQuads(), CURRENT, work, rv("head")) != null) return false;
        return true;
    }

    static String check(DatasetGraph data, String receipt, Snapshot snapshot) {
        if (snapshot == null) return null;
        if (snapshot.error() != null) return snapshot.error();
        if (snapshot.work() == null) return null; // a terminal cancellation changes no Work state
        Node work = snapshot.work(), effect = snapshot.effect();
        if (!data.contains(RECEIPTS, uri(receipt), rv("outcome"), rv("Succeeded"))
            || !data.contains(REVISIONS, effect, RDF.type.asNode(), rv(snapshot.action().startsWith("work.protection.")
                ? "ProtectionRevision" : snapshot.action().equals("work.correction.propose")
                    ? "CorrectionProposal" : "CorrectionDecision"))) return "protection effect is missing";
        if (snapshot.action().startsWith("work.protection.")) {
            if (!effect.equals(one(data, CURRENT, work, rv("protectionHead")))
                || !snapshot.head().equals(one(data, CURRENT, work, rv("head")))) return "protection head poststate differs";
            BigInteger prior = snapshot.protection() == null ? BigInteger.ZERO
                : number(one(data, REVISIONS, snapshot.protection(), rv("protectionEpoch")));
            BigInteger next = number(one(data, REVISIONS, effect, rv("protectionEpoch")));
            if (prior == null || next == null || !next.equals(prior.add(BigInteger.ONE)))
                return "protection epoch did not advance once";
        } else if (snapshot.action().equals("work.correction.propose")) {
            if (!snapshot.head().equals(one(data, CURRENT, work, rv("head")))
                || !java.util.Objects.equals(snapshot.protection(), one(data, CURRENT, work, rv("protectionHead"))))
                return "proposal changed adoption or protection";
        } else if (rv("Accepted").getURI().equals(snapshot.outcome())) {
            Node candidate = one(data, REVISIONS, snapshot.proposal(), rv("candidateRevision"));
            if (candidate == null || !candidate.equals(one(data, CURRENT, work, rv("head")))
                || !java.util.Objects.equals(snapshot.protection(), one(data, CURRENT, work, rv("protectionHead"))))
                return "reviewed application differs from candidate or protection";
        } else if (!snapshot.head().equals(one(data, CURRENT, work, rv("head")))) return "rejection changed adoption";
        return null;
    }

    private static String sha(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (Exception ex) { throw new IllegalStateException(ex); }
    }
    private static Node template(List<Quad> quads, Node graph, Node subject, Node predicate) {
        Node result = null;
        for (Quad q : quads) if (graph.equals(q.getGraph()) && subject.equals(q.getSubject()) && predicate.equals(q.getPredicate())) {
            if (result != null) return null; result = q.getObject();
        }
        return result;
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        if (subject == null) return null;
        var values = data.find(graph, subject, predicate, Node.ANY);
        try { if (!values.hasNext()) return null; Node value = values.next().getObject(); return values.hasNext() ? null : value; }
        finally { org.apache.jena.atlas.iterator.Iter.close(values); }
    }
    private static String text(Node value) { return value != null && value.isLiteral() ? value.getLiteralLexicalForm() : null; }
    private static String uriValue(Node value) { return value != null && value.isURI() ? value.getURI() : null; }
    private static BigInteger number(Node value) { try { return new BigInteger(text(value)); } catch (Exception ex) { return null; } }
    private ProtectionPolicy() {}
}
