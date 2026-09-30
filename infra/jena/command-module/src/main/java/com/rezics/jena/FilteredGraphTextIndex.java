package com.rezics.jena;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.PriorityQueue;
import org.apache.jena.datatypes.TypeMapper;
import org.apache.jena.graph.Node;
import org.apache.jena.graph.NodeFactory;
import org.apache.jena.query.text.Entity;
import org.apache.jena.query.text.EntityDefinition;
import org.apache.jena.query.text.TextHit;
import org.apache.jena.query.text.TextIndex;
import org.apache.jena.query.text.TextIndexException;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.TextQueryFuncs;
import org.apache.jena.rdf.model.Resource;
import org.apache.jena.rdf.model.ResourceFactory;
import org.apache.lucene.document.Document;
import org.apache.lucene.index.DirectoryReader;
import org.apache.lucene.index.Term;
import org.apache.lucene.queryparser.classic.ParseException;
import org.apache.lucene.queryparser.classic.QueryParser;
import org.apache.lucene.search.BooleanClause;
import org.apache.lucene.search.BooleanQuery;
import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.TermQuery;
import org.apache.lucene.search.SimpleCollector;
import org.apache.lucene.search.ScoreMode;
import org.apache.lucene.search.Scorable;
import org.apache.lucene.index.LeafReaderContext;
import org.apache.jena.atlas.json.JsonObject;
import org.apache.jena.atlas.json.JsonArray;

/** Keeps Jena's writer, analyzer and index layout. Only the named-graph term is
 * moved from Jena's scored MUST clause to a non-scoring Lucene FILTER clause. */
public final class FilteredGraphTextIndex implements TextIndex {
    private static final int DEFAULT_LIMIT = 10_000;
    private static final int MAX_ADMITTED_LIMIT = 50_001;
    private final TextIndexLucene lucene;

    public FilteredGraphTextIndex(TextIndexLucene lucene) { this.lucene = lucene; }
    public TextIndexLucene lucene() { return lucene; }

    public record RankHit(String id, float score, String key) {
        public RankHit(String id, float score) { this(id, score, id); }
    }
    public record RankAfter(String id, float score, long commit) {}
    public record RankPage(List<RankHit> hits, long count, String precision, long commit, boolean more) {}
    private static final Comparator<RankHit> RANK = Comparator.comparingDouble(RankHit::score).reversed()
        .thenComparing(RankHit::key).thenComparing(RankHit::id);
    public record RankScope(String realm, String language, String author) {}

