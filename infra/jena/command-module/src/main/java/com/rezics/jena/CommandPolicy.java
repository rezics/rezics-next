package com.rezics.jena;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateDataInsert;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.syntax.ElementService;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
import org.apache.jena.update.Update;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.update.UpdateRequest;
import org.apache.jena.vocabulary.RDF;

/** The public command operation admits only bounded, named-graph update templates. */
final class CommandPolicy {
    private static final List<String> MAINTENANCE_RECEIPTS = List.of(
        "urn:rezics:receipt:bootstrap:", "urn:rezics:receipt:restore-cutover:",
        "urn:rezics:receipt:restore-release:", "urn:rezics:receipt:retained-zero:",
        "urn:rezics:receipt:content-rebuild:");
    static final String CONTROL = "urn:rezics:graph:control";
    static final String CURRENT = "urn:rezics:graph:current";
    static final String REVISIONS = "urn:rezics:graph:revisions";
    static final String RECEIPTS = "urn:rezics:graph:receipts";
    static final String OUTBOX = "urn:rezics:graph:outbox";
    static final String PUBLIC_SEARCH = "urn:rezics:search:public";
    static final String PRIVATE_SEARCH = "urn:rezics:search:private";
    static final String PROBE_SEARCH = "urn:rezics:search:probe";
    static final String PUBLIC_ANCHOR = "urn:rezics:search:public:anchor";
    static final Set<String> GRAPHS = Set.of(CONTROL, CURRENT, REVISIONS, RECEIPTS,
        OUTBOX, PUBLIC_SEARCH, PRIVATE_SEARCH, PROBE_SEARCH);

    record Plan(UpdateRequest request, Set<String> graphs, Set<String> current,
        Set<String> revisions, boolean bootstrap, boolean rebuild, boolean hasDelete) {}

    static boolean maintenanceReceipt(String receipt) {
        return MAINTENANCE_RECEIPTS.stream().anyMatch(receipt::startsWith);
    }

