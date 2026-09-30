package com.rezics.jena;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
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
import org.apache.lucene.search.SimpleCollector;
import org.apache.lucene.search.ScoreMode;
import org.apache.lucene.index.LeafReaderContext;

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

    private record Qualification(String epoch, String generation, long ordinal,
                                 long luceneGeneration, long population, String sequence,
                                 Map<String, FilteredGraphTextIndex.RankUnit> rankUnits) {}
    private static final Map<DatasetGraph, Qualification> qualified = new WeakHashMap<>();
    private static final Map<TextIndexLucene, Qualification> ranked = new WeakHashMap<>();

    static void invalidate(DatasetGraph data) {
        synchronized (qualified) {
            qualified.remove(data);
            synchronized (ranked) { ranked.remove(lucene(data)); }
        }
    }

    /** Older restored datasets can predate the native journal. Install only
     * its empty baseline before traffic; qualification still audits every RDF
     * and Lucene body. No caller-provided unit inventory is accepted. */
    static boolean qualifyAtStartup(DatasetGraph data) {
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            CommandInvariant.Control position = CommandInvariant.readControl(data);
            if (position == null || position.textGeneration() == null) return false;
            if (!data.contains(GRAPH, STATE, ORDINAL, Node.ANY)) initialize(data);
            data.commit();
        } finally { data.end(); }
        return qualify(data);
    }

    static boolean canTrackCommit(DatasetGraph data) {
        if (lucene(data) == null) return false;
        try {
            var position = CommandInvariant.readControl(data);
            return position != null && position.textGeneration() != null;
        } catch (RuntimeException invalidControl) {
            // Command preflight reports malformed control inside its abort/end
            // scope; tracking discovery must not strand a writer transaction.
            return false;
        }
    }

    /** A later valid command must not conceal an earlier unjournaled index
     * mutation. Check the committed reader before the native writer changes it. */
    static void fenceBeforeWrite(DatasetGraph data) {
        Qualification baseline;
        synchronized (qualified) { baseline = qualified.get(data); }
        if (baseline == null) return;
        try (DirectoryReader reader = DirectoryReader.open(lucene(data).getDirectory())) {
            if (reader.getIndexCommit().getGeneration() != baseline.luceneGeneration()) invalidate(data);
        } catch (IOException | RuntimeException unavailable) { invalidate(data); }
    }

    /** Startup/rebuild work, never a query-time population admission limit. The
     * collector streams documents; no top-N inventory can silently truncate it.
     * Native deltas maintain this baseline between generation qualifications. */
    static boolean qualify(DatasetGraph data) {
        invalidate(data);
        TextIndexLucene index = lucene(data);
        Qualification baseline = auditGeneration(data, index, true);
        if (baseline == null) return false;
        synchronized (qualified) {
            qualified.put(data, baseline);
            synchronized (ranked) { ranked.put(index, baseline); }
        }
        return true;
    }

    private static Qualification auditGeneration(DatasetGraph data, TextIndexLucene lucene, boolean captureRankUnits) {
        boolean ownsTransaction = !data.isInTransaction();
        if (ownsTransaction) data.begin(org.apache.jena.query.ReadWrite.READ);
        try {
            CommandInvariant.Control position = CommandInvariant.readControl(data);
            if (position == null || position.textGeneration() == null || lucene == null)
                return null;
            try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
                IndexSearcher searcher = new IndexSearcher(reader);
                Set<String> seen = new LinkedHashSet<>();
                Map<String, FilteredGraphTextIndex.RankUnit> rankUnits = captureRankUnits
                    ? new java.util.concurrent.ConcurrentHashMap<>() : null;
                // body:* excludes tokenless bodies, which cannot be qualified.
                var parser = new org.apache.lucene.queryparser.classic.QueryParser("body", lucene.getQueryAnalyzer());
                parser.setAllowLeadingWildcard(true);
                BooleanQuery query = new BooleanQuery.Builder()
                    .add(parser.parse("body:*"), BooleanClause.Occur.MUST)
                    .add(new TermQuery(new Term("graph", CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
                    .build();
                searcher.search(query, new SimpleCollector() {
                    private LeafReaderContext leaf;
                    @Override protected void doSetNextReader(LeafReaderContext context) { leaf = context; }
                    @Override public ScoreMode scoreMode() { return ScoreMode.COMPLETE_NO_SCORES; }
                    @Override public void collect(int doc) throws IOException {
                        Document stored = leaf.reader().storedFields().document(doc);
                        String subject = stored.get("uri");
                        if (subject == null || !seen.add(subject))
                            throw new IllegalStateException("duplicate public body document");
                        Node unit = uri(subject), body = one(data, PUBLIC, unit, BODY);
                        if (!data.contains(PUBLIC, unit, RDF.type.asNode(), MATCH_UNIT)
                            || body == null || !body.isLiteral() || stored.getValues("body").length != 1
                            || !body.getLiteralLexicalForm().equals(stored.get("body"))
                            || !body.getLiteralLanguage().equalsIgnoreCase(stored.get("lang") == null ? "" : stored.get("lang")))
                            throw new IllegalStateException("public index differs from RDF");
                        if (rankUnits != null) {
                            var facts = FilteredGraphTextIndex.describeUnit(data, subject);
                            if (facts != null) rankUnits.put(subject, facts);
                        }
                    }
                });
                long population = 0;
                var units = data.find(PUBLIC, Node.ANY, RDF.type.asNode(), MATCH_UNIT);
                try {
                    while (units.hasNext()) {
                        Node unit = units.next().getSubject();
                        if (!unit.isURI() || !seen.contains(unit.getURI())) return null;
                        population++;
                    }
                } finally { org.apache.jena.atlas.iterator.Iter.close(units); }
                if (population != seen.size()) return null;
                return new Qualification(position.epoch().getLiteralLexicalForm(),
                    position.textGeneration().getURI(), ordinal(data),
                    reader.getIndexCommit().getGeneration(), population, position.sequence().toString(), rankUnits);
            } catch (IOException | org.apache.lucene.queryparser.classic.ParseException | IllegalStateException ex) {
                return null;
            }
        } finally { if (ownsTransaction) data.end(); }
    }

    static long auditPopulation(DatasetGraph data, TextIndexLucene lucene) {
        // A bypass-writer service audits its own snapshot. It must not install
        // or invalidate the command-only service's generation qualification.
        Qualification audited = auditGeneration(data, lucene, false);
        if (audited == null) throw new IllegalStateException("public text generation is unqualified");
        return audited.population();
    }

    static Map<String, FilteredGraphTextIndex.RankUnit> rankUnits(DatasetGraph data, TextIndexLucene index, long commit) {
        Qualification baseline;
        synchronized (ranked) { baseline = ranked.get(index); }
        if (baseline == null || baseline.luceneGeneration() != commit) return null;
        var position = CommandInvariant.readControl(data);
        return position != null && position.textGeneration() != null
            && baseline.epoch().equals(position.epoch().getLiteralLexicalForm())
            && baseline.generation().equals(position.textGeneration().getURI())
            && baseline.sequence().equals(position.sequence().toString()) ? baseline.rankUnits() : null;
    }

    private static TextIndexLucene lucene(DatasetGraph data) {
        if (!(data instanceof DatasetGraphText text)) return null;
        return text.getTextIndex() instanceof FilteredGraphTextIndex filtered
            ? filtered.lucene() : text.getTextIndex() instanceof TextIndexLucene direct ? direct : null;
    }

    /** A request consumes an already-qualified generation and bounded native
     * deltas. Missing/gapped baselines are unavailable, never an on-demand scan. */
    static Map<String, Object> qualifiedProof(DatasetGraph data, long since, long writeEpoch) {
        Qualification baseline;
        synchronized (qualified) { baseline = qualified.get(data); }
        if (baseline == null) return Map.of("available", false);
        Map<String, Object> replay = proof(data, baseline.ordinal(), writeEpoch);
        if (!Boolean.TRUE.equals(replay.get("available"))
            || !baseline.epoch().equals(replay.get("dataEpoch"))
            || !baseline.generation().equals(replay.get("generation"))) return Map.of("available", false);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> deltas = (List<Map<String, Object>>) replay.get("deltas");
        long population = baseline.population();
        for (Map<String, Object> delta : deltas) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> changes = (List<Map<String, Object>>) delta.get("changes");
            for (Map<String, Object> change : changes) {
                if (Boolean.TRUE.equals(change.get("before"))) population--;
                if (Boolean.TRUE.equals(change.get("after"))) population++;
            }
        }
        long luceneGeneration = Long.parseLong((String) replay.get("luceneGeneration"));
        if (population < 0 || deltas.isEmpty() && luceneGeneration != baseline.luceneGeneration())
            return Map.of("available", false);
        Map<String, FilteredGraphTextIndex.RankUnit> changedFacts = new LinkedHashMap<>();
        if (!deltas.isEmpty()) {
            boolean ownsTransaction = !data.isInTransaction();
            if (ownsTransaction) data.begin(org.apache.jena.query.ReadWrite.READ);
            try {
                var position = CommandInvariant.readControl(data);
                if (position == null || position.textGeneration() == null
                    || !position.epoch().getLiteralLexicalForm().equals(replay.get("dataEpoch"))
                    || !position.sequence().toString().equals(replay.get("sequence"))
                    || !position.textGeneration().getURI().equals(replay.get("generation")))
                    return Map.of("available", false);
                // Only bounded actual journal subjects refresh the public facts.
                for (var delta : deltas) {
                    @SuppressWarnings("unchecked")
                    var changes = (List<Map<String, Object>>) delta.get("changes");
                    for (var change : changes) {
                        String unit = (String) change.get("unit");
                        var facts = FilteredGraphTextIndex.describeUnit(data, unit);
                        changedFacts.put(unit, facts);
                    }
                }
            } finally { if (ownsTransaction) data.end(); }
        }
        Qualification next = new Qualification(baseline.epoch(), baseline.generation(),
            Long.parseLong((String) replay.get("ordinal")), luceneGeneration, population,
            (String) replay.get("sequence"), baseline.rankUnits());
        synchronized (qualified) {
            // A slower read must not overwrite a later writer's qualification.
            if (qualified.get(data) == baseline) {
                for (var change : changedFacts.entrySet()) {
                    if (change.getValue() == null) baseline.rankUnits().remove(change.getKey());
                    else baseline.rankUnits().put(change.getKey(), change.getValue());
                }
                qualified.put(data, next);
                synchronized (ranked) { ranked.put(lucene(data), next); }
            }
        }
        Map<String, Object> requested = since == -1 ? replay : proof(data, since, writeEpoch);
        if (!Boolean.TRUE.equals(requested.get("available"))
            || !requested.get("ordinal").equals(replay.get("ordinal"))
            || !requested.get("luceneGeneration").equals(replay.get("luceneGeneration")))
            return Map.of("available", false);
        Map<String, Object> response = new LinkedHashMap<>(requested);
        response.put("qualifiedPopulation", Long.toString(population));
        return response;
    }

    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    private static Node entry(long ordinal) { return uri("urn:rezics:search:delta:" + ordinal); }
    private static Node change(long ordinal, int index) {
        return uri("urn:rezics:search:delta:" + ordinal + ":unit:" + index);
    }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var iter = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!iter.hasNext()) return null;
            Node value = iter.next().getObject();
            return iter.hasNext() ? null : value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(iter); }
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
        boolean ownsTransaction = !data.isInTransaction();
        if (ownsTransaction) data.begin(org.apache.jena.query.ReadWrite.READ);
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
            if (!(data instanceof DatasetGraphText text))
                return Map.of("available", false);
            TextIndexLucene lucene = text.getTextIndex() instanceof FilteredGraphTextIndex filtered
                ? filtered.lucene() : text.getTextIndex() instanceof TextIndexLucene direct ? direct : null;
            if (lucene == null) return Map.of("available", false);
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
        } finally { if (ownsTransaction) data.end(); }
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
