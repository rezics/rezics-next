package com.rezics.jena;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TotalHits;
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

    public record RankHit(String id, float score, String key, Integer document) {
        public RankHit(String id, float score) { this(id, score, id, null); }
        public RankHit(String id, float score, String key) { this(id, score, key, null); }
    }
    public record RankAfter(String id, float score, long commit, Integer document) {
        public RankAfter(String id, float score, long commit) { this(id, score, commit, null); }
    }
    public record RankPage(List<RankHit> hits, long count, String precision, long commit, boolean more) {}
    public record RankScope(String realm, String language, String author, boolean catalogue, String names, List<String> resources) {
        public RankScope(String realm, String language, String author, boolean catalogue) { this(realm, language, author, catalogue, null, null); }
        public RankScope(String realm, String language, String author) { this(realm, language, author, false, null, null); }
    }
    static final class RankRestart extends TextIndexException {
        RankRestart() { super("ranked continuation requires restart"); }
    }

    /** Lucene top-k/searchAfter scores only: no stored fields or RDF in the
     * collector. The stable unit ID resolves the cursor's doc in its pinned
     * commit; ties follow Lucene doc order until that commit changes. Admission
     * and canonical grouping examine only the returned page. A rejected hit
     * retains its cursor identity with a null key, so bounded refills advance
     * even through an entirely filtered page. Counts here are raw documents;
     * the public reader counts only its disclosed, grouped results. */
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
                throw new RankRestart();
            QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
            // The API supplies a literal phrase, never Lucene operators.
            Query body = parser.parse("\"" + phrase.replace("\\", "\\\\").replace("\"", "\\\"") + "\"");
            boolean names = scope != null && scope.names() != null;
            boolean catalogue = scope != null && scope.catalogue();
            Query text = body;
            if (catalogue) {
                if (!"body".equals(field)) throw new TextIndexException("catalogue ranking requires the body field");
                QueryParser titles = new QueryParser("publicTitle", lucene.getQueryAnalyzer());
                titles.setDefaultOperator(QueryParser.Operator.AND);
                // Every analyzed word must occur in one authored name. Names
                // and bodies are distinct Jena documents, never concatenated.
                String words = java.util.Arrays.stream(phrase.split("\\s+"))
                    .map(word -> "\"" + word.replace("\\", "\\\\").replace("\"", "\\\"") + "\"")
                    .collect(java.util.stream.Collectors.joining(" "));
                Query title = titles.parse(words);
                // A name tier above BM25's bounded 80-character query scores
                // preserves body relevance while putting names first. Lucene
                // documents/term frequencies are bounded by signed integers.
                text = new org.apache.lucene.search.DisjunctionMaxQuery(List.of(
                    new org.apache.lucene.search.BoostQuery(new org.apache.lucene.search.ConstantScoreQuery(title), 1_000_000f),
                    body), 0f);
            }
            Query query = new BooleanQuery.Builder()
                .add(text, BooleanClause.Occur.MUST)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)),
                    BooleanClause.Occur.FILTER).build();
            IndexSearcher searcher = new IndexSearcher(reader);
            long deadline = System.nanoTime() + 1_000_000_000L;
            searcher.setTimeout(() -> System.nanoTime() >= deadline);
            String entityField = lucene.getDocDef().getEntityField();
            if (scope != null && scope.realm() != null) {
                // RDF's context object index supplies Realm units, independent
                // of the phrase match population. Actual current adoption is
                // still checked on each returned candidate.
                List<org.apache.lucene.util.BytesRef> ids = new ArrayList<>();
                var members = data.find(PUBLIC_GRAPH, Node.ANY, property("context"), uri(scope.realm()));
                try { while (members.hasNext()) {
                    Node unit = members.next().getSubject();
                    if (unit.isURI()) ids.add(new org.apache.lucene.util.BytesRef(unit.getURI()));
                } } finally { org.apache.jena.atlas.iterator.Iter.close(members); }
                query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                    .add(new org.apache.lucene.search.TermInSetQuery(entityField, ids), BooleanClause.Occur.FILTER).build();
            }
            if (names) query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField,
                    PublicNameProjection.PREFIX + (scope.names().equals("all") ? "" : scope.names() + ":"))),
                    BooleanClause.Occur.FILTER).build();
            else query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                // Public resource names must not consume the Work candidate budget.
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField, PublicNameProjection.PREFIX)),
                    BooleanClause.Occur.MUST_NOT)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField, PublicNameProjection.DIRECTORY)),
                    BooleanClause.Occur.MUST_NOT).build();
            if (names && scope.resources() != null) {
                if (scope.resources().size() > 64) throw new TextIndexException("name candidate bound exceeded");
                List<org.apache.lucene.util.BytesRef> units = new ArrayList<>();
                for (String resource : scope.resources()) {
                    var members = data.find(PUBLIC_GRAPH, Node.ANY, uri(RV + "resource"), uri(resource));
                    try { while (members.hasNext()) units.add(new org.apache.lucene.util.BytesRef(members.next().getSubject().getURI())); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(members); }
                }
                query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                    .add(new org.apache.lucene.search.TermInSetQuery(entityField, units), BooleanClause.Occur.FILTER).build();
            }
            ScoreDoc cursor = null;
            if (after != null) {
                if (catalogue || names) {
                    // One unit can have a body and many name documents. Its
                    // URI alone cannot identify a searchAfter position.
                    if (after.document() == null || after.document() < 0 || after.document() >= reader.maxDoc()
                        || !after.id().equals(searcher.storedFields().document(after.document(),
                            java.util.Set.of(entityField)).get(entityField))) throw new RankRestart();
                    cursor = new ScoreDoc(after.document(), after.score());
                } else {
                Query identity = new BooleanQuery.Builder()
                    .add(query, BooleanClause.Occur.MUST)
                    .add(new TermQuery(new Term(entityField, after.id())), BooleanClause.Occur.FILTER)
                    .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)),
                        BooleanClause.Occur.FILTER).build();
                var resolved = searcher.search(identity, 2);
                if (resolved.scoreDocs.length != 1) throw new RankRestart();
                cursor = new ScoreDoc(resolved.scoreDocs[0].doc, after.score());
                }
            }
            // Lucene's default hit-count threshold is 1000. It can skip
            // noncompetitive blocks instead of exhaustively scoring/counting.
            var top = searcher.searchAfter(cursor, query, size + 1);
            boolean more = top.scoreDocs.length > size;
            List<RankHit> ordered = new ArrayList<>();
            var stored = searcher.storedFields();
            for (int n = 0; n < Math.min(size, top.scoreDocs.length); n++) {
                if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
                var hit = top.scoreDocs[n];
                String id = stored.document(hit.doc, java.util.Set.of(entityField)).get(entityField);
                if (id == null || !Float.isFinite(hit.score)) throw new TextIndexException("ranked document is incomplete");
                String key = names ? id : scope == null ? id : admittedMain(data, id, scope);
                if (names) {
                    Query entity = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                        .add(new TermQuery(new Term(entityField, id)), BooleanClause.Occur.FILTER).build();
                    var best = searcher.search(entity, 1);
                    if (best.scoreDocs.length != 1 || best.scoreDocs[0].doc != hit.doc) key = null;
                }
                if (!names && key != null && scope != null && !canonicalGroupHit(data, scope, searcher, query, key,
                    id, hit.doc, entityField)) key = null;
                ordered.add(new RankHit(id, hit.score, key, catalogue || names ? hit.doc : null));
            }
            if (searcher.timedOut()) throw new TextIndexException("ranked query deadline exceeded");
            return new RankPage(List.copyOf(ordered), top.totalHits.value(),
                top.totalHits.relation() == TotalHits.Relation.EQUAL_TO ? "exact" : "lower-bound", commit, more);
        } catch (IOException | ParseException ex) { throw new TextIndexException("ranked query failed", ex); }
    }

    static final int OCCURRENCE_VISITS = 4096;
    /** Ordered token terms live in the same Lucene documents and writer as
     * the text fields. Seek chooses the rarest analyzed token, then checks the
     * full phrase only on <=101 candidates. Deleted/rejected terms advance with
     * matches=false, following the search owner's bounded directory pattern. */
    JsonObject occurrences(Node generation, Node revision, Node parent, String phrase, String after, int size) {
        if (size < 1 || size > 101 || phrase.length() > 4000 || after.length() > 134)
            throw new TextIndexException("occurrence search exceeds its input budget");
        if (!"occurrenceLabel".equals(lucene.getDocDef().getField(OccurrenceLabelIndex.p("occurrenceSearchLabels"))))
            throw new TextIndexException("occurrence label field is not installed");
        try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
            String field = lucene.getDocDef().getEntityField(), scope = OccurrenceLabelIndex.scope(generation, revision, parent);
            String lower = scope + after.replace('\u0001', '!').replace("https://rezics.com/id/", "");
            Query scopeQuery = new BooleanQuery.Builder()
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), OccurrenceLabelIndex.TEXT.getURI())), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term("occurrenceScope", scope)), BooleanClause.Occur.FILTER).build();
            QueryParser parser = new QueryParser("occurrenceLabel", lucene.getQueryAnalyzer());
            Query text = parser.parse("\"" + phrase.replace("\\", "\\\\").replace("\"", "\\\"") + "\"");
            IndexSearcher searcher = new IndexSearcher(reader);
            long deadline = System.nanoTime() + 1_000_000_000L;
            searcher.setTimeout(() -> System.nanoTime() >= deadline);
            int reads = 0;
            String rarest = null; int frequency = Integer.MAX_VALUE;
            var labels = org.apache.lucene.index.MultiTerms.getTerms(reader, "occurrenceLabel");
            if (labels != null) {
                var terms = labels.iterator();
                for (String token : occurrenceTokens(lucene.getQueryAnalyzer(), phrase)) {
                    reads++;
                    if (!terms.seekExact(new org.apache.lucene.util.BytesRef(token))) { rarest = null; break; }
                    if (terms.docFreq() < frequency) { rarest = token; frequency = terms.docFreq(); }
                }
            }
            Map<String, Boolean> keys = new java.util.TreeMap<>();
            var directory = org.apache.lucene.index.MultiTerms.getTerms(reader, "occurrenceDirectory");
            if (directory != null) for (String token : java.util.Arrays.asList(rarest, "\u0000navigation")) {
                if (token == null) continue;
                boolean navigation = token.equals("\u0000navigation");
                String prefix = scope + "\u0001" + token + "\u0001";
                var iterator = directory.iterator();
                var status = iterator.seekCeil(new org.apache.lucene.util.BytesRef(prefix + (after.isEmpty() ? scope : lower + ":~")));
                if (status == org.apache.lucene.index.TermsEnum.SeekStatus.END) continue;
                var term = iterator.term();
                for (int n = 0; n < size && term != null && term.utf8ToString().startsWith(prefix); n++, term = iterator.next()) {
                    if (System.nanoTime() >= deadline || ++reads > OCCURRENCE_VISITS)
                        throw new TextIndexException("occurrence directory budget exceeded");
                    String id = term.utf8ToString().substring(prefix.length());
                    Query query = new BooleanQuery.Builder().add(scopeQuery, BooleanClause.Occur.FILTER)
                        .add(new TermQuery(new Term(field, id)), BooleanClause.Occur.FILTER)
                        .add(navigation ? new TermQuery(new Term("occurrenceNavigation", "true")) : text, BooleanClause.Occur.FILTER).build();
                    // An entity has one document, including all label languages.
                    boolean matches = searcher.search(query, 1).scoreDocs.length == 1;
                    reads++;
                    keys.merge(id, !navigation && matches, (x, y) -> x || y);
                }
            }
            if (searcher.timedOut()) throw new TextIndexException("occurrence search deadline exceeded");
            JsonArray items = new JsonArray();
            for (var entry : keys.entrySet()) {
                String encoded = entry.getKey().substring(scope.length());
                String[] key = encoded.substring(0, encoded.lastIndexOf(':')).split("!", -1);
                if (key.length != 3) throw new TextIndexException("occurrence text identity is invalid");
                JsonObject item = new JsonObject(); item.put("segmentKey", key[0]); item.put("orderKey", key[1]);
                item.put("occurrence", "https://rezics.com/id/" + key[2]); item.put("matches", entry.getValue());
                items.add(item); if (items.size() == size) break;
            }
            JsonObject result = new JsonObject(); result.put("items", items); result.put("reads", reads);
            result.put("commit", Long.toString(reader.getIndexCommit().getGeneration())); return result;
        } catch (IOException | ParseException error) { throw new TextIndexException("occurrence search failed", error); }
    }
    static java.util.Set<String> occurrenceTokens(org.apache.lucene.analysis.Analyzer analyzer, String value) throws IOException {
        var tokens = new java.util.LinkedHashSet<String>();
        try (var stream = analyzer.tokenStream("occurrenceLabel", value)) {
            var term = stream.addAttribute(org.apache.lucene.analysis.tokenattributes.CharTermAttribute.class);
            stream.reset(); while (stream.incrementToken()) tokens.add(term.toString()); stream.end();
        }
        return tokens;
    }

    private static final String RV = "https://rezics.com/vocab/";
    /** A sorted, maintained projection in the existing entity term dictionary.
     * Retains <=64 terms. Deleted terms advance with a null key, so even merge
     * lag has a declared candidate bound and an advancing continuation.
     * TermsEnum orders UTF-8 keys and seekCeil finds the next key:
     * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/TermsEnum.html */
    RankPage directory(String kind, String order, int size, RankAfter after,
                       org.apache.jena.sparql.core.DatasetGraph data) {
        if (size < 1 || size > 64 || !java.util.Set.of("concept", "space", "realm", "site", "agent", "collection", "work").contains(kind)
            || !java.util.Set.of("identity", "newest", "updated").contains(order))
            throw new TextIndexException("directory query is not admitted");
        boolean identity = order.equals("identity");
        String prefix = identity ? PublicNameProjection.PREFIX + kind + ":"
            : PublicNameProjection.DIRECTORY + kind + ":" + order + ":";
        try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
            long commit = reader.getIndexCommit().getGeneration();
            if (after != null && (after.commit() != commit || !after.id().startsWith(prefix))) throw new RankRestart();
            var terms = org.apache.lucene.index.MultiTerms.getTerms(reader, lucene.getDocDef().getEntityField());
            if (terms == null) return new RankPage(List.of(), 0, "exact", commit, false);
            var iterator = terms.iterator();
            String start = after == null ? prefix : after.id();
            if (iterator.seekCeil(new org.apache.lucene.util.BytesRef(start)) == org.apache.lucene.index.TermsEnum.SeekStatus.END)
                return new RankPage(List.of(), 0, "exact", commit, false);
            var term = iterator.term();
            if (after != null && term.utf8ToString().equals(after.id())) term = iterator.next();
            List<RankHit> hits = new ArrayList<>();
            while (term != null && term.utf8ToString().startsWith(prefix) && hits.size() < size) {
                String id = term.utf8ToString();
                var members = data.find(PUBLIC_GRAPH, uri(id), uri(RV + (identity ? "resource" : "nameDirectoryResource")), Node.ANY);
                Node resource = null;
                try { if (members.hasNext()) resource = members.next().getObject(); }
                finally { org.apache.jena.atlas.iterator.Iter.close(members); }
                hits.add(new RankHit(id, 0f, resource != null && resource.isURI() ? resource.getURI() : null));
                term = iterator.next();
            }
            boolean more = term != null && term.utf8ToString().startsWith(prefix);
            return new RankPage(List.copyOf(hits), hits.size(), more ? "lower-bound" : "exact", commit, more);
        } catch (IOException ex) { throw new TextIndexException("directory query failed", ex); }
    }
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

    /** Called only for the page's candidates and their grouping witnesses. */
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
    private static String admittedMain(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope) {
        RankUnit facts = describeUnit(data, id);
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
        IndexSearcher searcher, Query query, String key, String candidateId, int doc, String entityField) throws IOException {
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
                    if (seen.add(id) && (candidateId.equals(id) || key.equals(admittedMain(data, id, scope)))) {
                        ids.add(new org.apache.lucene.util.BytesRef(id));
                    }
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(members); }
        }
        if (ids.size() == 1 && !scope.catalogue()) return true;
        for (var id : ids) {
            Node unit = uri(id.utf8ToString());
            RankUnit facts = describeUnit(data, unit.getURI());
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
                    Long.parseLong(value.get("commit").getAsString().value()),
                    value.hasKey("document") ? value.get("document").getAsNumber().value().intValue() : null);
            }
            JsonObject response = new JsonObject();
            try {
                JsonObject scopeValue = org.apache.jena.atlas.json.JSON.parse(args.get(4).asString());
                List<String> resources = null;
                if (scopeValue.hasKey("resources")) {
                    resources = new ArrayList<>();
                    for (var resource : scopeValue.get("resources").getAsArray()) resources.add(resource.getAsString().value());
                }
                RankScope scope = new RankScope(optionalString(scopeValue, "realm"),
                    optionalString(scopeValue, "language"), optionalString(scopeValue, "author"),
                    scopeValue.hasKey("catalogue") && scopeValue.get("catalogue").getAsBoolean().value(),
                    optionalString(scopeValue, "names"), resources);
                RankPage page = scopeValue.hasKey("directory")
                    ? index.directory(scope.names(), optionalString(scopeValue, "directory"),
                        args.get(2).getInteger().intValueExact(), after, env.getDataset())
                    : index.ranked(args.get(0).asNode(), args.get(1).asString(),
                        args.get(2).getInteger().intValueExact(), after, env.getDataset(), scope);
                JsonArray hits = new JsonArray();
                for (RankHit hit : page.hits()) {
                    JsonObject row = new JsonObject();
                    row.put("id", hit.id());
                    if (hit.key() == null) row.put("key", org.apache.jena.atlas.json.JsonNull.instance);
                    else row.put("key", hit.key());
                    row.put("score", Float.toString(hit.score())); hits.add(row);
                    if (hit.document() != null) row.put("document", hit.document());
                }
                response.put("hits", hits); response.put("commit", Long.toString(page.commit()));
                response.put("more", page.more());
            } catch (RankRestart ex) {
                response.put("restart", true);
            }
            return org.apache.jena.sparql.expr.NodeValue.makeString(response.toString());
        }
        private static String optionalString(JsonObject object, String key) {
            var value = object.get(key);
            return value == null ? null : value.getAsString().value();
        }
    }

    @Override public void prepareCommit() { CommandWork.timed("text_prepare", lucene::prepareCommit); }
    @Override public void commit() { CommandWork.timed("text_commit", lucene::commit); }
    @Override public void rollback() { lucene.rollback(); }
    @Override public void close() { lucene.close(); }
    @Override public void addEntity(Entity entity) {
        CommandWork.count("text_adds", 1);
        CommandWork.timed("text_index", () -> addMeasuredEntity(entity));
    }
    private void addMeasuredEntity(Entity entity) {
        if (!entity.getMap().containsKey(OccurrenceTextSchema.FIELD)) { lucene.addEntity(entity); return; }
        try { lucene.getIndexWriter().addDocument(occurrenceDocument(entity)); }
        catch (IOException error) { throw new TextIndexException("occurrence text write failed", error); }
    }
    private Document occurrenceDocument(Entity entity) {
        // Same writer, analyzer, rollback and commit as every existing text field.
        // Ordered analyzed-token terms add no second engine, substring
        // dictionary, page log or story-sized postings cache.
        String field = lucene.getDocDef().getEntityField();
        Document doc = new Document();
        doc.add(new org.apache.lucene.document.Field(field, entity.getId(), TextIndexLucene.ftIRI));
        String scope = entity.getId().substring(0, OccurrenceLabelIndex.PREFIX.length() + 3 * 37);
        doc.add(new org.apache.lucene.document.StringField("occurrenceScope", scope, org.apache.lucene.document.Field.Store.NO));

        doc.add(new org.apache.lucene.document.Field(lucene.getDocDef().getGraphField(), entity.getGraph(), TextIndexLucene.ftIRI));
        if (entity.getId().endsWith(":navigation")) {
            doc.add(new org.apache.lucene.document.StringField("occurrenceNavigation", "true", org.apache.lucene.document.Field.Store.NO));
            doc.add(new org.apache.lucene.document.StringField("occurrenceDirectory", scope + "\u0001\u0000navigation\u0001" + entity.getId(), org.apache.lucene.document.Field.Store.NO));
        }
        var tokens = new java.util.LinkedHashSet<String>();
        for (var entry : entity.getMap().entrySet()) {
            String value = (String) entry.getValue();
            // One document per occurrence. Multivalued text fields retain
            // label boundaries through the analyzer's large position gap.
            // Stored JSON and analyzed labels have distinct field names. Even
            // an unlabeled navigation occurrence uses the same indexed type.
            doc.add(new org.apache.lucene.document.StoredField(OccurrenceTextSchema.PAYLOAD, value));
            JsonArray labels = org.apache.jena.atlas.json.JSON.parse(value).get("labels").getAsArray();
            if (labels.size() > 18) throw new TextIndexException("occurrence labels exceed their write bound");
            if (labels.isEmpty()) doc.add(new org.apache.lucene.document.Field(
                OccurrenceTextSchema.FIELD, "", OccurrenceTextSchema.TYPE));
            for (var item : labels) {
                JsonObject label = item.getAsObject();
                doc.add(new org.apache.lucene.document.Field(OccurrenceTextSchema.FIELD,
                    label.get("value").getAsString().value(), OccurrenceTextSchema.TYPE));
                doc.add(new org.apache.lucene.document.StringField(lucene.getDocDef().getLangField(), label.get("language").getAsString().value(), org.apache.lucene.document.Field.Store.YES));
                try { tokens.addAll(occurrenceTokens(lucene.getAnalyzer(), label.get("value").getAsString().value())); }
                catch (IOException error) { throw new TextIndexException("occurrence analysis failed", error); }
            }
            doc.add(new org.apache.lucene.document.StringField(lucene.getDocDef().getUidField(),
                entity.getChecksum(entry.getKey(), value), org.apache.lucene.document.Field.Store.NO));
        }
        for (String token : tokens) doc.add(new org.apache.lucene.document.StringField("occurrenceDirectory",
            scope + "\u0001" + token + "\u0001" + entity.getId(), org.apache.lucene.document.Field.Store.NO));
        return doc;
    }
    @Override public void updateEntity(Entity entity) {
        CommandWork.count("text_updates", 1);
        CommandWork.timed("text_index", () -> {
            if (!entity.getMap().containsKey(OccurrenceTextSchema.FIELD)) { lucene.updateEntity(entity); return; }
            try { lucene.getIndexWriter().updateDocument(new Term(lucene.getDocDef().getEntityField(), entity.getId()),
                occurrenceDocument(entity)); }
            catch (IOException error) { throw new TextIndexException("occurrence text update failed", error); }
        });
    }
    @Override public void deleteEntity(Entity entity) {
        CommandWork.count("text_deletes", 1);
        CommandWork.timed("text_index", () -> lucene.deleteEntity(entity));
    }
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
            if (CommandPolicy.PUBLIC_SEARCH.equals(graph)) {
                filtered.add(new org.apache.lucene.search.PrefixQuery(new Term(definition.getEntityField(), PublicNameProjection.PREFIX)),
                    BooleanClause.Occur.MUST_NOT);
                filtered.add(new org.apache.lucene.search.PrefixQuery(new Term(definition.getEntityField(), PublicNameProjection.DIRECTORY)),
                    BooleanClause.Occur.MUST_NOT);
            }
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
