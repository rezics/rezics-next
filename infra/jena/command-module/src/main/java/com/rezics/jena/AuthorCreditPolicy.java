package com.rezics.jena;

import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** This profile only creates immutable occurrences. No refresh can mutate an old credit. */
final class AuthorCreditPolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    static String preflight(DatasetGraph data, CommandPolicy.Plan plan) {
        Node current = uri(CommandPolicy.CURRENT), revisions = uri(CommandPolicy.REVISIONS);
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
    private AuthorCreditPolicy() {}
}
