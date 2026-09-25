package com.rezics.jena;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.text.DatasetGraphText;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.changes.DatasetGraphTextMonitor;
import org.apache.jena.query.text.changes.TextDatasetChanges;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
import org.apache.lucene.analysis.TokenStream;
import org.apache.lucene.analysis.tokenattributes.CharTermAttribute;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.TermQuery;

/** Native, transaction-derived public MatchUnit journal. Never accept a caller's unit list. */
final class SearchDeltaJournal {
    static final int MAX_UNITS = 64;
    static final int MAX_ENTRIES = 64;
    static final int MAX_REPLAY_UNITS = 256;
    private static final String RV = "https://rezics.com/vocab/";
    private static final Node GRAPH = uri("urn:rezics:graph:search-delta");
    private static final Node STATE = uri("urn:rezics:search:delta:state");
    private static final Node PUBLIC = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node ANCHOR = uri(CommandPolicy.PUBLIC_ANCHOR);
    private static final Node MATCH_UNIT = uri(RV + "MatchUnit");
    private static final Node BODY = uri(RV + "searchBody");
    private static final Node ORDINAL = uri(RV + "searchDeltaOrdinal");
    private static final Node UNIT = uri(RV + "searchDeltaUnit");
    private static final Node BEFORE = uri(RV + "searchDeltaBefore");
    private static final Node AFTER = uri(RV + "searchDeltaAfter");
    private static final Node WRITE_EPOCH = uri(RV + "searchDeltaWriteEpoch");
    private static final Node RESET = uri(RV + "searchDeltaReset");
    private static final Node GENERATION = uri(RV + "textIndexGeneration");
    private static final Node DATA_EPOCH = uri(RV + "dataEpoch");
    private static final Node SEQUENCE = uri(RV + "sequence");

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private static Node entry(long ordinal) { return uri("urn:rezics:search:delta:" + ordinal); }
    private static Node change(long ordinal, int index) {
        return uri("urn:rezics:search:delta:" + ordinal + ":unit:" + index);
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var iter = data.find(graph, subject, predicate, Node.ANY);
        if (!iter.hasNext()) return null;
        Node value = iter.next().getObject();
        return iter.hasNext() ? null : value;
    }
    private static long ordinal(DatasetGraph data) {
        Node node = one(data, GRAPH, STATE, ORDINAL);
        if (node == null || !node.isLiteral() || !node.getLiteralLexicalForm().matches("(0|[1-9][0-9]*)"))
            throw new IllegalStateException("search delta ordinal missing or ambiguous");
        return Long.parseLong(node.getLiteralLexicalForm());
    }
    private static boolean indexed(DatasetGraph data, Node subject) {
        if (!data.contains(PUBLIC, subject, RDF.type.asNode(), MATCH_UNIT)) return false;
        var bodies = data.find(PUBLIC, subject, BODY, Node.ANY);
        if (!bodies.hasNext()) throw new IllegalArgumentException("MatchUnit body missing");
        Node body = bodies.next().getObject();
        if (!body.isLiteral() || bodies.hasNext()) throw new IllegalArgumentException("MatchUnit body ambiguous");
        return true;
    }

    /** A second monitor delegates writes to the text-wrapped dataset, and observes actual quads. */
    static final class Capture implements TextDatasetChanges {
        private final DatasetGraph data;
        private final Map<Node, Boolean> before = new LinkedHashMap<>();
        private boolean reset;

