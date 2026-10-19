package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;
import java.util.List;
import java.util.HashSet;
import java.util.Set;

/** Credit occurrences stay immutable; retirement and retained compatibility
 * heads have separate, exact metadata operations, never credit-field edits. */
final class AuthorCreditPolicy {
    private static final Node RETAINED = uri("https://rezics.com/definition/retained-credit-associations-v1");
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
        try { if (!values.hasNext()) return null; Node value = values.next().getObject();
            return values.hasNext() ? null : value; }
        finally { org.apache.jena.atlas.iterator.Iter.close(values); }
    }
    private static Node template(List<Quad> quads, Node graph, Node subject, Node predicate) {
        Node value = null;
        for (Quad quad : quads) if (quad.getGraph().equals(graph) && quad.getSubject().equals(subject)
            && quad.getPredicate().equals(predicate)) {
            if (value != null) return null;
            value = quad.getObject();
        }
        return value;
    }
    private static boolean credit(DatasetGraph data, Node graph, Node subject) {
        return data.contains(graph, subject, RDF.type.asNode(), rv("AuthorCredit"))
            || data.contains(graph, subject, RDF.type.asNode(), rv("NativeAgentCredit"));
    }
    private static String retirement(DatasetGraph data, CommandPolicy.Plan plan, UpdateModify modify) {
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS),
            receipts = uri(CommandPolicy.RECEIPTS);
        Node credit = null, receipt = null;
        for (Quad quad : modify.getInsertQuads()) if (current.equals(quad.getGraph())
            && rv("retiredBy").equals(quad.getPredicate())) {
            if (credit != null) return "one author credit retirement required";
            credit = quad.getSubject(); receipt = quad.getObject();
        }
        if (credit == null) return null;
        if (!credit.isURI() || !receipt.isURI() || plan.current().size() != 1
            || !plan.current().contains(credit.getURI()) || !plan.revisions().isEmpty()
            || data.contains(current, credit, rv("retiredBy"), Node.ANY)
            || !credit(data, current, credit))
            return "author credit retirement target differs";
        for (Quad quad : modify.getDeleteQuads()) if (current.equals(quad.getGraph())
            || revisions.equals(quad.getGraph())) return "retirement cannot rewrite native history";
        for (Quad quad : modify.getInsertQuads()) if (current.equals(quad.getGraph())
            && !(credit.equals(quad.getSubject()) && rv("retiredBy").equals(quad.getPredicate())
                && receipt.equals(quad.getObject()))) return "retirement has unrelated native mutation";
        Node work = one(data, current, credit, rv("work"));
        Node revision = one(data, current, credit, rv("creditRevision"));
        Node head = work == null ? null : one(data, current, work, rv("head"));
        Node expected = template(modify.getInsertQuads(), receipts, receipt, rv("expectedHead"));
        Node reason = template(modify.getInsertQuads(), receipts, receipt, rv("retirementReason"));
        Node scope = template(modify.getInsertQuads(), receipts, receipt, rv("admittedScope"));
        if (work == null || revision == null || head == null || expected == null || !expected.isURI()
            || reason == null || !reason.isLiteral()
            || reason.getLiteralLexicalForm().isBlank() || reason.getLiteralLexicalForm().length() > 500
            || scope == null || !scope.isLiteral()
            || !scope.getLiteralLexicalForm().equals("work:edit:" + work.getURI())
            || data.contains(current, work, rv("protectionHead"), Node.ANY)
            || !credit.equals(template(modify.getInsertQuads(), receipts, receipt, rv("authorCredit")))
            || !revision.equals(template(modify.getInsertQuads(), receipts, receipt, rv("creditRevision")))
            || !work.equals(template(modify.getInsertQuads(), receipts, receipt, rv("work")))
            || !expected.equals(template(modify.getInsertQuads(), receipts, receipt, rv("workRevision")))
            || !rv("Succeeded").equals(template(modify.getInsertQuads(), receipts, receipt, rv("outcome"))))
            return "author credit retirement receipt or Work basis differs";
        return null;
    }

    /** Admit only the existing retained-binding writer's metadata footprint.
     * The original native credit/revision/receipt are still validated by their
     * installed profile. No predicate or type of that occurrence is rewritten. */
    private static String retainedAssociation(DatasetGraph data, CommandPolicy.Plan plan, UpdateModify modify) {
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS), receipts = uri(CommandPolicy.RECEIPTS);
        var pointers = modify.getInsertQuads().stream().filter(q -> current.equals(q.getGraph())
            && rv("associationHead").equals(q.getPredicate())).toList();
        if (pointers.size() != 1) return "one retained credit association head required";
        Node credit = pointers.getFirst().getSubject(), head = pointers.getFirst().getObject();
        if (!credit.isURI() || !head.isURI() || !credit(data, current, credit)
            || !plan.current().equals(Set.of(credit.getURI()))) return "retained credit target differs";
        for (Quad quad : modify.getInsertQuads()) if (current.equals(quad.getGraph()) && !quad.equals(pointers.getFirst()))
            return "retained association cannot rewrite native credit fields";
        var deletes = modify.getDeleteQuads().stream().filter(q -> current.equals(q.getGraph())).toList();
        if (deletes.size() > 1 || deletes.stream().anyMatch(q -> !credit.equals(q.getSubject())
            || !rv("associationHead").equals(q.getPredicate()) || !q.getObject().isURI())
            || modify.getDeleteQuads().stream().anyMatch(q -> revisions.equals(q.getGraph())))
            return "retained association cannot rewrite native history";
        Node predecessor = template(modify.getInsertQuads(), revisions, head, rv("predecessor"));
        if (deletes.isEmpty() ? predecessor != null : !deletes.getFirst().getObject().equals(predecessor))
            return "retained credit predecessor differs";
        Node actual = one(data, current, credit, rv("associationHead"));
        if (actual == null && data.contains(current, credit, rv("associationHead"), Node.ANY))
            return "retained credit head is ambiguous";
        if (!java.util.Objects.equals(actual, predecessor)) return "retained credit expected head differs";
        if (data.contains(revisions, head, Node.ANY, Node.ANY)) return "retained credit view is immutable";
        Node work = one(data, current, credit, rv("work")), revision = one(data, current, credit, rv("creditRevision"));
        if (work == null || revision == null || !work.isURI() || !revision.isURI()
            || data.contains(current, credit, rv("retiredBy"), Node.ANY)
            || data.contains(current, credit, rv("protectionHead"), Node.ANY)
            || data.contains(current, work, rv("protectionHead"), Node.ANY)
            || data.contains(revisions, revision, RDF.type.asNode(), rv("ErasedRevision")))
            return "retained credit original is unavailable";
        var seals = modify.getInsertQuads().stream().filter(q -> receipts.equals(q.getGraph())
            && rv("compatibilityProfile").equals(q.getPredicate()) && RETAINED.equals(q.getObject())).toList();
        if (seals.size() != 1) return "retained credit compatibility receipt required";
        Node receipt = seals.getFirst().getSubject();
        Node operation = template(modify.getInsertQuads(), revisions, head, rv("operation"));
        Node manifest = template(modify.getInsertQuads(), revisions, head, rv("manifest"));
        Node generation = template(modify.getInsertQuads(), revisions, head, rv("modelGeneration"));
        Node scope = template(modify.getInsertQuads(), receipts, receipt, rv("admittedScope"));
        if (operation == null || !operation.isURI() || manifest == null || !manifest.isURI()
            || !manifest.getURI().matches("urn:rezics:sha256:[0-9a-f]{64}") || generation == null
            || !generation.equals(one(data, current, uri("urn:rezics:model:product"), rv("generationHead")))
            || scope == null || !scope.isLiteral() || !scope.getLiteralLexicalForm().equals("work:edit:" + work.getURI())
            || !credit.equals(template(modify.getInsertQuads(), receipts, receipt, rv("component")))
            || !head.equals(template(modify.getInsertQuads(), receipts, receipt, rv("revision")))
            || !operation.equals(template(modify.getInsertQuads(), receipts, receipt, rv("operation")))
            || !rv("Succeeded").equals(template(modify.getInsertQuads(), receipts, receipt, rv("outcome")))
            || !java.util.Objects.equals(predecessor, template(modify.getInsertQuads(), receipts, receipt, rv("expectedHead"))))
            return "retained credit receipt or model basis differs";
        for (var field : java.util.Map.of("component", credit, "work", work, "creditRevision", revision,
            "modelRevision", RETAINED, "shapeRevision", RETAINED).entrySet())
            if (!field.getValue().equals(template(modify.getInsertQuads(), revisions, head, rv(field.getKey()))))
                return "retained credit view basis differs";
        Set<Node> participants = new HashSet<>();
        for (Quad quad : modify.getInsertQuads()) if (revisions.equals(quad.getGraph())
            && head.equals(quad.getSubject()) && rv("participation").equals(quad.getPredicate())) participants.add(quad.getObject());
        if (participants.size() != 2 || participants.stream().anyMatch(p -> !p.isURI() || p.equals(credit) || p.equals(head)))
            return "retained credit participation allocation differs";
        Set<Node> priorParticipants = new HashSet<>();
        if (predecessor != null) {
            if (!data.contains(revisions, predecessor, rv("component"), credit)
                || !data.contains(revisions, predecessor, RDF.type.asNode(), rv("RetainedCreditAssociationRevision")))
                return "retained credit predecessor identity differs";
            var values = data.find(revisions, predecessor, rv("participation"), Node.ANY);
            try { values.forEachRemaining(q -> priorParticipants.add(q.getObject())); }
            finally { org.apache.jena.atlas.iterator.Iter.close(values); }
            if (!priorParticipants.equals(participants)) return "retained credit participation allocation changed";
        }
        var subjects = new HashSet<String>(); subjects.add(head.getURI());
        participants.forEach(p -> subjects.add(p.getURI()));
        if (!plan.revisions().equals(subjects)) return "retained credit revision footprint differs";
        Set<Node> headFields = Set.of(RDF.type.asNode(), rv("component"), rv("work"), rv("creditRevision"), rv("predecessor"),
            rv("operation"), rv("manifest"), rv("modelGeneration"), rv("modelRevision"), rv("shapeRevision"),
            rv("participation"), rv("datasetId"), rv("dataEpoch"), rv("sequence"));
        for (Quad quad : modify.getInsertQuads()) if (revisions.equals(quad.getGraph())) {
            if (head.equals(quad.getSubject())) {
                if (!headFields.contains(quad.getPredicate()) || RDF.type.asNode().equals(quad.getPredicate())
                    && !Set.of(rv("RetainedCreditAssociationRevision"), rv("RevisionAnchor")).contains(quad.getObject()))
                    return "retained credit view has unrelated mutation";
            } else if (!participants.contains(quad.getSubject()) || !(rv("occurrence").equals(quad.getPredicate())
                && credit.equals(quad.getObject()) || RDF.type.asNode().equals(quad.getPredicate())
                && rv("RetainedCreditParticipation").equals(quad.getObject())))
                return "retained credit participation has unrelated mutation";
        }
        for (Node type : List.of(rv("RetainedCreditAssociationRevision"), rv("RevisionAnchor")))
            if (!modify.getInsertQuads().contains(new Quad(revisions, head, RDF.type.asNode(), type)))
                return "retained credit view type differs";
        for (Node participant : participants) {
            if (!modify.getInsertQuads().contains(new Quad(revisions, participant, RDF.type.asNode(), rv("RetainedCreditParticipation")))
                || !modify.getInsertQuads().contains(new Quad(revisions, participant, rv("occurrence"), credit)))
                return "retained credit participation identity differs";
            if (data.contains(revisions, participant, Node.ANY, Node.ANY)
                && (!priorParticipants.contains(participant) || !data.contains(revisions, participant, rv("occurrence"), credit)))
                return "retained credit participation already belongs to another view";
        }
        return null;
    }
    static String preflight(DatasetGraph data, CommandPolicy.Plan plan) {
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
        if (plan.request().getOperations().getFirst() instanceof UpdateModify modify) {
            boolean retirement = modify.getInsertQuads().stream().anyMatch(quad ->
                current.equals(quad.getGraph()) && rv("retiredBy").equals(quad.getPredicate())
                && credit(data, current, quad.getSubject()));
            if (retirement) return retirement(data, plan, modify);
            boolean association = modify.getInsertQuads().stream().anyMatch(quad -> current.equals(quad.getGraph())
                && rv("associationHead").equals(quad.getPredicate()) && credit(data, current, quad.getSubject()));
            if (association) return retainedAssociation(data, plan, modify);
        }
        for (String subject : plan.current()) if (credit(data, current, uri(subject)))
            return "author credit is immutable";
        for (String subject : plan.revisions()) if ((data.contains(revisions, uri(subject), RDF.type.asNode(), rv("AuthorCreditRevision"))
            || data.contains(revisions, uri(subject), RDF.type.asNode(), rv("NativeAgentCreditRevision"))))
            return "author credit revision is immutable";
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node work = null, head = null;
        boolean credit = false;
        for (var quad : modify.getInsertQuads()) {
            if (current.equals(quad.getGraph()) && RDF.type.asNode().equals(quad.getPredicate())
                && rv("AuthorCredit").equals(quad.getObject())) credit = true;
            if (CommandPolicy.RECEIPTS.equals(quad.getGraph().getURI())) {
                if (rv("work").equals(quad.getPredicate())) work = quad.getObject();
                if (rv("expectedHead").equals(quad.getPredicate())) head = quad.getObject();
            }
        }
        if (!credit) return null;
        if (work == null || head == null || !work.isURI() || !head.isURI())
            return "author credit Work basis is incomplete";
        // Initial catalogue attribution shares the transaction that creates its
        // Work. Subsequent assertions must name the existing exact Work head.
        boolean createsWork = modify.getInsertQuads().stream().anyMatch(quad ->
            uri(CommandPolicy.RECEIPTS).equals(quad.getGraph())
            && rv("commandFamily").equals(quad.getPredicate()) && quad.getObject().isLiteral()
            && "work-catalogue-import-v1".equals(quad.getObject().getLiteralLexicalForm()));
        if (createsWork) {
            Node insertedWork = work, insertedHead = head;
            if (!modify.getInsertQuads().contains(new Quad(current, insertedWork, RDF.type.asNode(), uri("https://schema.org/CreativeWork")))
                || !modify.getInsertQuads().contains(new Quad(current, insertedWork, rv("head"), insertedHead)))
                return "initial credit Work basis differs";
        } else if (!data.contains(current, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
            || !data.contains(current, work, rv("head"), head)
            || data.contains(current, work, rv("protectionHead"), Node.ANY))
            return "author credit Work head or protection differs";
        for (String subject : plan.current()) if (data.contains(current, uri(subject), Node.ANY, Node.ANY))
            return "author credit requires a fresh current subject";
        for (String subject : plan.revisions()) if (data.contains(revisions, uri(subject), Node.ANY, Node.ANY))
            return "author credit requires a fresh revision";
        if (!createsWork && (plan.current().size() != 1 || plan.revisions().size() != 1))
            return "author credit footprint differs";
        return null;
    }
    static String check(DatasetGraph data, CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node current = uri(CommandPolicy.CURRENT);
        for (Quad quad : modify.getInsertQuads()) if (current.equals(quad.getGraph())
            && rv("retiredBy").equals(quad.getPredicate())) {
            if (!data.contains(current, quad.getSubject(), rv("retiredBy"), quad.getObject()))
                return "author credit retirement marker was not committed";
        }
        return null;
    }
    private AuthorCreditPolicy() {}
}
