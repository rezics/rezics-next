package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;
import java.util.List;

/** This profile only creates immutable occurrences. No refresh can mutate an old credit. */
final class AuthorCreditPolicy {
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
            || !data.contains(current, credit, RDF.type.asNode(), rv("AuthorCredit")))
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
    static String preflight(DatasetGraph data, CommandPolicy.Plan plan) {
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
        if (plan.request().getOperations().getFirst() instanceof UpdateModify modify) {
            boolean retirement = modify.getInsertQuads().stream().anyMatch(quad ->
                current.equals(quad.getGraph()) && rv("retiredBy").equals(quad.getPredicate())
                && data.contains(current, quad.getSubject(), RDF.type.asNode(), rv("AuthorCredit")));
            if (retirement) return retirement(data, plan, modify);
        }
        for (String subject : plan.current()) if (data.contains(current, uri(subject), RDF.type.asNode(), rv("AuthorCredit")))
            return "author credit is immutable";
        for (String subject : plan.revisions()) if (data.contains(revisions, uri(subject), RDF.type.asNode(), rv("AuthorCreditRevision")))
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
        if (work == null || head == null || !work.isURI() || !head.isURI()
            || !data.contains(current, work, RDF.type.asNode(), uri("https://schema.org/CreativeWork"))
            || !data.contains(current, work, rv("head"), head)
            || data.contains(current, work, rv("protectionHead"), Node.ANY))
            return "author credit Work head or protection differs";
        for (String subject : plan.current()) if (data.contains(current, uri(subject), Node.ANY, Node.ANY))
            return "author credit requires a fresh current subject";
        for (String subject : plan.revisions()) if (data.contains(revisions, uri(subject), Node.ANY, Node.ANY))
            return "author credit requires a fresh revision";
        if (plan.current().size() != 1 || plan.revisions().size() != 1)
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