        Capture(DatasetGraph data) { this(data, false); }
        Capture(DatasetGraph data, boolean rebuild) { this.data = data; this.reset = rebuild; }
        DatasetGraph observed() { return new DatasetGraphTextMonitor(data, this); }
        @Override public void start() {}
        @Override public void finish() {}
        @Override public void reset() {}
        @Override public void change(TextQuadAction action, Node graph, Node subject, Node predicate, Node object) {
            if (!PUBLIC.equals(graph) || action != TextQuadAction.ADD && action != TextQuadAction.DELETE) return;
            if (ANCHOR.equals(subject)) { reset = true; return; }
            if (!subject.isURI()) throw new IllegalArgumentException("public search subject is not an IRI");
            if (!reset && subject.getURI().getBytes(StandardCharsets.UTF_8).length > 128)
                throw new IllegalArgumentException("public search subject IRI exceeds delta bound");
            if (before.containsKey(subject)) return;
            if (before.size() >= MAX_UNITS) throw new IllegalArgumentException("actual public search delta exceeds 64 units");
            // The monitor fires after the first real mutation. Reverse that one quad
            // to recover the before-state without scanning the public graph.
            boolean type = data.contains(PUBLIC, subject, RDF.type.asNode(), MATCH_UNIT);
            boolean body = data.contains(PUBLIC, subject, BODY, Node.ANY);
            if (RDF.type.asNode().equals(predicate) && MATCH_UNIT.equals(object))
                type = action == TextQuadAction.DELETE;
            if (BODY.equals(predicate)) {
                if (!object.isLiteral()) throw new IllegalArgumentException("indexed body is not literal");
                if (action == TextQuadAction.ADD) {
                    var bodies = data.find(PUBLIC, subject, BODY, Node.ANY);
                    int other = 0;
                    while (bodies.hasNext()) if (!object.equals(bodies.next().getObject())) other++;
                    body = other > 0;
                } else body = true;
            }
            if (!reset && type != body)
                throw new IllegalArgumentException("prior public MatchUnit/body membership differs");
            before.put(subject, type && body);
        }
        List<Change> changes() {
            if (reset) return List.of();
            List<Change> result = new ArrayList<>();
            for (var candidate : before.entrySet()) {
                Node subject = candidate.getKey();
                boolean after = indexed(data, subject);
                if (!candidate.getValue() && !after && data.contains(PUBLIC, subject, BODY, Node.ANY))
                    throw new IllegalArgumentException("untyped indexed body in public search");
                result.add(new Change(subject.getURI(), candidate.getValue(), after));
            }
            return result;
        }
    }
    record Change(String unit, boolean before, boolean after) {}
    static boolean matchesClaim(List<Change> changes, String claimed) {
        Set<String> live = new LinkedHashSet<>();
        for (Change change : changes) if (change.after()) live.add(change.unit());
        return claimed == null ? live.isEmpty() : live.equals(Set.of(claimed));
    }
    record Delta(long ordinal, String dataEpoch, String sequence, String generation,
                 long writeEpoch, boolean reset, List<Change> changes) {}

    static void initialize(DatasetGraph data) {
        if (data.contains(GRAPH, STATE, ORDINAL, Node.ANY))
            throw new IllegalStateException("search delta state already exists");
        data.add(GRAPH, STATE, ORDINAL, literal("0"));
    }

    static void append(DatasetGraph data, Capture capture, long completedWriteEpoch) {
        List<Change> changes = capture.changes();
        // Existing datasets created by an earlier module have no journal. The
        // first new write starts one; Main has no baseline ordinal and audits.
        if (!data.contains(GRAPH, STATE, ORDINAL, Node.ANY)) initialize(data);
        long next = Math.addExact(ordinal(data), 1);
        CommandInvariant.Control position = CommandInvariant.readControl(data);
        if (position == null || position.textGeneration() == null)
            throw new IllegalStateException("search delta position unavailable");
        Node previous = one(data, GRAPH, STATE, ORDINAL);
        data.delete(GRAPH, STATE, ORDINAL, previous);
        data.add(GRAPH, STATE, ORDINAL, literal(Long.toString(next)));
        Node id = entry(next);
        data.add(GRAPH, id, DATA_EPOCH, position.epoch());
        data.add(GRAPH, id, SEQUENCE, literal(position.sequence().toString()));
        data.add(GRAPH, id, GENERATION, position.textGeneration());
        data.add(GRAPH, id, WRITE_EPOCH, literal(Long.toString(completedWriteEpoch)));
        data.add(GRAPH, id, RESET, literal(Boolean.toString(capture.reset)));
        for (int i = 0; i < changes.size(); i++) {
            Change value = changes.get(i);
            Node item = change(next, i);
            data.add(GRAPH, id, UNIT, item);
            data.add(GRAPH, item, UNIT, uri(value.unit()));
            data.add(GRAPH, item, BEFORE, literal(Boolean.toString(value.before())));
            data.add(GRAPH, item, AFTER, literal(Boolean.toString(value.after())));
        }
        if (next > MAX_ENTRIES) {
            Node expired = entry(next - MAX_ENTRIES);
            var items = data.find(GRAPH, expired, UNIT, Node.ANY);
            List<Node> old = new ArrayList<>();
            while (items.hasNext()) old.add(items.next().getObject());
            for (Node item : old) data.deleteAny(GRAPH, item, Node.ANY, Node.ANY);
            data.deleteAny(GRAPH, expired, Node.ANY, Node.ANY);
        }
    }

