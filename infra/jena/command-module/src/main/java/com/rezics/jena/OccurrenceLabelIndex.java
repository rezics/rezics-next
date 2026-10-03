package com.rezics.jena;

import java.util.*;
import org.apache.jena.atlas.json.JsonArray;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.text.changes.DatasetGraphTextMonitor;
import org.apache.jena.query.text.changes.TextDatasetChanges;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Structure commits queue a revision, never analyze labels. A resumable worker
 * projects <=64 placements per command into the existing Jena/Lucene index.
 * The revision in each entity identity fences partial and superseded builds. */
public final class OccurrenceLabelIndex {
    static final String VERSION = "occurrence-lucene-v1", PREFIX = "urn:rezics:occurrence-label:";
    static final Node STATE = uri("urn:rezics:graph:occurrence-search-state");
    static final Node TEXT = uri("urn:rezics:graph:occurrence-search-text");
    static final int BATCH = 64;
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final String ID = "https://rezics.com/id/", RV = "https://rezics.com/vocab/";
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node p(String value) { return uri(RV + value); }
    static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node value = rows.next().getObject();
            if (rows.hasNext()) throw new IllegalStateException("ambiguous occurrence projection field");
            return value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    static void set(DatasetGraph data, Node subject, String predicate, Node value) {
        data.deleteAny(STATE, subject, p(predicate), Node.ANY);
        if (value != null) data.add(STATE, subject, p(predicate), value);
    }
    static Node activeRevision(DatasetGraph data, Node generation) {
        Node structure = one(data, CURRENT, generation, p("structure"));
        Node profile = structure == null ? null : one(data, CURRENT, structure, p("structureProfile"));
        if (profile == null || !Set.of(p("BookComposition"), p("WorkComposition")).contains(
            profile)
            || !generation.equals(one(data, CURRENT, structure, p("selectedGeneration")))
            || !data.contains(CURRENT, generation, p("generationState"), p("Active"))) return null;
        return one(data, CURRENT, structure, p("structureHead"));
    }
    static long count(DatasetGraph data, Node generation) {
        Node value = one(data, CURRENT, generation, p("placementCount"));
        if (value == null || !value.isLiteral()) throw new IllegalStateException("occurrence population is unavailable");
        return Long.parseLong(value.getLiteralLexicalForm());
    }
    static Node textGeneration(DatasetGraph data) {
        return one(data, uri(CommandPolicy.CONTROL), uri("urn:rezics:dataset:product"), p("textIndexGeneration"));
    }
    static boolean ready(DatasetGraph data, Node generation, Node revision) {
        Node textGeneration = textGeneration(data);
        return textGeneration != null && textGeneration.equals(one(data, STATE, generation, p("indexedTextGeneration")))
            && revision != null && data.contains(STATE, generation, p("indexVersion"), literal(VERSION))
            && revision.equals(one(data, STATE, generation, p("indexedRevision")))
            && Long.toString(count(data, generation)).equals(Optional.ofNullable(one(data, STATE, generation, p("indexedCount")))
                .map(Node::getLiteralLexicalForm).orElse(""));
    }
    static void queue(DatasetGraph data, Node generation, boolean reset) {
        Node revision = activeRevision(data, generation);
        if (revision == null) return;
        if (!reset && revision.equals(one(data, STATE, generation, p("targetRevision")))
            && Objects.equals(textGeneration(data), one(data, STATE, generation, p("targetTextGeneration")))
            && data.contains(STATE, generation, p("indexVersion"), literal(VERSION))) return;
        set(data, generation, "indexVersion", literal(VERSION));
        set(data, generation, "targetRevision", revision);
        set(data, generation, "targetTextGeneration", textGeneration(data));
        set(data, generation, "indexedTextGeneration", null);
        set(data, generation, "indexBuild", revision);
        set(data, generation, "indexedRevision", null);
        set(data, generation, "indexedCount", literal("0"));
        set(data, generation, "indexOffset", literal("0"));
        set(data, generation, "indexBatch", literal("0"));
        set(data, generation, "indexPhase", literal("clear"));
        set(data, generation, "pending", org.apache.jena.sparql.expr.NodeValue.TRUE.asNode());
    }
    static final class Capture implements TextDatasetChanges {
        final DatasetGraph data;
        final Set<Node> structures = new LinkedHashSet<>();
        Capture(DatasetGraph data) { this.data = data; }
        DatasetGraph observed(DatasetGraph source) { return new DatasetGraphTextMonitor(source, this); }
        @Override public void start() {}
        @Override public void finish() {}
        @Override public void reset() {}
        @Override public void change(TextQuadAction action, Node graph, Node subject, Node predicate, Node object) {
            if (CURRENT.equals(graph) && action == TextQuadAction.ADD
                && Set.of(p("structureHead"), p("selectedGeneration")).contains(predicate)) structures.add(subject);
        }
        void refresh(String receipt) {
            for (Node structure : structures) {
                Node generation = one(data, CURRENT, structure, p("selectedGeneration"));
                if (generation != null) queue(data, generation, false);
            }
            if (!receipt.startsWith("urn:rezics:receipt:chapter-search-index:")) return;
            Node request = uri(receipt), receipts = uri(CommandPolicy.RECEIPTS);
            Node reset = one(data, receipts, request, p("occurrenceSearchReset"));
            if (reset != null) { queue(data, reset, true); set(data, reset, "indexBuild", request); return; }
            Node generation = one(data, receipts, request, p("occurrenceSearchGeneration"));
            if (generation == null) return;
            Node revision = one(data, receipts, request, p("occurrenceSearchRevision"));
            if (revision == null) { queue(data, generation, false); return; }
            if (!revision.equals(activeRevision(data, generation))) throw new IllegalStateException("occurrence projection revision moved");
            Node offset = one(data, receipts, request, p("occurrenceSearchOffset"));
            if (offset == null || !offset.equals(one(data, STATE, generation, p("indexBatch"))))
                throw new IllegalStateException("occurrence projection checkpoint moved");
            long before = Long.parseLong(one(data, STATE, generation, p("indexedCount")).getLiteralLexicalForm());
            project(data, generation, revision);
            long after = Long.parseLong(one(data, STATE, generation, p("indexedCount")).getLiteralLexicalForm());
            data.add(receipts, request, p("occurrenceProjectedCount"), literal(Long.toString(Math.max(0, after - before))));
        }
    }
    static void deleteProjection(DatasetGraph data, Node placement) {
        Node entity = one(data, STATE, placement, p("projectedEntity"));
        if (entity != null) data.deleteAny(TEXT, entity, Node.ANY, Node.ANY);
        data.deleteAny(STATE, placement, Node.ANY, Node.ANY);
    }
    static void project(DatasetGraph data, Node generation, Node revision) {
        if (!revision.equals(one(data, STATE, generation, p("targetRevision")))
            || !Objects.equals(textGeneration(data), one(data, STATE, generation, p("targetTextGeneration"))))
            throw new IllegalStateException("occurrence projection target moved");
        long checkpoint = Long.parseLong(one(data, STATE, generation, p("indexBatch")).getLiteralLexicalForm());
        set(data, generation, "indexBatch", literal(Long.toString(checkpoint + 1)));
        Node phase = one(data, STATE, generation, p("indexPhase"));
        if (phase != null && phase.getLiteralLexicalForm().equals("clear")) {
            // Deletions also stay bounded; an edit never clears a whole story
            // inside its transaction. Restart resumes from retained descriptors.
            var rows = data.find(STATE, Node.ANY, p("indexedGeneration"), generation);
            List<Node> old = new ArrayList<>();
            try { while (rows.hasNext() && old.size() < BATCH) old.add(rows.next().getSubject()); }
            finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            for (Node placement : old) deleteProjection(data, placement);
            if (!old.isEmpty()) return;
            set(data, generation, "indexPhase", literal("index"));
        }
        long offset = Long.parseLong(one(data, STATE, generation, p("indexOffset")).getLiteralLexicalForm());
        var rows = data.find(CURRENT, Node.ANY, p("generation"), generation);
        List<Node> batch = new ArrayList<>(); long skipped = 0;
        // TDB's fixed index order is stable for this immutable revision. A head
        // change discards the checkpoint. OFFSET retains no prefix inventory.
        try { while (rows.hasNext() && batch.size() < BATCH) {
            Node placement = rows.next().getSubject();
            if (!data.contains(CURRENT, placement, RDF.type.asNode(), p("OccurrencePlacement"))
                || data.contains(CURRENT, placement, p("removedBy"), Node.ANY)) continue;
            if (skipped++ < offset) continue;
            batch.add(placement);
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        for (Node placement : batch) projectPlacement(data, generation, revision, placement);
        long indexed = offset + batch.size(), population = count(data, generation);
        if (indexed > population || batch.size() < BATCH && indexed != population)
            throw new IllegalStateException("occurrence projection population differs from generation");
        set(data, generation, "indexOffset", literal(Long.toString(indexed)));
        set(data, generation, "indexedCount", literal(Long.toString(indexed)));
        if (indexed == population) {
            set(data, generation, "indexedRevision", revision);
            set(data, generation, "indexedTextGeneration", textGeneration(data));
            set(data, generation, "pending", null);
        }
    }
    static String scope(Node generation, Node revision, Node parent) {
        return PREFIX + generation.getURI().substring(ID.length()) + ":" + revision.getURI().substring(ID.length())
            + ":" + parent.getURI().substring(ID.length()) + ":";
    }
    static void projectPlacement(DatasetGraph data, Node generation, Node revision, Node placement) {
        Node occurrence = one(data, CURRENT, placement, p("occurrence")), segment = one(data, CURRENT, placement, p("orderSegment"));
        Node parent = one(data, CURRENT, segment, p("parent")), segmentKey = one(data, CURRENT, segment, p("segmentKey"));
        Node orderKey = one(data, CURRENT, placement, p("orderKey")), role = one(data, CURRENT, placement, p("occurrenceRole"));
        if (occurrence == null || parent == null || segmentKey == null || orderKey == null || role == null)
            throw new IllegalStateException("occurrence projection placement is incomplete");
        String entityId = scope(generation, revision, parent) + segmentKey.getLiteralLexicalForm() + "!"
            + orderKey.getLiteralLexicalForm() + "!" + occurrence.getURI().substring(ID.length()) + ":"
            + (role.equals(p("ChapterRole")) ? "chapter" : "navigation");
        Node entity = uri(entityId);
        JsonArray labels = new JsonArray();
        var values = data.find(CURRENT, placement, p("occurrenceLabel"), Node.ANY);
        try { while (values.hasNext()) {
            Node value = values.next().getObject();
            if (labels.size() >= 16 || !value.isLiteral() || value.getLiteralLanguage().isEmpty()
                || value.getLiteralLexicalForm().length() > 500) throw new IllegalStateException("occurrence label exceeds its contract");
            JsonObject label = new JsonObject(); label.put("value", value.getLiteralLexicalForm());
            label.put("language", value.getLiteralLanguage()); labels.add(label);
        } } finally { org.apache.jena.atlas.iterator.Iter.close(values); }
        Node qualifier = one(data, CURRENT, placement, p("qualifier"));
        if (qualifier != null) for (String predicate : List.of("displayLabel", "number")) {
            Node value = one(data, CURRENT, qualifier, p(predicate));
            if (value != null) {
                JsonObject label = new JsonObject(); label.put("value", value.getLiteralLexicalForm());
                label.put("language", "und"); labels.add(label);
            }
        }
        JsonObject payload = new JsonObject(); payload.put("labels", labels);
        data.add(TEXT, entity, p("occurrenceSearchLabels"), literal(payload.toString()));
        data.add(STATE, placement, p("indexedGeneration"), generation);
        data.add(STATE, placement, p("projectedEntity"), entity);
    }
    public static final class SearchFunction extends org.apache.jena.sparql.function.FunctionBase {
        @Override public void checkBuild(String uri, org.apache.jena.sparql.expr.ExprList args) {
            if (args.size() != 5) throw new org.apache.jena.sparql.expr.ExprEvalException("occurrence search needs five arguments");
        }
        @Override public org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args) {
            throw new org.apache.jena.sparql.expr.ExprEvalException("occurrence search requires a dataset");
        }
        @Override protected org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args,
            org.apache.jena.sparql.function.FunctionEnv env) {
            Node generation = args.get(0).asNode(), revision = activeRevision(env.getDataset(), generation);
            if (revision == null) throw new org.apache.jena.sparql.expr.ExprEvalException("occurrence search generation is inactive");
            JsonObject result = FilteredGraphTextIndex.functionIndex(env).occurrences(generation, revision,
                args.get(1).asNode(), args.get(2).asString(), args.get(3).asString(), args.get(4).getInteger().intValueExact());
            result.put("current", ready(env.getDataset(), generation, revision));
            return org.apache.jena.sparql.expr.NodeValue.makeString(result.toString());
        }
    }
}