    /** Page-sized top-k storage, score descending and exact IRI tie-break. This
     * collector never materializes or sorts the whole candidate population.
     * Jena's index has no IRI doc values; a bounded heap retains its existing
     * writer/analyzers without requiring an index-format migration. A 1s native
     * deadline bounds the extra stored-field reads. The caller debits the JSON
     * bytes and every refill against the existing whole-request budget. */
    public RankPage ranked(Node property, String phrase, int size, RankAfter after) {
        return ranked(property, phrase, size, after, null, null);
    }
    public RankPage ranked(Node property, String phrase, int size, RankAfter after,
                           org.apache.jena.sparql.core.DatasetGraph data, RankScope scope) {
        if (size < 1 || size > 64) throw new TextIndexException("ranked page size is out of bounds");
        String field = lucene.getDocDef().getField(property);
        if (!"body".equals(field) && !"publicTitle".equals(field))
            throw new TextIndexException("ranked field is not public");
        try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
            long commit = reader.getIndexCommit().getGeneration();
            if (after != null && (after.commit() != commit || !Float.isFinite(after.score())
                || after.id() == null || after.id().length() > 2048))
                throw new TextIndexException("ranked continuation requires restart");
            QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
            // The API supplies a literal phrase, never Lucene operators.
            Query query = new BooleanQuery.Builder()
                .add(parser.parse("\"" + phrase.replace("\\", "\\\\").replace("\"", "\\\"") + "\""), BooleanClause.Occur.MUST)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)),
                    BooleanClause.Occur.FILTER).build();
            IndexSearcher searcher = new IndexSearcher(reader);
            Map<String, RankUnit> units = scope == null ? null : SearchDeltaJournal.rankUnits(data, lucene, commit);
            long deadline = System.nanoTime() + 1_000_000_000L;
            searcher.setTimeout(() -> System.nanoTime() >= deadline);
            PriorityQueue<RankHit> top = new PriorityQueue<>(size + 1, RANK.reversed());
            long[] count = { 0 };
            searcher.search(query, new SimpleCollector() {
                private LeafReaderContext leaf;
                private Scorable scorer;
                @Override protected void doSetNextReader(LeafReaderContext context) { leaf = context; }
                @Override public void setScorer(Scorable value) { scorer = value; }
                @Override public ScoreMode scoreMode() { return ScoreMode.COMPLETE; }
                @Override public void collect(int doc) throws IOException {
                    if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
                    float score = scorer.score();
                    String entityField = lucene.getDocDef().getEntityField();
                    String id = leaf.reader().storedFields().document(doc, java.util.Set.of(entityField)).get(entityField);
                    if (id == null || !Float.isFinite(score)) throw new TextIndexException("ranked document is incomplete");
                    String key = scope == null ? id : admittedMain(data, id, scope, units);
                    if (key == null) return;
                    RankHit hit = new RankHit(id, score, key);
                    // Only the strongest current MatchUnit represents a Main.
                    // Its group membership is an RDF object-index lookup, not
                    // a collected inventory of phrase candidates.
                    if (scope != null && !canonicalGroupHit(data, scope, searcher, query, key,
                        id, leaf.docBase + doc, lucene.getDocDef().getEntityField(), units)) return;
                    count[0]++;
                    if (after != null && (score > after.score() || score == after.score()
                        && key.compareTo(after.id()) <= 0)) return;
                    if (top.size() < size + 1) top.add(hit);
                    else if (RANK.compare(hit, top.peek()) < 0) { top.poll(); top.add(hit); }
                }
            });
            if (searcher.timedOut()) throw new TextIndexException("ranked query deadline exceeded");
            List<RankHit> ordered = new ArrayList<>(top);
            ordered.sort(RANK);
            boolean more = ordered.size() > size;
            if (more) ordered.removeLast();
            return new RankPage(List.copyOf(ordered), Math.min(count[0], 1000),
                count[0] > 1000 ? "lower-bound" : "exact", commit, more);
        } catch (IOException | ParseException ex) { throw new TextIndexException("ranked query failed", ex); }
    }

    private static final String RV = "https://rezics.com/vocab/";
    private static Node uri(String value) { return NodeFactory.createURI(value); }
    private static final Node PUBLIC_GRAPH = uri(CommandPolicy.PUBLIC_SEARCH);
    private static final Node CURRENT_GRAPH = uri(CommandPolicy.CURRENT);
    private static final Map<String, Node> PROPERTIES = java.util.stream.Stream.of("mainVersion", "selection",
        "context", "language", "disclosure", "Public", "contribution", "author", "selectionHead", "realm",
        "RealmPublicationSlot", "searchResultMain")
        .collect(java.util.stream.Collectors.toUnmodifiableMap(name -> name, name -> uri(RV + name)));
    private static Node property(String name) { return PROPERTIES.get(name); }
    private static Node one(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String predicate) {
        var rows = data.find(graph, subject, property(predicate), Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node value = rows.next().getObject();
            return rows.hasNext() ? null : value;
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    record RankUnit(Node main, Node selection, Node context, Node language, Node contribution, String key) {}

    /** Public MatchUnit facts are captured by generation qualification and
     * refreshed for the journal's actual changed subjects. Current selection
     * and author admission remain live RDF lookups, even with cached facts. */
    static RankUnit describeUnit(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        Node publicGraph = PUBLIC_GRAPH, current = CURRENT_GRAPH, unit = uri(id);
        Node main = one(data, publicGraph, unit, "mainVersion"), selection = one(data, publicGraph, unit, "selection");
        Node context = one(data, publicGraph, unit, "context"), language = one(data, publicGraph, unit, "language");
        if (main == null || !main.isURI() || selection == null || !selection.isURI()
            || context == null || !context.isURI() || language == null || !language.isLiteral()
            || !data.contains(publicGraph, unit, property("disclosure"), property("Public"))) return null;
        Node result = one(data, publicGraph, unit, "searchResultMain");
        return new RankUnit(main, selection, context, language, one(data, publicGraph, unit, "contribution"),
            result != null && result.isURI() ? result.getURI() : main.getURI());
    }
    private static String admittedMain(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope,
                                       Map<String, RankUnit> units) {
        RankUnit facts = units == null ? describeUnit(data, id) : units.get(id);
        if (facts == null) return null;
        Node main = facts.main(), selection = facts.selection(), context = facts.context(), language = facts.language();
        Node current = CURRENT_GRAPH;
        if (scope.language() != null && !scope.language().equalsIgnoreCase(language.getLiteralLexicalForm())) return null;
        if (scope.author() != null) {
            Node contribution = facts.contribution();
            if (contribution == null || !data.contains(current, contribution, property("author"), uri(scope.author()))) return null;
        }
        if (scope.realm() == null) {
            if (!context.equals(main) || !data.contains(current, main, property("selectionHead"), selection)) return null;
        } else {
            // A Zone population contains actual adoptions, not Realm fallbacks.
            if (!context.equals(uri(scope.realm()))) return null;
            boolean adopted = false;
            var slots = data.find(current, Node.ANY, property("selectionHead"), selection);
            try {
                while (slots.hasNext()) {
                    Node slot = slots.next().getSubject();
                    if (data.contains(current, slot, org.apache.jena.vocabulary.RDF.type.asNode(), property("RealmPublicationSlot"))
                        && data.contains(current, slot, property("realm"), uri(scope.realm()))
                        && data.contains(current, slot, property("mainVersion"), main)) { adopted = true; break; }
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(slots); }
            if (!adopted) return null;
        }
        return facts.key();
    }
    private static boolean canonicalGroupHit(org.apache.jena.sparql.core.DatasetGraph data, RankScope scope,
        IndexSearcher searcher, Query query, String key, String candidateId, int doc, String entityField,
        Map<String, RankUnit> units) throws IOException {
        List<org.apache.lucene.util.BytesRef> ids = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        Map<String, String> selected = new java.util.HashMap<>();
        Node graph = PUBLIC_GRAPH;
        for (String predicate : List.of("mainVersion", "searchResultMain")) {
            var members = data.find(graph, Node.ANY, property(predicate), uri(key));
            try {
                while (members.hasNext()) {
                    Node unit = members.next().getSubject();
                    if (!unit.isURI()) throw new TextIndexException("ranked group identity is invalid");
                    String id = unit.getURI();
                    // The collector already admitted this candidate. A singleton
                    // needs only membership lookup, not a second head read.
                    if (seen.add(id) && (candidateId.equals(id) || key.equals(admittedMain(data, id, scope, units)))) {
                        ids.add(new org.apache.lucene.util.BytesRef(id));
                    }
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(members); }
        }
        if (ids.size() == 1) return true;
        for (var id : ids) {
            Node unit = uri(id.utf8ToString());
            RankUnit facts = units == null ? describeUnit(data, unit.getURI()) : units.get(unit.getURI());
            String identity = facts.main().getURI() + "\n"
                + facts.language().getLiteralLexicalForm().toLowerCase(java.util.Locale.ROOT);
            if (selected.putIfAbsent(identity, id.utf8ToString()) != null)
                throw new TextIndexException("ranked current language selection is ambiguous");
        }
        Query grouped = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
            .add(new org.apache.lucene.search.TermInSetQuery(entityField, ids), BooleanClause.Occur.FILTER).build();
        var best = searcher.search(grouped, 1);
        return best.scoreDocs.length == 1 && best.scoreDocs[0].doc == doc;
    }

    static FilteredGraphTextIndex functionIndex(org.apache.jena.sparql.function.FunctionEnv env) {
        // ARQ may expose the base DatasetGraph to an expression. Jena's normal
        // assembler installs the TextIndex in the merged query context.
        Object index = env.getContext().get(org.apache.jena.query.text.TextQuery.textIndex);
        if (index == null && env.getDataset() instanceof org.apache.jena.query.text.DatasetGraphText text)
            index = text.getTextIndex();
        if (index instanceof FilteredGraphTextIndex filtered) return filtered;
        throw new org.apache.jena.sparql.expr.ExprEvalException("ranked text index is unavailable");
    }

    /** ARQ exposes one bounded JSON envelope, followed by the owner's RDF join
     * over those IDs. A changed Lucene commit is a restart, never an empty page. */
    public static final class RankedFunction extends org.apache.jena.sparql.function.FunctionBase {
        @Override public void checkBuild(String uri, org.apache.jena.sparql.expr.ExprList args) {
            if (args.size() != 5) throw new org.apache.jena.sparql.expr.ExprEvalException("ranked text needs five arguments");
        }
        @Override public org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args) {
            throw new org.apache.jena.sparql.expr.ExprEvalException("ranked text requires a dataset");
        }
        @Override protected org.apache.jena.sparql.expr.NodeValue exec(
            List<org.apache.jena.sparql.expr.NodeValue> args, org.apache.jena.sparql.function.FunctionEnv env) {
            FilteredGraphTextIndex index = functionIndex(env);
            String continuation = args.get(3).asString();
            RankAfter after = null;
            if (!continuation.isEmpty()) {
                JsonObject value = org.apache.jena.atlas.json.JSON.parse(continuation);
                after = new RankAfter(value.get("id").getAsString().value(),
                    Float.parseFloat(value.get("score").getAsString().value()),
                    Long.parseLong(value.get("commit").getAsString().value()));
            }
            JsonObject response = new JsonObject();
            try {
                JsonObject scopeValue = org.apache.jena.atlas.json.JSON.parse(args.get(4).asString());
                RankScope scope = new RankScope(optionalString(scopeValue, "realm"),
                    optionalString(scopeValue, "language"), optionalString(scopeValue, "author"));
                RankPage page = index.ranked(args.get(0).asNode(), args.get(1).asString(),
                    args.get(2).getInteger().intValueExact(), after, env.getDataset(), scope);
                JsonArray hits = new JsonArray();
                for (RankHit hit : page.hits()) {
                    JsonObject row = new JsonObject();
                    row.put("id", hit.id()); row.put("key", hit.key()); row.put("score", Float.toString(hit.score())); hits.add(row);
                }
                response.put("hits", hits); response.put("count", page.count());
                response.put("precision", page.precision()); response.put("commit", Long.toString(page.commit()));
                response.put("more", page.more());
            } catch (TextIndexException ex) {
                if (!ex.getMessage().contains("requires restart")) throw ex;
                response.put("restart", true);
            }
            return org.apache.jena.sparql.expr.NodeValue.makeString(response.toString());
        }
        private static String optionalString(JsonObject object, String key) {
            var value = object.get(key);
            return value == null ? null : value.getAsString().value();
        }
    }

    @Override public void prepareCommit() { lucene.prepareCommit(); }
    @Override public void commit() { lucene.commit(); }
    @Override public void rollback() { lucene.rollback(); }
    @Override public void close() { lucene.close(); }
    @Override public void addEntity(Entity entity) { lucene.addEntity(entity); }
    @Override public void updateEntity(Entity entity) { lucene.updateEntity(entity); }
    @Override public void deleteEntity(Entity entity) { lucene.deleteEntity(entity); }
    @Override public Map<String, Node> get(String uri) { return lucene.get(uri); }
    @Override public EntityDefinition getDocDef() { return lucene.getDocDef(); }

    @Override public List<TextHit> query(Node property, String qs, String graph, String lang) {
        return query(property, qs, graph, lang, DEFAULT_LIMIT);
    }
    @Override public List<TextHit> query(Node property, String qs, String graph, String lang, int limit) {
        return query(property, qs, graph, lang, limit, null);
    }
    @Override public List<TextHit> query(Node property, String qs, String graph, String lang,
                                         int limit, String highlight) {
        return query((String)null, property == null ? List.of()
            : List.of(ResourceFactory.createResource(property.getURI())), qs, graph, lang, limit, highlight);
    }
    @Override public List<TextHit> query(List<Resource> properties, String qs, String graph,
                                         String lang, int limit, String highlight) {
        return query((String)null, properties, qs, graph, lang, limit, highlight);
    }
    @Override public List<TextHit> query(String subject, Node property, String qs,
                                         String graph, String lang, int limit, String highlight) {
        return query(subject, property == null ? List.of()
            : List.of(ResourceFactory.createResource(property.getURI())), qs, graph, lang, limit, highlight);
    }
    @Override public List<TextHit> query(Node subject, List<Resource> properties, String qs,
                                         String graph, String lang, int limit, String highlight) {
        return query(subject != null && subject.isURI() ? subject.getURI() : null,
            properties, qs, graph, lang, limit, highlight);
    }
    @Override public List<TextHit> query(String subject, List<Resource> properties, String qs,
                                         String graph, String lang, int limit, String highlight) {
        if (graph == null) return lucene.query(subject, properties, qs, null, lang, limit, highlight);
        // Legacy complete readers and the offline rebuild audit retain their
        // explicit limits. Ranked pages and generation qualification use the
        // bounded collector and streaming audit above.
        if (properties.size() != 1 || lang != null || highlight != null || limit > MAX_ADMITTED_LIMIT) {
            throw new TextIndexException("unsupported named-graph text profile");
        }
        EntityDefinition definition = lucene.getDocDef();
        String field = definition.getField(properties.get(0).asNode());
        if (field == null || definition.getGraphField() == null) {
            throw new TextIndexException("named-graph text field is unavailable");
        }
        try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
            QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
            parser.setAllowLeadingWildcard(true);
            Query body = parser.parse(qs);
            BooleanQuery.Builder filtered = new BooleanQuery.Builder()
                .add(body, BooleanClause.Occur.MUST)
                .add(new TermQuery(new Term(definition.getGraphField(), graph)), BooleanClause.Occur.FILTER);
            if (subject != null) filtered.add(new TermQuery(new Term(definition.getEntityField(), subject)),
                BooleanClause.Occur.FILTER);
            IndexSearcher searcher = new IndexSearcher(reader);
            var hits = searcher.search(filtered.build(), limit <= 0 ? DEFAULT_LIMIT : limit);
            var stored = searcher.storedFields();
            List<TextHit> result = new ArrayList<>(hits.scoreDocs.length);
            for (var hit : hits.scoreDocs) {
                Document document = stored.document(hit.doc);
                String entity = document.get(definition.getEntityField());
                String value = document.get(field);
                String sourceGraph = document.get(definition.getGraphField());
                if (entity == null || value == null || !graph.equals(sourceGraph)) {
                    throw new TextIndexException("named-graph text document is incomplete");
                }
                String language = definition.getLangField() == null ? null
                    : document.get(definition.getLangField());
                Node literal = language == null || language.isEmpty()
                    ? NodeFactory.createLiteralString(value)
                    : language.startsWith("^^")
                        ? NodeFactory.createLiteralDT(value,
                            TypeMapper.getInstance().getSafeTypeByName(language.substring(2)))
                        : NodeFactory.createLiteralLang(value, language);
                result.add(new TextHit(TextQueryFuncs.stringToNode(entity), hit.score, literal,
                    TextQueryFuncs.stringToNode(sourceGraph), properties.get(0).asNode()));
            }
            return result;
        } catch (IOException | ParseException ex) {
            throw new TextIndexException("named-graph text query failed", ex);
        }
    }
}