    private static Delta readEntry(DatasetGraph data, long number) {
        Node id = entry(number);
        Node epoch = one(data, GRAPH, id, DATA_EPOCH);
        Node sequence = one(data, GRAPH, id, SEQUENCE);
        Node generation = one(data, GRAPH, id, GENERATION);
        Node write = one(data, GRAPH, id, WRITE_EPOCH);
        Node reset = one(data, GRAPH, id, RESET);
        if (epoch == null || !epoch.isLiteral() || sequence == null || !sequence.isLiteral()
            || generation == null || !generation.isURI() || write == null || !write.isLiteral()
            || reset == null || !reset.isLiteral()) throw new IllegalStateException("search delta gap");
        List<Change> changes = new ArrayList<>();
        var iter = data.find(GRAPH, id, UNIT, Node.ANY);
        while (iter.hasNext()) {
            Node item = iter.next().getObject();
            Node unit = one(data, GRAPH, item, UNIT);
            Node before = one(data, GRAPH, item, BEFORE);
            Node after = one(data, GRAPH, item, AFTER);
            if (unit == null || !unit.isURI() || before == null || after == null
                || !Set.of("true", "false").contains(before.getLiteralLexicalForm())
                || !Set.of("true", "false").contains(after.getLiteralLexicalForm()))
                throw new IllegalStateException("search delta entry malformed");
            changes.add(new Change(unit.getURI(), Boolean.parseBoolean(before.getLiteralLexicalForm()),
                Boolean.parseBoolean(after.getLiteralLexicalForm())));
            if (changes.size() > MAX_UNITS) throw new IllegalStateException("search delta entry oversized");
        }
        return new Delta(number, epoch.getLiteralLexicalForm(), sequence.getLiteralLexicalForm(),
            generation.getURI(), Long.parseLong(write.getLiteralLexicalForm()),
            Boolean.parseBoolean(reset.getLiteralLexicalForm()), List.copyOf(changes));
    }

