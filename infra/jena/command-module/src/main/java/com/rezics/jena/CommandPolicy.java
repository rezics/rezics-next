package com.rezics.jena;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.sparql.core.Quad;
import org.apache.jena.sparql.modify.request.UpdateDataInsert;
import org.apache.jena.sparql.modify.request.UpdateModify;
import org.apache.jena.sparql.syntax.ElementService;
import org.apache.jena.sparql.syntax.ElementVisitorBase;
import org.apache.jena.sparql.syntax.ElementWalker;
import org.apache.jena.update.Update;
import org.apache.jena.update.UpdateFactory;
import org.apache.jena.update.UpdateRequest;

/** The public command operation admits only bounded, named-graph update templates. */
final class CommandPolicy {
    private static final List<String> MAINTENANCE_RECEIPTS = List.of(
        "urn:rezics:receipt:bootstrap:", "urn:rezics:receipt:restore-cutover:",
        "urn:rezics:receipt:restore-release:", "urn:rezics:receipt:retained-zero:");
    static final String CONTROL = "urn:rezics:graph:control";
    static final String CURRENT = "urn:rezics:graph:current";
    static final String REVISIONS = "urn:rezics:graph:revisions";
    static final String RECEIPTS = "urn:rezics:graph:receipts";
    static final String OUTBOX = "urn:rezics:graph:outbox";
    static final String PUBLIC_SEARCH = "urn:rezics:search:public";
    static final String PROBE_SEARCH = "urn:rezics:search:probe";
    static final Set<String> GRAPHS = Set.of(CONTROL, CURRENT, REVISIONS, RECEIPTS,
        OUTBOX, PUBLIC_SEARCH, PROBE_SEARCH);

    record Plan(UpdateRequest request, Set<String> graphs, Set<String> current,
        Set<String> revisions, boolean bootstrap, boolean hasDelete) {}

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
        if (dataInsert && !bootstrap) throw new IllegalArgumentException("unguarded INSERT DATA not admitted");
        if (graphs.contains(PROBE_SEARCH) && !bootstrap)
            throw new IllegalArgumentException("search probe graph is bootstrap only");
        if (graphs.contains(PUBLIC_SEARCH) && !bootstrap && current.isEmpty() && revisions.isEmpty())
            throw new IllegalArgumentException("search projection requires a product change");
        if (current.size() + revisions.size() > 100 || all.size() > 5_000)
            throw new IllegalArgumentException("update footprint too large");
        return new Plan(request, Set.copyOf(graphs), Set.copyOf(current),
            Set.copyOf(revisions), bootstrap, !delete.isEmpty());
    }

    private CommandPolicy() {}
}
