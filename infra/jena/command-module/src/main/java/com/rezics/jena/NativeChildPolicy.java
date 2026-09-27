package com.rezics.jena;

import java.util.List;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.vocabulary.RDF;

/** One field-keyed child or retirement per signed Work edit; no source key is a native identity. */
final class NativeChildPolicy {
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node rv(String name) { return uri("https://rezics.com/vocab/" + name); }
    private static final Node CURRENT = uri(CommandPolicy.CURRENT), REVISIONS = uri(CommandPolicy.REVISIONS),
        RECEIPTS = uri(CommandPolicy.RECEIPTS), CONTROL = uri(CommandPolicy.CONTROL),
        DATASET = uri("urn:rezics:dataset:product");
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var values = data.find(graph, subject, predicate, Node.ANY);
        try { if (!values.hasNext()) return null; Node value = values.next().getObject();
            return values.hasNext() ? null : value; }
        finally { org.apache.jena.atlas.iterator.Iter.close(values); }
    }
    private static Node template(List<Quad> quads, Node graph, Node subject, Node predicate) {
        Node value = null;
        for (Quad quad : quads) if (graph.equals(quad.getGraph()) && subject.equals(quad.getSubject())
            && predicate.equals(quad.getPredicate())) {
            if (value != null) return null; value = quad.getObject();
        }
        return value;
    }
    static String preflight(DatasetGraph data, CommandPolicy.Plan plan, String receipt, String digest,
                            String update, org.apache.jena.atlas.json.JsonValue proof, byte[] key) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        Node target = null, retiredBy = null;
        for (Quad quad : modify.getInsertQuads()) if (CURRENT.equals(quad.getGraph())) {
            if (RDF.type.asNode().equals(quad.getPredicate()) && rv("NativeChild").equals(quad.getObject())) {
                if (target != null) return "one native child required";
                target = quad.getSubject();
            }
            if (rv("retiredBy").equals(quad.getPredicate())
                && data.contains(CURRENT, quad.getSubject(), RDF.type.asNode(), rv("NativeChild"))) {
                if (retiredBy != null) return "one native child retirement required";
                target = quad.getSubject(); retiredBy = quad.getObject();
            }
        }
        for (String subject : plan.current()) if (data.contains(CURRENT, uri(subject), RDF.type.asNode(), rv("NativeChild"))
            && (retiredBy == null || !uri(subject).equals(target))) return "native child is immutable";
        for (String subject : plan.revisions()) if (data.contains(REVISIONS, uri(subject), RDF.type.asNode(), rv("NativeChildRevision")))
            return "native child revision is immutable";
        if (target == null) return null;
        try {
            Node own = uri(receipt);
            Node work = template(modify.getInsertQuads(), RECEIPTS, own, rv("work"));
            Node head = template(modify.getInsertQuads(), RECEIPTS, own, rv("expectedHead"));
            Node scope = template(modify.getInsertQuads(), RECEIPTS, own, rv("admittedScope"));
            Node revision = retiredBy == null ? template(modify.getInsertQuads(), RECEIPTS, own, rv("nativeChildRevision"))
                : one(data, CURRENT, target, rv("childRevision"));
            boolean recovery = data.contains(CONTROL, DATASET, rv("restoreHold"),
                NodeFactory.createLiteralByValue(true, org.apache.jena.datatypes.xsd.XSDDatatype.XSDboolean))
                && plan.graphs().contains(CommandPolicy.CONTROL)
                && modify.getInsertQuads().stream().anyMatch(q -> CONTROL.equals(q.getGraph())
                    && rv("reconciledPriorSequence").equals(q.getPredicate()));
            if (work == null || !work.isURI() || head == null || !head.isURI() || scope == null || !scope.isLiteral()
                || !scope.getLiteralLexicalForm().equals("work:edit:" + work.getURI())
                || !head.equals(one(data, CURRENT, work, rv("head")))
                || !head.equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("workRevision")))
                || !target.equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("nativeChild")))
                || revision == null || !revision.equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("nativeChildRevision")))
                || !rv("Succeeded").equals(template(modify.getInsertQuads(), RECEIPTS, own, rv("outcome")))
                || data.contains(CURRENT, work, rv("protectionHead"), Node.ANY)
                || !(recovery || EditorialFieldPolicy.admitted(modify, receipt, digest, update, proof, key, work)))
                return "native child Work basis or signed admission differs";
            if (retiredBy != null) {
                if (!retiredBy.equals(own) || !plan.current().equals(java.util.Set.of(target.getURI()))
                    || !plan.revisions().isEmpty() || data.contains(CURRENT, target, rv("retiredBy"), Node.ANY)
                    || !work.equals(one(data, CURRENT, target, rv("work"))))
                    return "native child retirement target differs";
                for (Quad quad : modify.getDeleteQuads()) if (CURRENT.equals(quad.getGraph())
                    || REVISIONS.equals(quad.getGraph())) return "retirement rewrites native history";
                for (Quad quad : modify.getInsertQuads()) if (CURRENT.equals(quad.getGraph())
                    && !(target.equals(quad.getSubject()) && rv("retiredBy").equals(quad.getPredicate())
                        && own.equals(quad.getObject()))) return "retirement has unrelated native mutation";
            } else {
                if (!revision.isURI() || !plan.current().equals(java.util.Set.of(target.getURI()))
                    || !plan.revisions().equals(java.util.Set.of(revision.getURI()))
                    || data.contains(CURRENT, target, Node.ANY, Node.ANY)
                    || data.contains(REVISIONS, revision, Node.ANY, Node.ANY)
                    || !revision.equals(template(modify.getInsertQuads(), CURRENT, target, rv("childRevision")))
                    || !target.equals(template(modify.getInsertQuads(), REVISIONS, revision, rv("component")))
                    || !work.equals(template(modify.getInsertQuads(), CURRENT, target, rv("work")))
                    || !work.equals(template(modify.getInsertQuads(), REVISIONS, revision, rv("work")))
                    || !head.equals(template(modify.getInsertQuads(), REVISIONS, revision, rv("workRevision")))
                    || !template(modify.getInsertQuads(), CURRENT, target, rv("childField"))
                        .equals(template(modify.getInsertQuads(), REVISIONS, revision, rv("childField")))
                    || !template(modify.getInsertQuads(), CURRENT, target, rv("sourceKey"))
                        .equals(template(modify.getInsertQuads(), REVISIONS, revision, rv("sourceKey"))))
                    return "native child or revision identity differs";
                for (Quad quad : modify.getDeleteQuads()) if (CURRENT.equals(quad.getGraph())
                    || REVISIONS.equals(quad.getGraph())) return "native child creation rewrites history";
            }
            return null;
        } catch (Exception ex) { return "invalid native child admission or basis"; }
    }
    static String check(DatasetGraph data, CommandPolicy.Plan plan) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)) return null;
        for (Quad quad : modify.getInsertQuads()) if (CURRENT.equals(quad.getGraph())
            && rv("retiredBy").equals(quad.getPredicate())
            && data.contains(CURRENT, quad.getSubject(), RDF.type.asNode(), rv("NativeChild"))
            && !data.contains(CURRENT, quad.getSubject(), rv("retiredBy"), quad.getObject()))
            return "native child retirement marker was not committed";
        return null;
    }
    private NativeChildPolicy() {}
}