    static Map<String, Object> proof(DatasetGraph data, long since, long writeEpoch) {
        data.begin(org.apache.jena.query.ReadWrite.READ);
        try {
            long head = ordinal(data);
            CommandInvariant.Control position = CommandInvariant.readControl(data);
            if (position == null || position.textGeneration() == null || since < -1 || since > head)
                return Map.of("available", false);
            if (since >= 0 && head - since > MAX_ENTRIES) return Map.of("available", false);
            List<Delta> deltas = new ArrayList<>();
            Set<String> subjects = new LinkedHashSet<>();
            int totalChanges = 0;
            if (since >= 0) for (long number = since + 1; number <= head; number++) {
                Delta delta = readEntry(data, number);
                if (!delta.dataEpoch().equals(position.epoch().getLiteralLexicalForm())
                    || !delta.generation().equals(position.textGeneration().getURI()) || delta.reset()
                    || delta.writeEpoch() > writeEpoch || (delta.writeEpoch() & 1L) != 0L)
                    return Map.of("available", false);
                deltas.add(delta);
                for (Change change : delta.changes()) {
                    if (++totalChanges > MAX_REPLAY_UNITS) return Map.of("available", false);
                    subjects.add(change.unit());
                    if (subjects.size() > MAX_REPLAY_UNITS) return Map.of("available", false);
                }
            }
            if (!(data instanceof DatasetGraphText text) || !(text.getTextIndex() instanceof TextIndexLucene lucene))
                return Map.of("available", false);
            // A committed Lucene reader and the TDB snapshot must agree for every
            // changed subject. The process write epoch fences intervening native writes.
            try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
                IndexSearcher searcher = new IndexSearcher(reader);
                for (String subject : subjects) verifySubject(data, lucene, searcher, subject);
                try (DirectoryReader latest = DirectoryReader.open(lucene.getDirectory())) {
                    if (latest.getIndexCommit().getGeneration() != reader.getIndexCommit().getGeneration())
                        return Map.of("available", false);
                }
                List<Map<String, Object>> responseDeltas = new ArrayList<>();
                for (Delta delta : deltas) {
                    List<Map<String, Object>> responseChanges = new ArrayList<>();
                    for (Change change : delta.changes()) responseChanges.add(Map.of(
                        "unit", change.unit(), "before", change.before(), "after", change.after()));
                    responseDeltas.add(Map.of("ordinal", Long.toString(delta.ordinal()),
                        "dataEpoch", delta.dataEpoch(), "sequence", delta.sequence(),
                        "generation", delta.generation(), "writeEpoch", Long.toString(delta.writeEpoch()),
                        "changes", responseChanges));
                }
                return Map.of("available", true, "ordinal", Long.toString(head),
                    "dataEpoch", position.epoch().getLiteralLexicalForm(),
                    "sequence", position.sequence().toString(),
                    "generation", position.textGeneration().getURI(),
                    "writeEpoch", Long.toString(writeEpoch),
                    "luceneGeneration", Long.toString(reader.getIndexCommit().getGeneration()),
                    "deltas", responseDeltas);
            } catch (IOException | IllegalStateException ex) {
                return Map.of("available", false);
            }
        } finally { data.end(); }
    }

    private static void verifySubject(DatasetGraph data, TextIndexLucene lucene,
                                      IndexSearcher searcher, String subject)
        throws IOException {
        Node unit = uri(subject);
        boolean exists = indexed(data, unit);
        Node body = exists ? one(data, PUBLIC, unit, BODY) : null;
        BooleanQuery exact = new BooleanQuery.Builder()
            .add(new TermQuery(new Term("uri", subject)), BooleanClause.Occur.MUST)
            .add(new TermQuery(new Term("graph", CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
            .build();
        var hits = searcher.search(exact, 9);
        if (hits.totalHits.value() > 8) throw new IllegalStateException("too many exact-subject index documents");
        int bodies = 0;
        for (var hit : hits.scoreDocs) {
            Document doc = searcher.storedFields().document(hit.doc);
            String[] values = doc.getValues("body");
            if (values.length == 0) continue;
            if (values.length != 1 || body == null || !body.getLiteralLexicalForm().equals(values[0])
                || !body.getLiteralLanguage().equalsIgnoreCase(doc.get("lang")))
                throw new IllegalStateException("exact-subject body differs from RDF");
            bodies++;
        }
        if (bodies != (exists ? 1 : 0)) throw new IllegalStateException("exact-subject index membership differs");
        if (exists) {
            // A stored body need not have any indexed terms (for example, only
            // whitespace). The full body:* inventory would not count that unit.
            // Verify one term produced by the exact configured index analyzer.
            String token;
            try (TokenStream stream = lucene.getAnalyzer().tokenStream("body", body.getLiteralLexicalForm())) {
                CharTermAttribute terms = stream.addAttribute(CharTermAttribute.class);
                stream.reset();
                token = stream.incrementToken() ? terms.toString() : null;
                stream.end();
            }
            if (token == null || token.isEmpty())
                throw new IllegalStateException("exact-subject body has no indexed terms");
            BooleanQuery indexed = new BooleanQuery.Builder()
                .add(exact, BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term("body", token)), BooleanClause.Occur.MUST)
                .build();
            if (searcher.search(indexed, 2).totalHits.value() != 1)
                throw new IllegalStateException("exact-subject body token is absent from index");
        }
    }
    private SearchDeltaJournal() {}
}