    static Plan parse(String text, String receipt) {
        UpdateRequest request;
        try { request = UpdateFactory.create(text); }
        catch (RuntimeException ex) { throw new IllegalArgumentException("invalid SPARQL update", ex); }
        if (request.getOperations().size() != 1) throw new IllegalArgumentException("one update operation required");
        Update operation = request.getOperations().getFirst();
        boolean dataInsert = operation instanceof UpdateDataInsert;
        List<Quad> insert;
        List<Quad> delete;
        if (operation instanceof UpdateModify modify) {
            if (modify.getWithIRI() != null || !modify.getUsing().isEmpty()
                || !modify.getUsingNamed().isEmpty()) throw new IllegalArgumentException("WITH/USING not admitted");
            ElementWalker.walk(modify.getWherePattern(), new ElementVisitorBase() {
                @Override public void visit(ElementService service) {
                    throw new IllegalArgumentException("SERVICE not admitted");
                }
            });
            insert = modify.getInsertQuads();
            delete = modify.getDeleteQuads();
        } else if (operation instanceof UpdateDataInsert data) {
            insert = data.getQuads();
            delete = List.of();
        } else throw new IllegalArgumentException("update operation not admitted");
        if (insert.isEmpty()) throw new IllegalArgumentException("empty insert not admitted");
        Set<String> graphs = new LinkedHashSet<>();
        Set<String> current = new LinkedHashSet<>();
        Set<String> revisions = new LinkedHashSet<>();
        List<Quad> all = new ArrayList<>(insert);
        all.addAll(delete);
        for (Quad quad : all) {
            Node graph = quad.getGraph();
            if (!graph.isURI() || !GRAPHS.contains(graph.getURI()))
                throw new IllegalArgumentException("write graph not admitted");
            String name = graph.getURI();
            graphs.add(name);
            Node subject = quad.getSubject();
            if ((name.equals(CURRENT) || name.equals(REVISIONS))
                && !subject.isURI()) throw new IllegalArgumentException("variable data subject not admitted");
            if (name.equals(CURRENT)) current.add(subject.getURI());
            if (name.equals(REVISIONS)) revisions.add(subject.getURI());
            if (name.equals(RECEIPTS) && (!subject.isURI() || !receipt.equals(subject.getURI())))
                throw new IllegalArgumentException("command may write only its own receipt");
        }
        if (delete.stream().anyMatch(quad -> RECEIPTS.equals(quad.getGraph().getURI())))
            throw new IllegalArgumentException("receipt deletion not admitted");
        if (insert.stream().noneMatch(quad -> RECEIPTS.equals(quad.getGraph().getURI())
            && quad.getSubject().isURI() && receipt.equals(quad.getSubject().getURI())))
            throw new IllegalArgumentException("receipt insertion required");
        boolean bootstrap = receipt.startsWith("urn:rezics:receipt:bootstrap:")
            && graphs.stream().allMatch(name -> Set.of(CONTROL, RECEIPTS, PUBLIC_SEARCH, PROBE_SEARCH).contains(name));
        boolean rebuild = receipt.startsWith("urn:rezics:receipt:content-rebuild:");
        if (dataInsert && !bootstrap) throw new IllegalArgumentException("unguarded INSERT DATA not admitted");
        if (graphs.contains(PROBE_SEARCH) && !bootstrap)
            throw new IllegalArgumentException("search probe graph is bootstrap only");
        if (graphs.contains(PUBLIC_SEARCH) && !bootstrap && !rebuild && current.isEmpty() && revisions.isEmpty())
            throw new IllegalArgumentException("search projection requires a product change");
        if (graphs.contains(PRIVATE_SEARCH) && (bootstrap || rebuild || current.isEmpty() || revisions.isEmpty()))
            throw new IllegalArgumentException("private projection requires a product revision change");
        if (rebuild) {
            String family = receipt.substring("urn:rezics:receipt:content-rebuild:".length());
            if (!family.matches("(quarantine|clear|cleared|activate):[0-9a-f]{64}"))
                throw new IllegalArgumentException("unknown rebuild receipt family");
            if (!graphs.stream().allMatch(name -> Set.of(CONTROL, RECEIPTS, OUTBOX, PUBLIC_SEARCH).contains(name))
                || !graphs.contains(CONTROL) || !graphs.contains(RECEIPTS) || !graphs.contains(OUTBOX)
                || !current.isEmpty() || !revisions.isEmpty())
                throw new IllegalArgumentException("rebuild writes only control, receipt, outbox and public index");
            List<Quad> publicInserts = insert.stream()
                .filter(quad -> PUBLIC_SEARCH.equals(quad.getGraph().getURI())).toList();
            if (family.startsWith("activate:")) {
                if (publicInserts.size() != 1 || !isPublicAnchor(publicInserts.getFirst()))
                    throw new IllegalArgumentException("activation may insert only the public search anchor");
            } else if (!publicInserts.isEmpty())
                throw new IllegalArgumentException("rebuild may only remove public index triples before activation");
            List<Quad> publicDeletes = delete.stream()
                .filter(quad -> PUBLIC_SEARCH.equals(quad.getGraph().getURI())).toList();
            if (family.startsWith("quarantine:") && (publicDeletes.size() != 1
                || !isPublicAnchor(publicDeletes.getFirst())))
                throw new IllegalArgumentException("quarantine must remove only the public search anchor");
            if ((family.startsWith("cleared:") || family.startsWith("activate:")) && !publicDeletes.isEmpty())
                throw new IllegalArgumentException("cleared or activation receipt cannot remove index triples");
            if (family.startsWith("clear:") && publicDeletes.isEmpty())
                throw new IllegalArgumentException("clear receipt must remove indexed triples");
            if (family.startsWith("clear:") && (publicDeletes.size() > 64
                || publicDeletes.stream().anyMatch(quad -> !quad.getSubject().isURI()
                    || !quad.getSubject().getURI().startsWith("urn:rezics:content:match-unit:"))))
                throw new IllegalArgumentException("cleanup requires at most 64 explicit Content unit subjects");
        }
        if (current.size() + revisions.size() > 100 || all.size() > 5_000)
            throw new IllegalArgumentException("update footprint too large");
        return new Plan(request, Set.copyOf(graphs), Set.copyOf(current),
            Set.copyOf(revisions), bootstrap, rebuild, !delete.isEmpty());
    }

    private static boolean isPublicAnchor(Quad quad) {
        return quad.getSubject().isURI() && PUBLIC_ANCHOR.equals(quad.getSubject().getURI())
            && RDF.type.asNode().equals(quad.getPredicate())
            && NodeFactory.createURI("https://rezics.com/vocab/SearchGraphAnchor").equals(quad.getObject());
    }

    private CommandPolicy() {}
}
