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
        "urn:rezics:name-migration:",
        "urn:rezics:receipt:bootstrap:", "urn:rezics:receipt:restore-cutover:",
        "urn:rezics:receipt:restore-release:", "urn:rezics:receipt:retained-zero:",
        "urn:rezics:receipt:content-rebuild:", "urn:rezics:receipt:chapter-search-index:",
        "urn:rezics:receipt:catalogue-search-index:");
    static final String CONTROL = "urn:rezics:graph:control";
    static final String CURRENT = "urn:rezics:graph:current";
    static final String REVISIONS = "urn:rezics:graph:revisions";
    static final String SOURCE = "urn:rezics:graph:source";
    static final String RECEIPTS = "urn:rezics:graph:receipts";
    static final String OUTBOX = "urn:rezics:graph:outbox";
    static final String PUBLIC_SEARCH = "urn:rezics:search:public";
    static final String PRIVATE_SEARCH = "urn:rezics:search:private";
    static final String PROBE_SEARCH = "urn:rezics:search:probe";
    static final String PUBLIC_ANCHOR = "urn:rezics:search:public:anchor";
    private static final String RV = "https://rezics.com/vocab/";
    private static final String PRODUCT = "urn:rezics:dataset:product";
    static final Set<String> GRAPHS = Set.of(CONTROL, CURRENT, REVISIONS, SOURCE, RECEIPTS,
        OUTBOX, PUBLIC_SEARCH, PRIVATE_SEARCH, PROBE_SEARCH);

    record Plan(UpdateRequest request, Set<String> graphs, Set<String> current,
        Set<String> revisions, Set<String> source, boolean bootstrap, boolean rebuild, boolean hasDelete) {}

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
        Set<String> source = new LinkedHashSet<>();
        List<Quad> all = new ArrayList<>(insert);
        all.addAll(delete);
        for (Quad quad : all) {
            Node graph = quad.getGraph();
            if (!graph.isURI() || !GRAPHS.contains(graph.getURI()))
                throw new IllegalArgumentException("write graph not admitted");
            String name = graph.getURI();
            // Stream positions are stamped by the command service after validation,
            // in the same transaction. Caller templates cannot forge their watermark.
            if (Set.of(CONTROL, OUTBOX).contains(name)
                && (!quad.getPredicate().isURI()
                    || Set.of(RV + "streamScope", RV + "streamSequence", RV + "legacyThroughSequence")
                        .contains(quad.getPredicate().getURI())))
                throw new IllegalArgumentException("relay stream fields are server-owned");
            if (CONTROL.equals(name) && (!quad.getSubject().isURI()
                || CommandInvariant.MAIN_STREAM_SCOPE.equals(quad.getSubject().getURI())))
                throw new IllegalArgumentException("relay stream record is server-owned");
            graphs.add(name);
            Node subject = quad.getSubject();
            if ((name.equals(CURRENT) || name.equals(REVISIONS))
                && !subject.isURI()) throw new IllegalArgumentException("variable data subject not admitted");
            if (name.equals(CURRENT)) current.add(subject.getURI());
            if (name.equals(REVISIONS)) revisions.add(subject.getURI());
            if (name.equals(SOURCE)) {
                if (!subject.isURI()) throw new IllegalArgumentException("variable source subject not admitted");
                source.add(subject.getURI());
            }
            if (name.equals(RECEIPTS) && (!subject.isURI() || !receipt.equals(subject.getURI())
                && !StatementUpgradePolicy.retiringReceipt(receipt) && !StatementUpgradePolicy.restoringReceipt(receipt)))
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
        boolean analyzerProfile = receipt.matches("urn:rezics:receipt:content-rebuild:profile:[0-9a-f]{64}");
        boolean chapterBackfill = receipt.matches("urn:rezics:receipt:chapter-search-index:[0-9a-f]{64}");
        boolean catalogueBackfill = receipt.matches("urn:rezics:receipt:catalogue-search-index:[0-9a-f]{64}");
        boolean sourceProjection = receipt.matches("urn:rezics:receipt:source-projection:[0-9a-f]{64}");
        if (graphs.contains(SOURCE) != sourceProjection) {
            throw new IllegalArgumentException("source graph requires its fixed receipt family");
        }
        if (sourceProjection && (source.size() < 4 || source.size() > 5
            || !graphs.equals(Set.of(CONTROL, RECEIPTS, OUTBOX, SOURCE))
            || delete.stream().anyMatch(quad -> SOURCE.equals(quad.getGraph().getURI())))) {
            throw new IllegalArgumentException("source projection graph footprint differs");
        }
        if (dataInsert && !bootstrap) throw new IllegalArgumentException("unguarded INSERT DATA not admitted");
        if (graphs.contains(PROBE_SEARCH) && !bootstrap && !analyzerProfile)
            throw new IllegalArgumentException("search probe graph requires bootstrap or analyzer profile rebuild");
        if (graphs.contains(PUBLIC_SEARCH) && !bootstrap && !rebuild && !chapterBackfill && !catalogueBackfill
            && current.isEmpty() && revisions.isEmpty())
            throw new IllegalArgumentException("search projection requires a product change");
        if (catalogueBackfill) {
            if (!graphs.equals(Set.of(CONTROL, RECEIPTS, OUTBOX, PUBLIC_SEARCH))
                || !current.isEmpty() || !revisions.isEmpty()
                || java.util.stream.Stream.concat(insert.stream(), delete.stream())
                    .filter(quad -> PUBLIC_SEARCH.equals(quad.getGraph().getURI()))
                    .anyMatch(quad -> !PublicNameProjection.nameMaintenanceQuad(quad))
                || java.util.stream.Stream.concat(insert.stream(), delete.stream())
                    .filter(quad -> CONTROL.equals(quad.getGraph().getURI()))
                    .anyMatch(quad -> !isControlSequence(quad))) {
                throw new IllegalArgumentException("catalogue name backfill footprint differs");
            }
        }
        if (chapterBackfill) {
            List<Quad> publicInserts = insert.stream()
                .filter(quad -> PUBLIC_SEARCH.equals(quad.getGraph().getURI())).toList();
            boolean occurrenceBackfill = graphs.equals(Set.of(CONTROL, RECEIPTS, OUTBOX))
                && insert.stream().anyMatch(quad -> RECEIPTS.equals(quad.getGraph().getURI())
                    && Set.of(OccurrenceLabelIndex.p("occurrenceSearchReset"), OccurrenceLabelIndex.p("occurrenceSearchGeneration"), OccurrenceLabelIndex.p("occurrenceSearchRevision"), OccurrenceLabelIndex.p("occurrenceSearchOffset")).contains(quad.getPredicate()));
            if (!occurrenceBackfill && (!graphs.equals(Set.of(CONTROL, RECEIPTS, OUTBOX, PUBLIC_SEARCH))
                || !current.isEmpty() || !revisions.isEmpty() || publicInserts.size() != 3
                || delete.stream().anyMatch(quad -> !isControlSequence(quad))
                || insert.stream().filter(quad -> CONTROL.equals(quad.getGraph().getURI()))
                    .anyMatch(quad -> !isControlSequence(quad))
                || !publicInserts.stream().allMatch(CommandPolicy::isChapterIdentity)
                || publicInserts.stream().map(quad -> quad.getPredicate().getURI())
                    .distinct().count() != 3)) {
                throw new IllegalArgumentException("chapter search backfill footprint differs");
            }
            if (occurrenceBackfill && (!current.isEmpty() || !revisions.isEmpty()
                || delete.stream().anyMatch(quad -> !isControlSequence(quad))
                || insert.stream().filter(quad -> CONTROL.equals(quad.getGraph().getURI())).anyMatch(quad -> !isControlSequence(quad))))
                throw new IllegalArgumentException("occurrence label backfill footprint differs");
        }
        boolean erasure = receipt.matches("urn:rezics:receipt:erasure-graph:[0-9a-f]{64}");
        if (graphs.contains(PRIVATE_SEARCH) && (bootstrap || rebuild || revisions.isEmpty()
            || current.isEmpty() && !erasure))
            throw new IllegalArgumentException("private projection requires a product revision change");
        if (rebuild) {
            String family = receipt.substring("urn:rezics:receipt:content-rebuild:".length());
            if (!family.matches("(quarantine|profile|clear|cleared|activate):[0-9a-f]{64}"))
                throw new IllegalArgumentException("unknown rebuild receipt family");
            if (!graphs.stream().allMatch(name -> Set.of(CONTROL, RECEIPTS, OUTBOX, PUBLIC_SEARCH, PROBE_SEARCH).contains(name))
                || !graphs.contains(CONTROL) || !graphs.contains(RECEIPTS) || !graphs.contains(OUTBOX)
                || !current.isEmpty() || !revisions.isEmpty())
                throw new IllegalArgumentException("rebuild writes only control, receipt, outbox and public index");
            List<Quad> publicInserts = insert.stream()
                .filter(quad -> PUBLIC_SEARCH.equals(quad.getGraph().getURI())).toList();
            if (analyzerProfile) {
                var probeInserts = insert.stream().filter(q -> PROBE_SEARCH.equals(q.getGraph().getURI())).toList();
                var probeDeletes = delete.stream().filter(q -> PROBE_SEARCH.equals(q.getGraph().getURI())).toList();
                if (graphs.contains(PUBLIC_SEARCH) || probeInserts.size() != 1 || probeDeletes.size() != 1
                    || !isAnalyzerProbe(probeInserts.getFirst()) || !isAnalyzerProbe(probeDeletes.getFirst())
                    || !probeInserts.getFirst().getObject().isLiteral())
                    throw new IllegalArgumentException("analyzer profile rebuild may replace only its fixed body probe");
            }
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
        if (current.size() + revisions.size() + source.size() > 100 || all.size() > 5_000)
            throw new IllegalArgumentException("update footprint too large");
        Plan plan = new Plan(request, Set.copyOf(graphs), Set.copyOf(current),
            Set.copyOf(revisions), Set.copyOf(source), bootstrap, rebuild, !delete.isEmpty());
        if (StatementUpgradePolicy.applies(receipt)) StatementUpgradePolicy.validateTemplate(plan, receipt);
        return plan;
    }

    /** The first slim slice uses the admitted metadata template, without widening its authority. */
    static String slimFootprint(Plan plan, String receipt, String component, String revision) {
        if (!(plan.request().getOperations().getFirst() instanceof UpdateModify modify)
            || maintenanceReceipt(receipt) || plan.bootstrap() || plan.rebuild()
            || !plan.graphs().equals(Set.of(CONTROL, CURRENT, REVISIONS, RECEIPTS, OUTBOX))
            || !plan.revisions().equals(Set.of(revision))) return "slim metadata footprint differs";
        Node own = NodeFactory.createURI(receipt), edition = NodeFactory.createURI(component);
        Node work = null;
        boolean action = false, family = false, kind = false, head = false, receiptComponent = false, receiptRevision = false;
        for (Quad quad : modify.getInsertQuads()) {
            if (RECEIPTS.equals(quad.getGraph().getURI()) && own.equals(quad.getSubject())) {
                String predicate = quad.getPredicate().isURI() ? quad.getPredicate().getURI() : "";
                if ((RV + "work").equals(predicate)) work = quad.getObject();
                if ((RV + "action").equals(predicate)) action = quad.getObject().equals(NodeFactory.createLiteralString("work.edit"));
                if ((RV + "commandFamily").equals(predicate)) family = quad.getObject().isLiteral()
                    && Set.of("work-metadata-details-v1", "work-metadata-details-v2")
                        .contains(quad.getObject().getLiteralLexicalForm());
                if ((RV + "metadataComponent").equals(predicate)) receiptComponent = edition.equals(quad.getObject());
                if ((RV + "metadataRevision").equals(predicate)) receiptRevision = NodeFactory.createURI(revision).equals(quad.getObject());
            }
            if (CURRENT.equals(quad.getGraph().getURI()) && edition.equals(quad.getSubject())) {
                if (quad.getPredicate().equals(NodeFactory.createURI(RV + "metadataKind")))
                    kind = quad.getObject().equals(NodeFactory.createLiteralString("edition"));
                if (quad.getPredicate().equals(NodeFactory.createURI(RV + "metadataHead")))
                    head = quad.getObject().equals(NodeFactory.createURI(revision));
            }
        }
        if (!action || !family || !kind || !head || !receiptComponent || !receiptRevision || work == null || !work.isURI()
            || edition.equals(work) || !plan.current().equals(Set.of(component, work.getURI())))
            return "slim command requires one Work edition";
        Set<String> editionFields = Set.of(RDF.type.getURI(), RV + "work", RV + "metadataKind",
            RV + "metadataHead", RV + "editionState", RV + "editionLanguage", RV + "contentLanguages",
            RV + "titleLanguage", RV + "tracklistLanguage", RV + "originalLanguages", RV + "isTranslation");
        for (Quad quad : java.util.stream.Stream.concat(modify.getInsertQuads().stream(),
            modify.getDeleteQuads().stream()).toList()) if (CURRENT.equals(quad.getGraph().getURI())) {
            if (!quad.getPredicate().isURI() || !(edition.equals(quad.getSubject())
                ? editionFields.contains(quad.getPredicate().getURI())
                : work.equals(quad.getSubject()) && quad.getPredicate().getURI().equals(RV + "editionsRevision")))
                return "slim command changes unrelated current facts";
        }
        return null;
    }

    private static boolean isAnalyzerProbe(Quad quad) {
        return quad.getSubject().isURI()
            && "urn:rezics:search:probe:cjk-bigram-v1".equals(quad.getSubject().getURI())
            && quad.getPredicate().isURI()
            && "https://rezics.com/vocab/searchBody".equals(quad.getPredicate().getURI());
    }

    private static boolean isPublicAnchor(Quad quad) {
        return quad.getSubject().isURI() && PUBLIC_ANCHOR.equals(quad.getSubject().getURI())
            && RDF.type.asNode().equals(quad.getPredicate())
            && NodeFactory.createURI("https://rezics.com/vocab/SearchGraphAnchor").equals(quad.getObject());
    }

    private static boolean isControlSequence(Quad quad) {
        return CONTROL.equals(quad.getGraph().getURI()) && quad.getSubject().isURI()
            && PRODUCT.equals(quad.getSubject().getURI()) && quad.getPredicate().isURI()
            && (RV + "sequence").equals(quad.getPredicate().getURI());
    }

    private static boolean isChapterIdentity(Quad quad) {
        if (!quad.getSubject().isVariable() || !"unit".equals(quad.getSubject().getName())
            || !quad.getPredicate().isURI() || !quad.getObject().isVariable()) return false;
        String expected = switch (quad.getPredicate().getURI()) {
            case RV + "searchResultWork" -> "book";
            case RV + "searchResultMain" -> "bookMain";
            case RV + "searchChapterTitle" -> "title";
            default -> "";
        };
        return expected.equals(quad.getObject().getName()) && !expected.isEmpty();
    }

    private CommandPolicy() {}
}
