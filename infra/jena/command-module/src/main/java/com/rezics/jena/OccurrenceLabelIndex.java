package com.rezics.jena;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.apache.jena.atlas.json.*;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.text.changes.*;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;

/** Transactional substring postings, separate from publication/title search.
 * Each exact normalized substring has an ordered compressed radix directory.
 * Seeking a page costs O(order-key characters + page * order-key characters),
 * independent of the number of chapter labels. No Lucene/RDF dual commit.
 * Storage/write amplification is O(label characters squared); labels retain
 * their languages and spelling in the owner graph. Duplicates fold once.
 * ICU NFKC_Casefold and the Works analyzer's transform are shared, rather than
 * maintaining a partial CJK table in TypeScript. ICU normalization evidence:
 * https://unicode-org.github.io/icu/userguide/transforms/normalization/ */
public final class OccurrenceLabelIndex {
    static final String VERSION = "occurrence-substring-v1";
    static final Node STATE = uri("urn:rezics:graph:occurrence-search-state");
    private static final Node CURRENT = uri(CommandPolicy.CURRENT);
    private static final String RV = "https://rezics.com/vocab/";
    private static final String ID = "https://rezics.com/id/";
    private static final String NAV = "navigation", MATCH = "label:";
    private static final int MAX_LABELS = 16, MAX_LABEL_CHARS = 500, MAX_KEY_CHARS = 110;
    static Node uri(String value) { return NodeFactory.createURI(value); }
    static Node p(String value) { return uri(RV + value); }
    static Node literal(String value) { return NodeFactory.createLiteralString(value); }
    static Node graph(Node generation) { return uri("urn:rezics:occurrence-search:" + generation.getURI().substring(ID.length())); }
    private static Node one(DatasetGraph data, Node graph, Node subject, Node predicate) {
        var rows = data.find(graph, subject, predicate, Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node result = rows.next().getObject();
            if (rows.hasNext()) throw new IllegalStateException("ambiguous occurrence index field");
            return result;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private static void set(DatasetGraph data, Node graph, Node subject, Node predicate, Node value) {
        data.deleteAny(graph, subject, predicate, Node.ANY);
        if (value != null) data.add(graph, subject, predicate, value);
    }
    private static String hash(String value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }
    static String normalize(String value) {
        return FilteredGraphTextAssembler.foldSearchText(value).strip();
    }
    private record Descriptor(String generation, String parent, String key, List<String> labels, boolean navigation) {
        String json() {
            JsonObject row = new JsonObject();
            row.put("generation", generation); row.put("parent", parent); row.put("key", key);
            row.put("navigation", navigation);
            JsonArray values = new JsonArray(); labels.forEach(values::add); row.put("labels", values);
            return JSON.toStringFlat(row);
        }
        static Descriptor parse(String json) {
            JsonObject row = JSON.parse(json); List<String> labels = new ArrayList<>();
            for (var value : row.get("labels").getAsArray()) labels.add(value.getAsString().value());
            return new Descriptor(row.get("generation").getAsString().value(), row.get("parent").getAsString().value(),
                row.get("key").getAsString().value(), labels, row.get("navigation").getAsBoolean().value());
        }
        Set<String> terms() {
            Set<String> terms = new LinkedHashSet<>();
            if (navigation) terms.add(NAV);
            for (String label : labels) {
                int[] points = label.codePoints().toArray();
                for (int start = 0; start < points.length; start++) {
                    StringBuilder term = new StringBuilder();
                    for (int end = start; end < points.length; end++) {
                        term.appendCodePoint(points[end]); terms.add(MATCH + term);
                    }
                }
            }
            return terms;
        }
    }
    private static Descriptor describe(DatasetGraph data, Node placement) {
        if (!data.contains(CURRENT, placement, RDF.type.asNode(), p("OccurrencePlacement"))
            || data.contains(CURRENT, placement, p("removedBy"), Node.ANY)) return null;
        Node generation = one(data, CURRENT, placement, p("generation")), role = one(data, CURRENT, placement, p("occurrenceRole"));
        if (generation == null || role == null || !Set.of(p("ChapterRole"), p("GroupRole"), p("PartRole")).contains(role)) return null;
        Node structure = one(data, CURRENT, generation, p("structure"));
        Node profile = structure == null ? null : one(data, CURRENT, structure, p("structureProfile"));
        if (profile == null || !Set.of(p("WorkComposition"), p("BookComposition")).contains(profile)) return null;
        Node segment = one(data, CURRENT, placement, p("orderSegment")), occurrence = one(data, CURRENT, placement, p("occurrence"));
        Node parent = segment == null ? null : one(data, CURRENT, segment, p("parent"));
        Node segmentKey = segment == null ? null : one(data, CURRENT, segment, p("segmentKey"));
        Node orderKey = one(data, CURRENT, placement, p("orderKey"));
        if (parent == null || occurrence == null || segmentKey == null || orderKey == null) throw new IllegalStateException("incomplete indexed placement");
        String key = segmentKey.getLiteralLexicalForm() + "\u0001" + orderKey.getLiteralLexicalForm() + "\u0001" + occurrence.getURI();
        if (key.length() > MAX_KEY_CHARS + ID.length()) throw new IllegalStateException("occurrence index key exceeds bound");
        List<String> labels = new ArrayList<>();
        var values = data.find(CURRENT, placement, p("occurrenceLabel"), Node.ANY);
        try { while (values.hasNext()) {
            Node value = values.next().getObject();
            if (!value.isLiteral() || value.getLiteralLanguage().isEmpty()) throw new IllegalStateException("indexed label language is absent");
            labels.add(value.getLiteralLexicalForm());
            if (labels.size() > MAX_LABELS) throw new IllegalStateException("indexed labels exceed bound");
        } } finally { org.apache.jena.atlas.iterator.Iter.close(values); }
        Node qualifier = one(data, CURRENT, placement, p("qualifier"));
        if (qualifier != null) for (String predicate : List.of("displayLabel", "number")) {
            Node value = one(data, CURRENT, qualifier, p(predicate));
            if (value != null && value.isLiteral()) labels.add(value.getLiteralLexicalForm());
        }
        for (String label : labels) if (label.length() > MAX_LABEL_CHARS) throw new IllegalStateException("indexed label exceeds bound");
        return new Descriptor(generation.getURI(), parent.getURI(), key,
            labels.stream().map(OccurrenceLabelIndex::normalize).filter(value -> !value.isEmpty()).distinct().sorted().toList(), !role.equals(p("ChapterRole")));
    }

    /** Each node is one bounded RDF literal. Children store full prefixes so
     * seek can discard the completed prefix without fetching those subtrees.
     * A transaction-local cache batches rewrites; no cross-request cache or
     * inventory needs to be reconstructed after a process interruption. */
    private static final class Directory {
        final DatasetGraph data; final Node graph; final String bucket;
        final Map<String, List<String>> cache = new HashMap<>();
        final Set<String> dirty = new LinkedHashSet<>();
        int reads;
        Directory(DatasetGraph data, Node graph, String parent, String term) {
            this.data = data; this.graph = graph; bucket = hash(parent + "\u0000" + term);
        }
        Node node(String prefix) { return uri("urn:rezics:occurrence-posting:" + bucket + ":" + hash(prefix)); }
        List<String> children(String prefix) {
            if (!cache.containsKey(prefix)) {
                reads++;
                Node value = one(data, graph, node(prefix), p("children"));
                List<String> entries = new ArrayList<>();
                if (value != null) for (var item : JSON.parseAny(value.getLiteralLexicalForm()).getAsArray()) entries.add(item.getAsString().value());
                if (entries.size() > 40 || !entries.equals(entries.stream().distinct().sorted().toList())
                    || entries.stream().anyMatch(entry -> !entry.startsWith(prefix) || entry.length() <= prefix.length()
                        || entry.length() > MAX_KEY_CHARS + ID.length()))
                    throw new IllegalStateException("corrupt occurrence posting directory");
                cache.put(prefix, entries);
            }
            return cache.get(prefix);
        }
        void write(String prefix, List<String> children) { cache.put(prefix, children); dirty.add(prefix); }
        void insert(String key) { insert("", key); }
        private void insert(String prefix, String key) {
            List<String> children = new ArrayList<>(children(prefix));
            String child = children.stream().filter(value -> value.charAt(prefix.length()) == key.charAt(prefix.length())).findFirst().orElse(null);
            // The parent's full key is the leaf. Persist only branch nodes:
            // empty leaf quads otherwise dominate TDB2's node table/import
            // work while carrying no additional information.
            if (child == null) { children.add(key); }
            else {
                if (child.equals(key)) return;
                int common = prefix.length();
                while (common < Math.min(child.length(), key.length()) && child.charAt(common) == key.charAt(common)) common++;
                if (common == child.length()) { insert(child, key); return; }
                String middle = key.substring(0, common);
                write(middle, new ArrayList<>(List.of(child, key).stream().sorted().toList()));
                children.remove(child); children.add(middle);
            }
            Collections.sort(children); write(prefix, children);
        }
        void remove(String key) { remove("", key); }
        private void remove(String prefix, String key) {
            List<String> children = new ArrayList<>(children(prefix));
            String child = children.stream().filter(key::startsWith).findFirst().orElse(null);
            if (child == null) return;
            if (child.equals(key)) { children.remove(child); write(child, null); }
            else {
                remove(child, key);
                List<String> remaining = children(child);
                if (remaining.size() <= 1) {
                    children.remove(child); children.addAll(remaining); write(child, null);
                }
            }
            Collections.sort(children); write(prefix, children);
        }
        List<String> page(String after, int limit) {
            List<String> result = new ArrayList<>(); page("", after, limit, result, 0); return result;
        }
        private void page(String prefix, String after, int limit, List<String> result, int depth) {
            if (depth > MAX_KEY_CHARS || reads > (limit + 1) * (MAX_KEY_CHARS + 1)) throw new IllegalStateException("occurrence seek budget exceeded");
            List<String> children = children(prefix);
            if (!prefix.isEmpty() && children.isEmpty()) {
                if (prefix.compareTo(after) > 0) result.add(prefix);
                return;
            }
            for (String child : children) {
                if ((child + "\uffff").compareTo(after) <= 0) continue;
                page(child, after, limit, result, depth + 1);
                if (result.size() >= limit) return;
            }
        }
        void flush() {
            for (String prefix : dirty) {
                List<String> values = cache.get(prefix);
                JsonArray array = new JsonArray(); if (values != null) values.forEach(array::add);
                set(data, graph, node(prefix), p("children"), values == null || values.isEmpty() ? null : literal(JSON.toStringFlat(array)));
            }
        }
    }

    static final class Capture implements TextDatasetChanges {
        final DatasetGraph data;
        final Set<Node> subjects = new LinkedHashSet<>(), generations = new LinkedHashSet<>(), selected = new LinkedHashSet<>();
        Capture(DatasetGraph data) { this.data = data; }
        DatasetGraph observed(DatasetGraph source) { return new DatasetGraphTextMonitor(source, this); }
        @Override public void start() {}
        @Override public void finish() {}
        @Override public void reset() {}
        @Override public void change(TextQuadAction action, Node graph, Node subject, Node predicate, Node object) {
            if (!CURRENT.equals(graph) || action != TextQuadAction.ADD && action != TextQuadAction.DELETE) return;
            if (Set.of(RDF.type.asNode(), p("generation"), p("occurrence"), p("orderSegment"), p("orderKey"), p("occurrenceRole"),
                p("removedBy"), p("occurrenceLabel"), p("qualifier"), p("parent"), p("segmentKey"), p("displayLabel"), p("number")).contains(predicate)) subjects.add(subject);
            if (predicate.equals(p("generationState")) || predicate.equals(p("placementCount"))) generations.add(subject);
            if (predicate.equals(p("selectedGeneration")) && action == TextQuadAction.ADD) selected.add(object);
            // A deleted qualifier/segment link must still invalidate its old placement.
            if (predicate.equals(p("qualifier")) || predicate.equals(p("orderSegment"))) subjects.add(subject);
        }
        void refresh(String receipt) {
            Set<Node> placements = new LinkedHashSet<>();
            for (Node subject : subjects) {
                if (data.contains(CURRENT, subject, p("occurrence"), Node.ANY) || data.contains(STATE, subject, p("descriptor"), Node.ANY)) placements.add(subject);
                for (String predicate : List.of("qualifier", "orderSegment")) {
                    var owners = data.find(CURRENT, Node.ANY, p(predicate), subject);
                    try { while (owners.hasNext()) placements.add(owners.next().getSubject()); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(owners); }
                }
            }
            if (receipt.startsWith("urn:rezics:receipt:chapter-search-index:")) {
                Node initialize = one(data, uri(CommandPolicy.RECEIPTS), uri(receipt), p("occurrenceSearchGeneration"));
                if (initialize != null) { requireGeneration(data, initialize); generations.add(initialize); }
                Node reset = one(data, uri(CommandPolicy.RECEIPTS), uri(receipt), p("occurrenceSearchReset"));
                if (reset != null) {
                    requireGeneration(data, reset);
                    data.deleteAny(graph(reset), Node.ANY, Node.ANY, Node.ANY);
                    // Descriptor cleanup is operational inventory work, never a request.
                    var rows = data.find(STATE, Node.ANY, p("indexedGeneration"), reset); List<Node> old = new ArrayList<>();
                    try { while (rows.hasNext()) old.add(rows.next().getSubject()); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                    for (Node placement : old) data.deleteAny(STATE, placement, Node.ANY, Node.ANY);
                    set(data, STATE, reset, p("indexedCount"), literal("0")); generations.add(reset);
                }
                var rows = data.find(uri(CommandPolicy.RECEIPTS), uri(receipt), p("occurrenceSearchPlacement"), Node.ANY);
                int count = 0;
                try { while (rows.hasNext()) {
                    if (++count > 64) throw new IllegalStateException("occurrence backfill exceeds batch");
                    Node placement = rows.next().getObject();
                    if (describe(data, placement) == null) throw new IllegalStateException("backfill placement is not active");
                    placements.add(placement);
                } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            }
            refreshPlacements(data, placements, generations);
            for (Node generation : selected) {
                Node structure = one(data, CURRENT, generation, p("structure"));
                Node profile = structure == null ? null : one(data, CURRENT, structure, p("structureProfile"));
                if (profile != null && Set.of(p("BookComposition"), p("WorkComposition")).contains(profile)) requireReady(data, generation);
            }
        }
    }
    private static void requireGeneration(DatasetGraph data, Node generation) {
        if (!generation.isURI() || !generation.getURI().matches(ID + "[0-9a-f-]{36}")
            || !data.contains(CURRENT, generation, RDF.type.asNode(), p("StructureGeneration"))) throw new IllegalStateException("occurrence generation is unavailable");
    }
    static void refreshPlacements(DatasetGraph data, Collection<Node> placements, Set<Node> generations) {
        Map<String, Directory> directories = new LinkedHashMap<>();
        for (Node placement : placements) {
            Node oldValue = one(data, STATE, placement, p("descriptor"));
            Descriptor before = oldValue == null ? null : Descriptor.parse(oldValue.getLiteralLexicalForm()), after = describe(data, placement);
            if (Objects.equals(before, after)) continue;
            Set<String> shared = new HashSet<>();
            if (before != null && after != null && before.generation().equals(after.generation())
                && before.parent().equals(after.parent()) && before.key().equals(after.key())) {
                shared.addAll(before.terms()); shared.retainAll(after.terms());
            }
            for (Descriptor descriptor : new Descriptor[]{before, after}) if (descriptor != null) {
                Node generation = uri(descriptor.generation()); generations.add(generation);
                for (String term : descriptor.terms()) {
                    if (shared.contains(term)) continue;
                    String identity = descriptor.generation() + "\u0000" + descriptor.parent() + "\u0000" + term;
                    Directory directory = directories.computeIfAbsent(identity, ignored -> new Directory(data, graph(generation), descriptor.parent(), term));
                    if (descriptor == before) directory.remove(descriptor.key()); else directory.insert(descriptor.key());
                }
                Node stored = one(data, STATE, generation, p("indexedCount"));
                long count = stored == null ? 0 : Long.parseLong(stored.getLiteralLexicalForm());
                set(data, STATE, generation, p("indexedCount"), literal(Long.toString(count + (descriptor == before ? -1 : 1))));
            }
            set(data, STATE, placement, p("descriptor"), after == null ? null : literal(after.json()));
            set(data, STATE, placement, p("indexedGeneration"), after == null ? null : uri(after.generation()));
        }
        directories.values().forEach(Directory::flush);
        for (Node generation : generations) {
            Node structure = one(data, CURRENT, generation, p("structure"));
            Node profile = structure == null ? null : one(data, CURRENT, structure, p("structureProfile"));
            if (profile == null || !Set.of(p("WorkComposition"), p("BookComposition")).contains(profile)) continue;
            set(data, STATE, generation, p("indexVersion"), literal(VERSION));
            if (one(data, STATE, generation, p("indexedCount")) == null) set(data, STATE, generation, p("indexedCount"), literal("0"));
        }
    }
    private static void requireReady(DatasetGraph data, Node generation) {
        requireGeneration(data, generation);
        Node version = one(data, STATE, generation, p("indexVersion")), count = one(data, STATE, generation, p("indexedCount")), expected = one(data, CURRENT, generation, p("placementCount"));
        if (!literal(VERSION).equals(version) || count == null || expected == null
            || !count.getLiteralLexicalForm().equals(expected.getLiteralLexicalForm())) throw new IllegalStateException("occurrence index needs backfill");
    }
    static JsonObject search(DatasetGraph data, Node generation, Node parent, String query, String after, int limit) {
        requireReady(data, generation);
        if (query.length() > 200 || after.length() > MAX_KEY_CHARS + ID.length() || limit < 1 || limit > 101) throw new IllegalArgumentException("invalid occurrence index seek");
        String normalized = normalize(query);
        if (normalized.isEmpty()) throw new IllegalArgumentException("empty occurrence index seek");
        Directory matches = new Directory(data, graph(generation), parent.getURI(), MATCH + normalized), navigation = new Directory(data, graph(generation), parent.getURI(), NAV);
        Set<String> selected = new TreeSet<>(matches.page(after, limit));
        Set<String> matching = Set.copyOf(selected); selected.addAll(navigation.page(after, limit));
        JsonArray items = new JsonArray();
        for (String key : selected.stream().limit(limit).toList()) {
            String[] parts = key.split("\u0001", -1);
            if (parts.length != 3) throw new IllegalStateException("corrupt occurrence index key");
            JsonObject row = new JsonObject(); row.put("segmentKey", parts[0]); row.put("orderKey", parts[1]);
            row.put("occurrence", parts[2]); row.put("matches", matching.contains(key)); items.add(row);
        }
        JsonObject result = new JsonObject(); result.put("items", items); result.put("reads", matches.reads + navigation.reads);
        return result;
    }
    /** A scalar returns a single bounded JSON value. ARQ drops a failed BIND;
     * the API treats its absent value as unavailable, never an empty page. */
    public static final class SearchFunction extends org.apache.jena.sparql.function.FunctionBase {
        @Override public void checkBuild(String uri, org.apache.jena.sparql.expr.ExprList args) {
            if (args.size() != 5) throw new org.apache.jena.sparql.expr.ExprEvalException("occurrenceSearch needs five arguments");
        }
        @Override public org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args) { throw new org.apache.jena.sparql.expr.ExprEvalException("occurrenceSearch needs a dataset"); }
        @Override protected org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args, org.apache.jena.sparql.function.FunctionEnv env) {
            try { return org.apache.jena.sparql.expr.NodeValue.makeString(JSON.toStringFlat(search(env.getDataset(), args.get(0).asNode(), args.get(1).asNode(), args.get(2).asString(), args.get(3).asString(), args.get(4).getInteger().intValueExact()))); }
            catch (RuntimeException unavailable) { throw new org.apache.jena.sparql.expr.ExprEvalException("occurrence index unavailable", unavailable); }
        }
    }
}
