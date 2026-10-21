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
import org.apache.lucene.index.ConcurrentMergeScheduler;
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
    private static final java.util.concurrent.atomic.AtomicReference<java.lang.ref.WeakReference<FilteredGraphTextIndex>> mergeIndex =
        new java.util.concurrent.atomic.AtomicReference<>(new java.lang.ref.WeakReference<>(null));
    private final TextIndexLucene lucene;
    private final org.apache.lucene.store.Directory directory;
    static final long RANK_BASIS_TTL_MS = 5 * 60_000;
    static final int MAX_RANK_BASES = 64;
    private static final java.util.concurrent.atomic.AtomicLong rankBasisIds = new java.util.concurrent.atomic.AtomicLong();
    private static final java.util.concurrent.ScheduledExecutorService rankExpiryExecutor =
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor(task -> {
            var thread = new Thread(task, "ranked-reader-expiry"); thread.setDaemon(true); return thread;
        });
    private final java.util.concurrent.ScheduledFuture<?> rankExpiryTask;
    private final java.util.function.LongSupplier rankClock;
    private final Map<Long, RankedBasis> rankBases = new java.util.LinkedHashMap<>();
    private record RankedBasis(DirectoryReader reader, long expiresAt) {}
    private record RankedReader(DirectoryReader reader, long token, long expiresAt) implements AutoCloseable {
        @Override public void close() throws IOException { reader.decRef(); }
    }
    static final String RANK_CONTEXT = "rankContext", RANK_GROUP = "rankGroup", RANK_SCHEMA = "rankMetadataVersion";
    static final String TITLE_KIND = "rankTitleKind";
    private java.lang.ref.WeakReference<org.apache.jena.sparql.core.DatasetGraph> rankData = new java.lang.ref.WeakReference<>(null);
    void bindRankData(org.apache.jena.sparql.core.DatasetGraph data) {
        // Command scopes/observers are temporary; the index shares the
        // persistent text dataset's lifecycle across transactions and reads.
        while (data instanceof org.apache.jena.sparql.core.DatasetGraphWrapper wrapper
            && !(data instanceof org.apache.jena.query.text.DatasetGraphText)) data = wrapper.getWrapped();
        if (data instanceof org.apache.jena.query.text.DatasetGraphText) rankData = new java.lang.ref.WeakReference<>(data);
    }
    private record RankMetadata(String context, String group) {}
    private static RankMetadata rankMetadata(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        Node unit = uri(id), context = namedValue(data, PUBLIC_GRAPH, unit, "context");
        Node result = namedValue(data, PUBLIC_GRAPH, unit, "searchResultMain");
        Node main = namedValue(data, PUBLIC_GRAPH, unit, "mainVersion");
        Node group = result == null ? main : result;
        return context != null && context.isURI() && group != null && group.isURI()
            ? new RankMetadata(context.getURI(), group.getURI()) : null;
    }
    /** The existing writer owns these exact terms, alongside its text values.
     * A startup replay seeds old/offline generations before reads open. */
    boolean rankMetadataMissing() {
        try (var reader = openWriterReader()) {
            var missing = new BooleanQuery.Builder()
                .add(new BooleanQuery.Builder().add(new org.apache.lucene.search.FieldExistsQuery("body"), BooleanClause.Occur.SHOULD)
                    .add(new org.apache.lucene.search.FieldExistsQuery("publicTitle"), BooleanClause.Occur.SHOULD).build(), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(lucene.getDocDef().getEntityField(), PublicNameProjection.PREFIX)), BooleanClause.Occur.MUST_NOT)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(lucene.getDocDef().getEntityField(), PublicNameProjection.DIRECTORY)), BooleanClause.Occur.MUST_NOT)
                .add(new TermQuery(new Term(RANK_SCHEMA, "1")), BooleanClause.Occur.MUST_NOT).build();
            var titleKinds = new BooleanQuery.Builder()
                .add(new org.apache.lucene.search.FieldExistsQuery("publicTitle"), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
                .add(new org.apache.lucene.search.TermInSetQuery(TITLE_KIND, List.of(
                    new org.apache.lucene.util.BytesRef("work"), new org.apache.lucene.util.BytesRef("cache"),
                    new org.apache.lucene.util.BytesRef("other"))), BooleanClause.Occur.MUST_NOT).build();
            var searcher = new IndexSearcher(reader);
            return searcher.count(missing) != 0 || searcher.count(titleKinds) != 0;
        } catch (IOException error) { throw new TextIndexException("rank metadata inspection failed", error); }
    }
    static void refreshRankMetadata(org.apache.jena.sparql.core.DatasetGraph data, List<SearchDeltaJournal.Change> changes, boolean rebuild) {
        org.apache.jena.sparql.core.DatasetGraph base = data;
        while (base instanceof org.apache.jena.sparql.core.DatasetGraphWrapper wrapper
            && !(base instanceof org.apache.jena.query.text.DatasetGraphText)) base = wrapper.getWrapped();
        if (!(base instanceof org.apache.jena.query.text.DatasetGraphText text)
            || !(text.getTextIndex() instanceof FilteredGraphTextIndex index)) return;
        index.bindRankData(data);
        if (changes.size() > SearchDeltaJournal.MAX_UNITS) throw new TextIndexException("rank metadata delta exceeds its admitted bound");
        for (var change : changes) index.refreshRankSubject(data, change.unit());
        if (rebuild) index.refreshRankRebuild(data);
    }
    void refreshRankSubject(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        if (id.startsWith(PublicNameProjection.PREFIX) || id.startsWith(PublicNameProjection.DIRECTORY)) return;
        bindRankData(data);
        // Resolve all source pins before deleting any physical document. RDF
        // remains the authority and the body stays available to graph queries.
        var source = contentBodySource(data, id);
        try {
            Query identity = new BooleanQuery.Builder()
                .add(new TermQuery(new Term(lucene.getDocDef().getEntityField(), id)), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
                .add(new BooleanQuery.Builder()
                    .add(new org.apache.lucene.search.FieldExistsQuery("body"), BooleanClause.Occur.SHOULD)
                    .add(new org.apache.lucene.search.FieldExistsQuery("publicTitle"), BooleanClause.Occur.SHOULD).build(), BooleanClause.Occur.FILTER).build();
            lucene.getIndexWriter().deleteDocuments(identity);
            for (String predicate : List.of("searchBody", "publicTitle")) {
                int bound = predicate.equals("searchBody") ? 1 : CatalogueNamePolicy.BODY_NAME_LIMIT;
                var rows = data.find(PUBLIC_GRAPH, uri(id), uri(RV + predicate), Node.ANY);
                try { for (int count = 0; rows.hasNext(); count++) {
                    if (count == bound) throw new TextIndexException("rank metadata owner text exceeds its admitted bound");
                    Node value = rows.next().getObject();
                    if (!value.isLiteral()) throw new TextIndexException("rank metadata text is not literal");
                    CommandWork.count("rank_metadata_values_visited", 1);
                    if (predicate.equals("searchBody") && source != null) {
                        var rank = rankMetadata(data, id);
                        TextEntityDocuments.replaceRankedBody(lucene, contentBodyScope(id),
                            List.of(new TextEntityDocuments.Row(value, source)),
                            rank == null ? null : rank.context(), rank == null ? null : rank.group());
                        continue;
                    }
                    Entity entity = new Entity(id, CommandPolicy.PUBLIC_SEARCH, value.getLiteralLanguage(), value.getLiteralDatatype());
                    entity.put(predicate.equals("searchBody") ? "body" : "publicTitle", value.getLiteralLexicalForm());
                    lucene.getIndexWriter().addDocument(rankDocument(entity, rankMetadata(data, id)));
                } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            }
        } catch (IOException error) { throw new TextIndexException("rank metadata write failed", error); }
    }
    void refreshRankRebuild(org.apache.jena.sparql.core.DatasetGraph data) {
        // A native reset is already an explicit whole-generation operation;
        // its empty delta must not certify unseeded metadata. Stream owners
        // under the existing rebuild budget, never from a ranked read.
        long deadline = System.nanoTime() + OccurrenceTextSchema.REBUILD_DEADLINE_MS * 1_000_000L;
        refreshRankRebuild(data, deadline);
    }
    void refreshRankRebuild(org.apache.jena.sparql.core.DatasetGraph data, long deadline) {
        // Partial Content subjects stay in cleanup inventory; only typed units
        // have source pins for this bulk reconstruction to validate.
        var rows = data.find(PUBLIC_GRAPH, Node.ANY, org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "MatchUnit"));
        try { while (rows.hasNext()) {
            if (System.nanoTime() >= deadline) throw new TextIndexException("rank metadata rebuild exceeded its maintenance budget");
            Node owner = rows.next().getSubject();
            if (!owner.isURI()) throw new TextIndexException("rank metadata owner is invalid");
            refreshRankSubject(data, owner.getURI());
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    void migrateLegacyContentReceipts(org.apache.jena.sparql.core.DatasetGraph data, long deadline) {
        // Read the old generation before deleteAll: rebuilding from RDF alone
        // cannot establish the historical receipt's original body evidence.
        var rows = data.find(PUBLIC_GRAPH, Node.ANY, org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "MatchUnit"));
        try { while (rows.hasNext()) {
            if (System.nanoTime() >= deadline) throw new IllegalStateException("text rebuild exceeded its maintenance budget");
            Node owner = rows.next().getSubject();
            if (owner.isURI()) SearchDeltaJournal.migrateLegacyContentReceipt(data, lucene, owner.getURI());
        } } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    private Document rankDocument(Entity entity, RankMetadata metadata) {
        var doc = org.apache.jena.query.text.RezicsLuceneDocument.build(lucene, entity);
        // Normalize the indexed name only. Stored evidence, RDF literals and
        // Jena deletion checksums retain their exact authored bytes.
        var names = doc.getFields("publicTitle");
        doc.removeFields("publicTitle");
        for (var name : names) {
            String value = name.stringValue();
            String normalized = java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFC);
            if (normalized.equals(value)) { doc.add(name); continue; }
            var type = new org.apache.lucene.document.FieldType(name.fieldType());
            type.setStored(false); type.freeze();
            doc.add(new org.apache.lucene.document.Field("publicTitle", normalized, type));
            if (name.fieldType().stored()) doc.add(new org.apache.lucene.document.StoredField("publicTitle", value));
        }
        decorateTitleDocument(doc, entity.getId());
        decorateRankDocument(doc, metadata == null ? null : metadata.context(), metadata == null ? null : metadata.group());
        return doc;
    }
    /** Exact tier postings avoid enumerating name identities or checking every
     * cached title to establish whether a higher-scoring Work name exists. */
    static void decorateTitleDocument(Document doc, String id) {
        if (doc.getField("publicTitle") == null) return;
        String kind = id.startsWith(PublicNameProjection.PREFIX + "work:") ? "work"
            : id.startsWith(PublicNameProjection.PREFIX) || id.startsWith(PublicNameProjection.DIRECTORY) ? "other" : "cache";
        doc.add(new org.apache.lucene.document.StringField(TITLE_KIND, kind, org.apache.lucene.document.Field.Store.NO));
    }
    private Query titleTier(Query text, String kind) {
        Query tier = new BooleanQuery.Builder().add(text, BooleanClause.Occur.MUST)
            .add(new TermQuery(new Term(TITLE_KIND, kind)), BooleanClause.Occur.FILTER).build();
        // The candidate wrapper rejects zero-cost suppliers before opening
        // iterators in unrelated segments, just as it does for body matches.
        return new RankKindQuery(tier, lucene.getDocDef().getEntityField(), false);
    }
    static void decorateRankDocument(Document doc, String context, String group) {
        if ((context == null) != (group == null)) throw new IllegalArgumentException("incomplete rank metadata");
        if (context != null) {
            doc.add(new org.apache.lucene.document.StringField(RANK_CONTEXT, context, org.apache.lucene.document.Field.Store.YES));
            doc.add(new org.apache.lucene.document.StringField(RANK_GROUP, group, org.apache.lucene.document.Field.Store.YES));
        }
        doc.add(new org.apache.lucene.document.StringField(RANK_SCHEMA, "1", org.apache.lucene.document.Field.Store.NO));
    }
    static boolean rankMetadataMatches(org.apache.jena.sparql.core.DatasetGraph data, String id, Document doc) {
        var metadata = rankMetadata(data, id);
        if (!CanonicalPolicy.realmUnitOwnerValid(data, uri(id))) return false;
        return metadata == null ? doc.get(RANK_CONTEXT) == null && doc.get(RANK_GROUP) == null
            : metadata.context().equals(doc.get(RANK_CONTEXT)) && metadata.group().equals(doc.get(RANK_GROUP));
    }

    private static final String CONTENT_UNIT = "urn:rezics:content:match-unit:";
    private static TextEntityDocuments.Scope contentBodyScope(String id) {
        return new TextEntityDocuments.Scope(id, CommandPolicy.PUBLIC_SEARCH, "body");
    }
    /** Delivery pins from retained, natively admitted Content facts. This is an
     * exact consistency check for replay/proof, not a new admission authority. */
    static TextEntityDocuments.Source contentBodySource(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        var source = contentBodyMetadataSource(data, id);
        if (source != null) contentBodyValue(data, id);
        return source;
    }
    static Node contentBodyValue(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        Node body = requiredValue(data, PUBLIC_GRAPH, uri(id), "searchBody");
        if (!CommandService.admittedContentBody(body, requiredValue(data, PUBLIC_GRAPH, uri(id), "language")))
            throw new IllegalStateException("Content body language or bounds differ");
        return body;
    }
    static String contentBodyIdentity(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        return TextEntityDocuments.bodyIdentity(contentBodyScope(id), contentBodyValue(data, id));
    }
    /** Current authority/source pins only; read proof does not reconstruct text from RDF. */
    static TextEntityDocuments.Source contentBodyMetadataSource(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        if (!id.startsWith(CONTENT_UNIT)) return null;
        Node unit = uri(id), revisions = uri(CommandPolicy.REVISIONS);
        if (!data.contains(PUBLIC_GRAPH, unit, Node.ANY, Node.ANY)) return null;
        requireType(data, PUBLIC_GRAPH, unit, "MatchUnit");
        requireValue(data, PUBLIC_GRAPH, unit, "field", uri(RV + "Body"));
        requireValue(data, PUBLIC_GRAPH, unit, "disclosure", uri(RV + "Public"));
        Node language = requiredValue(data, PUBLIC_GRAPH, unit, "language");
        if (!language.isLiteral() || language.getLiteralLexicalForm().length() > 100)
            throw new IllegalStateException("Content language metadata differs");
        Node variant = requiredIri(data, PUBLIC_GRAPH, unit, "variant");
        Node resource = requiredIri(data, PUBLIC_GRAPH, unit, "resource");
        Node revision = requiredIri(data, PUBLIC_GRAPH, unit, "revision");
        Node decision = requiredIri(data, PUBLIC_GRAPH, unit, "publicationDecision");
        Node eligibility = requiredIri(data, PUBLIC_GRAPH, unit, "eligibility");
        Node projection = requiredIri(data, PUBLIC_GRAPH, unit, "projection");
        requireType(data, CURRENT_GRAPH, variant, "ContentVariant");
        requireValue(data, CURRENT_GRAPH, variant, "resource", resource);
        requireValue(data, CURRENT_GRAPH, variant, "contentPublicationHead", decision);
        requireValue(data, CURRENT_GRAPH, variant, "publicSearchEligibilityHead", eligibility);
        requireType(data, revisions, decision, "ContentPublicationDecision");
        if (!CommandService.contentPublicationPublishable(data, decision))
            throw new IllegalStateException(data.contains(revisions, decision,
                org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "ContentWithdrawalDecision"))
                ? "Content publication source is withdrawn" : "Content publication source is erased");
        requireValue(data, revisions, decision, "component", variant);
        requireValue(data, revisions, decision, "resource", resource);
        requireValue(data, revisions, decision, "contentRevision", revision);
        requireType(data, revisions, eligibility, "ContentSearchEligibilityDecision");
        requireValue(data, revisions, eligibility, "variant", variant);
        requireValue(data, revisions, eligibility, "resource", resource);
        requireValue(data, revisions, eligibility, "publicationDecision", decision);
        requireValue(data, revisions, eligibility, "disclosure", uri(RV + "Public"));
        requireType(data, revisions, projection, "ContentProjection");
        requireValue(data, revisions, projection, "matchUnit", unit);
        requireValue(data, revisions, projection, "component", variant);
        requireValue(data, revisions, projection, "resource", resource);
        requireValue(data, revisions, projection, "contentRevision", revision);
        requireValue(data, revisions, projection, "publicationDecision", decision);
        requireValue(data, revisions, projection, "eligibility", eligibility);
        requireValue(data, revisions, projection, "modelRevision", uri("https://rezics.com/definition/content-match-unit-v1"));
        if (data.contains(revisions, decision, uri(org.apache.jena.vocabulary.RDF.type.getURI()), uri(RV + "ErasedRevision"))
            || data.contains(revisions, revision, uri(org.apache.jena.vocabulary.RDF.type.getURI()), uri(RV + "ErasedRevision")))
            throw new IllegalStateException("Content publication source is erased");
        Node digest = requiredValue(data, revisions, decision, "byteDigest");
        Node epoch = requiredValue(data, revisions, decision, "ownerDataEpoch");
        if (!digest.isLiteral() || !epoch.isLiteral()) throw new IllegalStateException("Content source pins are not literals");
        try { return new TextEntityDocuments.Source(revision.getURI(), digest.getLiteralLexicalForm(),
            decision.getURI(), epoch.getLiteralLexicalForm(), "content-match-unit-v1"); }
        catch (IllegalArgumentException malformed) { throw new IllegalStateException("Content source pins are malformed", malformed); }
    }
    static long verifyContentBodyCommitted(org.apache.jena.sparql.core.DatasetGraph data, String id) {
        return verifyContentBodyCommitted(data, id, null, false);
    }
    static long verifyContentBodyCommitted(org.apache.jena.sparql.core.DatasetGraph data, String id, String originalIdentity) {
        return verifyContentBodyCommitted(data, id, originalIdentity, true);
    }
    private static long verifyContentBodyCommitted(org.apache.jena.sparql.core.DatasetGraph data, String id,
                                                   String originalIdentity, boolean receiptBound) {
        var base = data;
        while (base instanceof org.apache.jena.sparql.core.DatasetGraphWrapper wrapper
            && !(base instanceof org.apache.jena.query.text.DatasetGraphText)) base = wrapper.getWrapped();
        if (!(base instanceof org.apache.jena.query.text.DatasetGraphText text)
            || !(text.getTextIndex() instanceof FilteredGraphTextIndex index))
            throw new TextIndexException("Content delivery requires its filtered native writer");
        return verifyContentBody(data, index.lucene, id, originalIdentity, receiptBound);
    }
    static long verifyContentBody(org.apache.jena.sparql.core.DatasetGraph data, TextIndexLucene lucene,
                                  String id, String originalIdentity, boolean receiptBound) {
        var source = receiptBound ? contentBodyMetadataSource(data, id) : contentBodySource(data, id);
        if (!id.startsWith(CONTENT_UNIT)) throw new IllegalArgumentException("not a Content unit");
        var rank = rankMetadata(data, id);
        long generation = receiptBound && source != null
            ? TextEntityDocuments.verifyCommittedRankedIdentity(lucene, contentBodyScope(id), originalIdentity, source,
                requiredValue(data, PUBLIC_GRAPH, uri(id), "language").getLiteralLexicalForm(),
                rank == null ? null : rank.context(), rank == null ? null : rank.group())
            : TextEntityDocuments.verifyCommittedRankedBody(lucene, contentBodyScope(id), source == null ? List.of()
            : List.of(new TextEntityDocuments.Row(requiredValue(data, PUBLIC_GRAPH, uri(id), "searchBody"), source)),
            rank == null ? null : rank.context(), rank == null ? null : rank.group());
        // Include legacy untagged body documents in membership: a tagged copy
        // alongside a legacy row is not a successful replacement.
        try (var lease = openReader(lucene)) {
            DirectoryReader reader = lease.reader();
            var identity = new BooleanQuery.Builder()
                .add(new TermQuery(new Term(lucene.getDocDef().getEntityField(), id)), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
                .add(new org.apache.lucene.search.FieldExistsQuery("body"), BooleanClause.Occur.FILTER).build();
            if (reader.getIndexCommit().getGeneration() != generation
                || new IndexSearcher(reader).count(identity) != (source == null ? 0 : 1))
                throw new TextIndexException("Content committed body membership differs");
            return generation;
        } catch (IOException error) { throw new TextIndexException("Content committed body inspection failed", error); }
    }
    private static Node requiredValue(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String predicate) {
        Node value = namedValue(data, graph, subject, predicate);
        if (value == null) throw new IllegalStateException("Content source field missing or ambiguous: " + predicate);
        return value;
    }
    private static Node requiredIri(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String predicate) {
        Node value = requiredValue(data, graph, subject, predicate);
        if (!value.isURI()) throw new IllegalStateException("Content source reference is not an IRI: " + predicate);
        return value;
    }
    private static void requireValue(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String predicate, Node expected) {
        if (!expected.equals(requiredValue(data, graph, subject, predicate)))
            throw new IllegalStateException("Content source field differs: " + predicate);
    }
    private static void requireType(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String type) {
        if (!data.contains(graph, subject, uri(org.apache.jena.vocabulary.RDF.type.getURI()), uri(RV + type)))
            throw new IllegalStateException("Content source type is missing: " + type);
    }

    public FilteredGraphTextIndex(TextIndexLucene lucene) {
        this(lucene, System::currentTimeMillis);
    }
    FilteredGraphTextIndex(TextIndexLucene lucene, java.util.function.LongSupplier rankClock) {
        this.lucene = lucene;
        this.rankClock = rankClock;
        // The index's location survives transient reader failures and writer rollback/reopen.
        this.directory = lucene.getIndexWriter().getDirectory();
        rankExpiryTask = rankExpiryExecutor.scheduleWithFixedDelay(() -> {
            try { expireRankBases(); }
            catch (IOException error) { org.slf4j.LoggerFactory.getLogger(FilteredGraphTextIndex.class)
                .error("Retained ranked reader expiry failed", error); }
        }, 30, 30, java.util.concurrent.TimeUnit.SECONDS);
        mergeIndex.set(new java.lang.ref.WeakReference<>(this));
    }
    org.apache.lucene.store.Directory physicalDirectory() { return directory; }

    /** A retained reader pins BM25 statistics, document IDs and live-doc bits.
     * Active requests borrow an independent reference; expiry releases only
     * the registry's reference. New admission never evicts a live traversal. */
    private synchronized void expireRankBases() throws IOException {
        long now = rankClock.getAsLong();
        var expired = rankBases.entrySet().iterator();
        while (expired.hasNext()) {
            var entry = expired.next();
            if (entry.getValue().expiresAt() <= now) {
                expired.remove(); entry.getValue().reader().decRef();
            }
        }
    }
    private synchronized RankedReader openRankReader(RankAfter after) throws IOException {
        expireRankBases();
        long now = rankClock.getAsLong();
        long token;
        RankedBasis basis;
        if (after != null) {
            token = after.commit(); basis = rankBases.get(token);
            if (basis == null) throw new RankRestart();
        } else {
            // The request's capture owns the current RDF/text cut. Retain
            // that exact reader, never a writer/NRT view ahead of the graph.
            try (var current = openReader()) {
                var reader = current.reader();
                var existing = rankBases.entrySet().stream()
                    .filter(entry -> entry.getValue().reader().getVersion() == reader.getVersion()).findFirst();
                if (existing.isPresent()) { token = existing.get().getKey(); basis = existing.get().getValue(); }
                else {
                    if (rankBases.size() == MAX_RANK_BASES)
                        throw new TextIndexException("retained ranked basis admission is full");
                    reader.incRef(); token = rankBasisIds.incrementAndGet();
                    basis = new RankedBasis(reader, now + RANK_BASIS_TTL_MS); rankBases.put(token, basis);
                }
            }
        }
        basis.reader().incRef();
        return new RankedReader(basis.reader(), token, basis.expiresAt());
    }
    private synchronized void closeRankBases() throws IOException {
        try { for (var basis : rankBases.values()) basis.reader().decRef(); }
        finally { rankBases.clear(); }
    }

    /** A maintenance sampler reads the current writer; deadline evidence only
     * reads that sampler's published observation. Rollback can replace it. */
    static int mergeThreadCount() {
        var index = mergeIndex.get().get();
        if (index == null) return 0;
        try {
            var writer = index.lucene.getIndexWriter();
            if (writer == null) return 0;
            var scheduler = writer.getConfig().getMergeScheduler();
            return scheduler instanceof ConcurrentMergeScheduler concurrent ? concurrent.mergeThreadCount() : 0;
        } catch (RuntimeException unavailable) { return 0; }
    }

    private SearchDeltaJournal.ReaderLease openReader() throws IOException {
        return openReader(lucene);
    }
    private static SearchDeltaJournal.ReaderLease openReader(TextIndexLucene lucene) throws IOException {
        try (var phase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.READER_OPEN)) {
            return SearchDeltaJournal.committedReader(lucene);
        }
    }
    private DirectoryReader openWriterReader() throws IOException {
        try (var phase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.READER_OPEN)) {
            return DirectoryReader.open(lucene.getIndexWriter());
        }
    }
    /** Every integrity and phrase check uses the request's one committed cut. */
    CommandService.ProbeStatus exactUnitProbe(org.apache.jena.sparql.core.DatasetGraph data, DirectoryReader reader,
                         CommandService.ExactUnitProbe request) throws IOException, ParseException {
        EntityDefinition definition = lucene.getDocDef();
        Node predicate = uri(RV + (CommandPolicy.PRIVATE_SEARCH.equals(request.graph())
            ? "privateSearchBody" : "searchBody"));
        String field = definition.getField(predicate);
        if (field == null || definition.getGraphField() == null || definition.getLangField() == null)
            return CommandService.ProbeStatus.damaged;
        if (!data.contains(uri(request.graph()), uri(request.unit()),
            org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "MatchUnit")))
            return CommandService.ProbeStatus.damaged;
        CommandWork.count("exact_unit_rdf_rows_visited", 1);
        var bodies = data.find(uri(request.graph()), uri(request.unit()), predicate, Node.ANY);
        Node body = null;
        int rows = 0;
        try {
            while (bodies.hasNext() && rows < 2) {
                body = bodies.next().getObject(); rows++;
                CommandWork.count("exact_unit_rdf_rows_visited", 1);
            }
        } finally { org.apache.jena.atlas.iterator.Iter.close(bodies); }
        if (rows != 1 || !body.isLiteral() || !request.body().equals(body.getLiteralLexicalForm())
            || !request.language().equalsIgnoreCase(body.getLiteralLanguage())) return CommandService.ProbeStatus.damaged;
        Node language = exactProbeValue(data, request, uri(RV + "language"));
        if (language == null || !language.isLiteral()
            || !request.language().equalsIgnoreCase(language.getLiteralLexicalForm())) return CommandService.ProbeStatus.damaged;
        Query exact = new BooleanQuery.Builder()
            .add(new TermQuery(new Term(definition.getEntityField(), request.unit())), BooleanClause.Occur.FILTER)
            .add(new TermQuery(new Term(definition.getGraphField(), request.graph())), BooleanClause.Occur.FILTER)
            .add(new org.apache.lucene.search.FieldExistsQuery(field), BooleanClause.Occur.FILTER).build();
        IndexSearcher searcher = new IndexSearcher(reader);
        List<Integer> documents = new ArrayList<>(2);
        try {
            searcher.search(exact, new org.apache.lucene.search.SimpleCollector() {
                private int base;
                @Override protected void doSetNextReader(org.apache.lucene.index.LeafReaderContext context) { base = context.docBase; }
                @Override public org.apache.lucene.search.ScoreMode scoreMode() { return org.apache.lucene.search.ScoreMode.COMPLETE_NO_SCORES; }
                @Override public void collect(int doc) {
                    CommandWork.count("exact_unit_postings_visited", 1);
                    documents.add(base + doc);
                    if (documents.size() == 2) throw new ProbeDamaged();
                }
            });
        } catch (ProbeDamaged duplicate) { return CommandService.ProbeStatus.damaged; }
        if (documents.size() != 1) return CommandService.ProbeStatus.damaged;
        Document stored = searcher.storedFields().document(documents.getFirst());
        String[] values = stored.getValues(field), languages = stored.getValues(definition.getLangField());
        String auxiliary = languages.length == 1 ? languages[0] : "";
        boolean languageMatches = request.language().isEmpty()
            ? auxiliary.equals("^^" + body.getLiteralDatatypeURI()) || auxiliary.isEmpty()
                && org.apache.jena.datatypes.xsd.XSDDatatype.XSDstring.getURI().equals(body.getLiteralDatatypeURI())
            : request.language().equalsIgnoreCase(auxiliary);
        if (values.length != 1 || !request.body().equals(values[0]) || languages.length > 1
            || !languageMatches
            || stored.getValues(definition.getEntityField()).length != 1
            || !request.unit().equals(stored.get(definition.getEntityField()))
            || stored.getValues(definition.getGraphField()).length != 1
            || !request.graph().equals(stored.get(definition.getGraphField()))) return CommandService.ProbeStatus.damaged;
        QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
        Query phrase = parseQuery(parser, "\"" + request.phrase().replace("\\", "\\\\").replace("\"", "\\\"") + "\"");
        Query matched = new BooleanQuery.Builder().add(exact, BooleanClause.Occur.FILTER)
            .add(phrase, BooleanClause.Occur.MUST).build();
        final int[] matches = {0};
        searcher.search(matched, new org.apache.lucene.search.SimpleCollector() {
            @Override public org.apache.lucene.search.ScoreMode scoreMode() { return org.apache.lucene.search.ScoreMode.COMPLETE_NO_SCORES; }
            @Override public void collect(int doc) {
                CommandWork.count("exact_unit_phrase_matches_visited", 1); matches[0]++;
            }
        });
        return matches[0] == 1 ? CommandService.ProbeStatus.present : CommandService.ProbeStatus.absent;
    }
    private static Node exactProbeValue(org.apache.jena.sparql.core.DatasetGraph data,
                                        CommandService.ExactUnitProbe request, Node predicate) {
        var rows = data.find(uri(request.graph()), uri(request.unit()), predicate, Node.ANY);
        Node value = null;
        int count = 0;
        try {
            while (rows.hasNext() && count < 2) {
                value = rows.next().getObject(); count++;
                CommandWork.count("exact_unit_rdf_rows_visited", 1);
            }
        } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
        return count == 1 ? value : null;
    }
    private static final class ProbeDamaged extends RuntimeException {}
    private static Query parseQuery(QueryParser parser, String text) throws ParseException {
        try (var phase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.PARSE)) {
            return parser.parse(text);
        }
    }
    public TextIndexLucene lucene() { return lucene; }

    public record RankHit(String id, float score, String key, Integer document, String unit) {
        public RankHit(String id, float score, String key, Integer document) { this(id, score, key, document, null); }
        public RankHit(String id, float score) { this(id, score, id, null); }
        public RankHit(String id, float score, String key) { this(id, score, key, null); }
    }
    public record RankAfter(String id, float score, long commit, Integer document) {
        public RankAfter(String id, float score, long commit) { this(id, score, commit, null); }
    }
    public record RankPage(List<RankHit> hits, long count, String precision, long commit, boolean more, long expiresAt) {
        public RankPage(List<RankHit> hits, long count, String precision, long commit, boolean more) {
            this(hits, count, precision, commit, more, 0);
        }
    }
    public record RankScope(String realm, String language, String author, boolean catalogue, String names, List<String> resources, String matchMode) {
        public RankScope(String realm, String language, String author, boolean catalogue, String names, List<String> resources) {
            this(realm, language, author, catalogue, names, resources, null);
        }
        public RankScope(String realm, String language, String author, boolean catalogue) { this(realm, language, author, catalogue, null, null, null); }
        public RankScope(String realm, String language, String author) { this(realm, language, author, false, null, null, null); }
    }
    static final class RankRestart extends TextIndexException {
        RankRestart() { super("ranked continuation requires restart"); }
    }

    /** Lucene top-k/searchAfter scores only: no stored fields or RDF in the
     * collector. The stable unit ID resolves the cursor's doc in its pinned
     * retained basis; ties follow its immutable Lucene doc order. Admission
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
        String mode = scope == null || scope.matchMode() == null ? "phrase" : scope.matchMode();
        if (!mode.equals("keywords") && !mode.equals("phrase")) throw new TextIndexException("unsupported match mode");
        if (scope != null && scope.names() != null) {
            if (phrase.codePointCount(0, phrase.length()) > 80 || phrase.chars().anyMatch(c -> c <= 31 || c == 127))
                throw new TextIndexException("name text is out of bounds");
            phrase = java.text.Normalizer.normalize(phrase, java.text.Normalizer.Form.NFC)
                .replaceAll("[\\s\\p{Z}\\uFEFF]+", " ").trim();
            if (phrase.isEmpty() || phrase.codePointCount(0, phrase.length()) > 80)
                throw new TextIndexException("normalized name text is out of bounds");
        }
        if (scope != null && scope.names() == null && rankData.get() == null)
            throw new TextIndexException("ranked scope metadata needs startup qualification or an index rebuild");
        String field = lucene.getDocDef().getField(property);
        if (!"body".equals(field) && !"publicTitle".equals(field))
            throw new TextIndexException("ranked field is not public");
        try (var rankPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RANK);
             var lease = openRankReader(after)) {
            DirectoryReader reader = lease.reader();
            long commit = lease.token();
            if (after != null && (!Float.isFinite(after.score())
                || after.id() != null && after.id().length() > 2048
                || after.id() == null && (after.score() != 0 || after.document() != null)))
                throw new RankRestart();
            QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
            // QueryBuilder analyzes literal text directly: every token must
            // occur in this document, with no Lucene operator interpretation.
            Query body;
            if (mode.equals("keywords")) {
                try (var phase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.PARSE)) {
                    body = new org.apache.lucene.util.QueryBuilder(lucene.getQueryAnalyzer())
                        .createBooleanQuery(field, phrase, BooleanClause.Occur.MUST);
                    if (body == null) body = new org.apache.lucene.search.MatchNoDocsQuery();
                }
            } else body = parseQuery(parser, "\"" + phrase.replace("\\", "\\\\").replace("\"", "\\\"") + "\"");
            boolean names = scope != null && scope.names() != null;
            boolean catalogue = scope != null && scope.catalogue();
            Query text = body;
            Query workNameQuery = null;
            if (catalogue) {
                if (!"body".equals(field)) throw new TextIndexException("catalogue ranking requires the body field");
                QueryParser titles = new QueryParser("publicTitle", lucene.getQueryAnalyzer());
                titles.setDefaultOperator(QueryParser.Operator.AND);
                // Every analyzed word must occur in one authored name. Names
                // and bodies are distinct Jena documents, never concatenated.
                String words = java.util.Arrays.stream(phrase.split("\\s+"))
                    .map(word -> "\"" + word.replace("\\", "\\\\").replace("\"", "\\\"") + "\"")
                    .collect(java.util.stream.Collectors.joining(" "));
                Query title = parseQuery(titles, words);
                workNameQuery = new BooleanQuery.Builder()
                    .add(new org.apache.lucene.search.BoostQuery(new org.apache.lucene.search.ConstantScoreQuery(titleTier(title, "work")), 2_000_000f), BooleanClause.Occur.MUST)
                    .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER).build();
                // Score each matching title once. Complete Work names retain
                // their higher tier over cached body-unit names and BM25.
                text = new org.apache.lucene.search.DisjunctionMaxQuery(List.of(
                    new org.apache.lucene.search.BoostQuery(new org.apache.lucene.search.ConstantScoreQuery(titleTier(title, "work")), 2_000_000f),
                    new org.apache.lucene.search.BoostQuery(new org.apache.lucene.search.ConstantScoreQuery(titleTier(title, "cache")), 1_000_000f),
                    new RankKindQuery(body, lucene.getDocDef().getEntityField(), false)), 0f);
            }
            Query query = new BooleanQuery.Builder()
                .add(text, BooleanClause.Occur.MUST)
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), CommandPolicy.PUBLIC_SEARCH)),
                    BooleanClause.Occur.FILTER).build();
            IndexSearcher searcher = new RankSearcher(reader);
            long deadline = System.nanoTime() + 1_000_000_000L;
            searcher.setTimeout(() -> System.nanoTime() >= deadline);
            String entityField = lucene.getDocDef().getEntityField();
            if (scope != null && scope.realm() != null) {
                // Names retain their document cursor and check the exact
                // owned adoption on <=64 candidates. Body scopes are postings,
                // never an RDF inventory of the Realm population.
                Query realm = new TermQuery(new Term(RANK_CONTEXT, scope.realm()));
                // The scored clause already matches this Work-name title.
                // Its exact tier term is enough here; the page's live witness
                // checks the Realm adoption without scoring the title twice.
                if (catalogue) realm = new BooleanQuery.Builder().add(realm, BooleanClause.Occur.SHOULD)
                    .add(new TermQuery(new Term(TITLE_KIND, "work")), BooleanClause.Occur.SHOULD).build();
                query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST).add(realm, BooleanClause.Occur.FILTER).build();
            }
            if (names) query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField,
                    PublicNameProjection.PREFIX + (scope.names().equals("all") ? "" : scope.names() + ":"))),
                    BooleanClause.Occur.FILTER).build();
            else if (!catalogue) query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                // Public resource names must not consume the Work candidate budget.
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField, PublicNameProjection.PREFIX)),
                    BooleanClause.Occur.MUST_NOT)
                .add(new org.apache.lucene.search.PrefixQuery(new Term(entityField, PublicNameProjection.DIRECTORY)),
                    BooleanClause.Occur.MUST_NOT).build();
            if (names && scope.resources() != null) {
                if (scope.resources().size() > 64) throw new TextIndexException("name candidate bound exceeded");
                List<org.apache.lucene.util.BytesRef> units = new ArrayList<>();
                for (String resource : scope.resources()) {
                    Node owner = uri(resource);
                    if (!PublicNameProjection.productResource(owner)) continue;
                    // Only the maintained name identities can belong to this
                    // resource. Content/other units with rv:resource must not
                    // turn a name restriction into a population walk.
                    for (String kind : PublicNameProjection.NAME_KINDS) {
                        Node unit = PublicNameProjection.nameUnit(owner, kind);
                        if (data.contains(PUBLIC_GRAPH, unit, uri(RV + "resource"), owner))
                            units.add(new org.apache.lucene.util.BytesRef(unit.getURI()));
                    }
                }
                query = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                    .add(new org.apache.lucene.search.TermInSetQuery(entityField, units), BooleanClause.Occur.FILTER).build();
            }
            ScoreDoc cursor = null;
            if (after != null && after.id() != null) {
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
                if (searcher.timedOut()) throw new TextIndexException("ranked query deadline exceeded");
                if (resolved.scoreDocs.length != 1) throw new RankRestart();
                cursor = new ScoreDoc(resolved.scoreDocs[0].doc, after.score());
                }
            }
            // Catalogue counts come from disclosed, grouped pages in Main.
            // Counting 1000 raw hits before pruning lets tied names walk the
            // population even when only one card was requested. Keep the same
            // score/doc ordering and lookahead, with a page-sized threshold.
            // Complete Work names own the highest fixed tier. If that tier
            // fills the page and lookahead, opening cached-title/body scorers
            // cannot affect the result, but does pay population-dependent
            // conjunction work. Fall back to the full ranking only at its tail.
            org.apache.lucene.search.TopDocs top = null;
            if (catalogue && (cursor == null || cursor.score == 2_000_000f)) {
                top = workTitlePage(searcher, reader, workNameQuery, cursor, size + 1, deadline);
                if (top.scoreDocs.length <= size) top = null;
            }
            if (top == null) top = catalogue ? searcher.search(query,
                new org.apache.lucene.search.TopScoreDocCollectorManager(size + 1, cursor, 0))
                : searcher.searchAfter(cursor, query, size + 1);
            boolean more = top.scoreDocs.length > size;
            List<RankHit> ordered = new ArrayList<>();
            var stored = searcher.storedFields();
            var proof = new RankProof();
            try (var witnessPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.WITNESS)) {
                for (int n = 0; n < Math.min(size, top.scoreDocs.length); n++) {
                    if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
                    var hit = top.scoreDocs[n];
                    String id = stored.document(hit.doc, java.util.Set.of(entityField)).get(entityField);
                    if (id == null || !Float.isFinite(hit.score)) throw new TextIndexException("ranked document is incomplete");
                    String witness = catalogue && id.startsWith(PublicNameProjection.PREFIX + "work:")
                        ? nameWitness(data, id, scope, proof) : null;
                    String key = names ? id : scope == null ? id : admittedMain(data, witness == null ? id : witness, scope, proof);
                    if (names) {
                        proof.charge();
                        Query entity = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST)
                            .add(new TermQuery(new Term(entityField, id)), BooleanClause.Occur.FILTER).build();
                        var best = searcher.search(entity, 1);
                        if (best.scoreDocs.length != 1 || best.scoreDocs[0].doc != hit.doc
                            || !PublicNameProjection.visibleUnit(data, id)) key = null;
                    }
                    if (!names && key != null && scope != null && !canonicalGroupHit(data, scope, searcher, query, workNameQuery, key,
                        id, hit.doc, entityField, proof, deadline)) key = null;
                    ordered.add(new RankHit(id, hit.score, key, catalogue || names ? hit.doc : null, witness));
                }
            }
            if (searcher.timedOut()) throw new TextIndexException("ranked query deadline exceeded");
            return new RankPage(List.copyOf(ordered), top.totalHits.value(),
                top.totalHits.relation() == TotalHits.Relation.EQUAL_TO ? "exact" : "lower-bound", commit, more, lease.expiresAt());
        } catch (IOException | ParseException ex) { throw new TextIndexException("ranked query failed", ex); }
    }

    /** This tier has one constant score, so its exact ordering is ascending
     * Lucene document ID. Stop globally at the page witness, before opening
     * later segment iterators. A top-score collector still opens those leaves
     * to establish that their equal scores cannot beat the selected prefix. */
    private static org.apache.lucene.search.TopDocs workTitlePage(IndexSearcher searcher,
            DirectoryReader reader, Query query, ScoreDoc after, int bound, long deadline) throws IOException {
        var weight = searcher.createWeight(searcher.rewrite(query), org.apache.lucene.search.ScoreMode.COMPLETE_NO_SCORES, 1f);
        List<ScoreDoc> hits = new ArrayList<>(bound);
        for (var leaf : reader.leaves()) {
            if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
            int start = after == null ? 0 : Math.max(0, after.doc - leaf.docBase + 1);
            if (start >= leaf.reader().maxDoc()) continue;
            var scorer = weight.scorer(leaf);
            if (scorer == null) continue;
            var phase = scorer.twoPhaseIterator();
            var iterator = phase == null ? scorer.iterator() : org.apache.lucene.search.TwoPhaseIterator.asDocIdSetIterator(phase);
            var live = leaf.reader().getLiveDocs();
            for (int doc = iterator.advance(start); doc != org.apache.lucene.search.DocIdSetIterator.NO_MORE_DOCS; doc = iterator.nextDoc()) {
                if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
                if (live != null && !live.get(doc)) continue;
                hits.add(new ScoreDoc(leaf.docBase + doc, 2_000_000f));
                CommandWork.count("rank_lucene_collection_events", 1);
                if (hits.size() == bound) return new org.apache.lucene.search.TopDocs(new org.apache.lucene.search.TotalHits(
                    hits.size(), org.apache.lucene.search.TotalHits.Relation.GREATER_THAN_OR_EQUAL_TO), hits.toArray(ScoreDoc[]::new));
            }
        }
        return new org.apache.lucene.search.TopDocs(new org.apache.lucene.search.TotalHits(
            hits.size(), org.apache.lucene.search.TotalHits.Relation.EQUAL_TO), hits.toArray(ScoreDoc[]::new));
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
        try (var rankPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RANK);
             var lease = openReader()) {
            DirectoryReader reader = lease.reader();
            String field = lucene.getDocDef().getEntityField(), scope = OccurrenceLabelIndex.scope(generation, revision, parent);
            String lower = scope + after.replace('\u0001', '!').replace("https://rezics.com/id/", "");
            Query scopeQuery = new BooleanQuery.Builder()
                .add(new TermQuery(new Term(lucene.getDocDef().getGraphField(), OccurrenceLabelIndex.TEXT.getURI())), BooleanClause.Occur.FILTER)
                .add(new TermQuery(new Term("occurrenceScope", scope)), BooleanClause.Occur.FILTER).build();
            QueryParser parser = new QueryParser("occurrenceLabel", lucene.getQueryAnalyzer());
            Query text = parseQuery(parser, "\"" + phrase.replace("\\", "\\\\").replace("\"", "\\\"") + "\"");
            IndexSearcher searcher = new IndexSearcher(reader);
            long deadline = System.nanoTime() + 1_000_000_000L;
            searcher.setTimeout(() -> System.nanoTime() >= deadline);
            List<OccurrenceToken> analyzed = occurrencePhrase(lucene.getQueryAnalyzer(), phrase);
            if (analyzed.size() > 1 && analyzed.getLast().term().matches("[0-9]+")) {
                // An unfinished chapter number is a prefix inside its label,
                // while a bare number retains the exact numbered-tree seek.
                // Prefix postings + sorted doc values retain <=101 candidates;
                // no expansion/list of all matching number terms is retained.
                return occurrenceNumberPrefix(reader, searcher, scopeQuery, scope, lower, after, analyzed, size, deadline);
            }
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

    private record OccurrenceToken(String term, int position) {}
    private static List<OccurrenceToken> occurrencePhrase(org.apache.lucene.analysis.Analyzer analyzer, String value) throws IOException {
        List<OccurrenceToken> tokens = new ArrayList<>();
        try (var stream = analyzer.tokenStream(OccurrenceTextSchema.FIELD, value)) {
            var term = stream.addAttribute(org.apache.lucene.analysis.tokenattributes.CharTermAttribute.class);
            var increment = stream.addAttribute(org.apache.lucene.analysis.tokenattributes.PositionIncrementAttribute.class);
            int position = -1;
            stream.reset();
            while (stream.incrementToken()) { position += increment.getPositionIncrement(); tokens.add(new OccurrenceToken(term.toString(), position)); }
            stream.end();
        }
        return tokens;
    }
    /** Lucene 10.3.1's constant-score PrefixQuery avoids Boolean term expansion.
     * One sorted top-k page retains <=101 docs and hydrates <=18*500 label chars
     * per doc. Matching postings/sort work shares the existing one-second native
     * deadline; this bound is on candidates, not the total matching population.
     * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/PrefixQuery.html
     * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/IndexSearcher.html
     */
    private JsonObject occurrenceNumberPrefix(DirectoryReader reader, IndexSearcher searcher, Query scopeQuery,
        String scope, String lower, String after, List<OccurrenceToken> tokens, int size, long deadline) throws IOException {
        if (tokens.size() + size > OCCURRENCE_VISITS) throw new TextIndexException("occurrence prefix budget exceeded");
        var words = new BooleanQuery.Builder();
        for (var token : tokens.subList(0, tokens.size() - 1))
            words.add(new TermQuery(new Term(OccurrenceTextSchema.FIELD, token.term())), BooleanClause.Occur.FILTER);
        words.add(new org.apache.lucene.search.PrefixQuery(new Term(OccurrenceTextSchema.FIELD, tokens.getLast().term())),
            BooleanClause.Occur.FILTER);
        var candidates = new BooleanQuery.Builder().add(words.build(), BooleanClause.Occur.SHOULD)
            .add(new TermQuery(new Term("occurrenceNavigation", "true")), BooleanClause.Occur.SHOULD)
            .setMinimumNumberShouldMatch(1).build();
        var query = new BooleanQuery.Builder().add(scopeQuery, BooleanClause.Occur.FILTER)
            .add(candidates, BooleanClause.Occur.FILTER)
            .add(org.apache.lucene.search.TermRangeQuery.newStringRange(lucene.getDocDef().getEntityField(),
                after.isEmpty() ? scope : lower + ":~", null, true, false), BooleanClause.Occur.FILTER).build();
        var page = searcher.search(query, size, new org.apache.lucene.search.Sort(
            new org.apache.lucene.search.SortField(OccurrenceTextSchema.ORDER, org.apache.lucene.search.SortField.Type.STRING)));
        JsonArray items = new JsonArray();
        for (var hit : page.scoreDocs) {
            if (System.nanoTime() >= deadline || searcher.timedOut())
                throw new TextIndexException("occurrence prefix search deadline exceeded");
            var stored = searcher.storedFields().document(hit.doc,
                java.util.Set.of(lucene.getDocDef().getEntityField(), OccurrenceTextSchema.PAYLOAD));
            String id = stored.get(lucene.getDocDef().getEntityField()), payload = stored.get(OccurrenceTextSchema.PAYLOAD);
            if (id == null || payload == null || !id.startsWith(scope))
                throw new TextIndexException("occurrence prefix document is incomplete");
            boolean matches = false;
            // Postings narrow the page; verify adjacency and positions within
            // each carried label, never across different labels or languages.
            for (var label : org.apache.jena.atlas.json.JSON.parse(payload).get("labels").getAsArray()) {
                if (System.nanoTime() >= deadline) throw new TextIndexException("occurrence prefix search deadline exceeded");
                var terms = occurrencePhrase(lucene.getQueryAnalyzer(), label.getAsObject().get("value").getAsString().value());
                for (int at = 0; at + tokens.size() <= terms.size() && !matches; at++) {
                    boolean same = true;
                    for (int n = 0; n < tokens.size(); n++) {
                        var actual = terms.get(at + n); var wanted = tokens.get(n);
                        if (actual.position() - terms.get(at).position() != wanted.position() - tokens.getFirst().position()
                            || !(n == tokens.size() - 1 ? actual.term().startsWith(wanted.term()) : actual.term().equals(wanted.term()))) {
                            same = false; break;
                        }
                    }
                    matches = same;
                }
            }
            String encoded = id.substring(scope.length());
            String[] key = encoded.substring(0, encoded.lastIndexOf(':')).split("!", -1);
            if (key.length != 3) throw new TextIndexException("occurrence text identity is invalid");
            JsonObject item = new JsonObject(); item.put("segmentKey", key[0]); item.put("orderKey", key[1]);
            item.put("occurrence", "https://rezics.com/id/" + key[2]); item.put("matches", matches); items.add(item);
        }
        if (System.nanoTime() >= deadline || searcher.timedOut()) throw new TextIndexException("occurrence prefix search deadline exceeded");
        JsonObject result = new JsonObject(); result.put("items", items); result.put("reads", tokens.size() + page.scoreDocs.length);
        result.put("commit", Long.toString(reader.getIndexCommit().getGeneration())); return result;
    }

    private static final String RV = "https://rezics.com/vocab/";
    /** A sorted, maintained projection in the existing entity term dictionary.
     * Retains <=64 terms. Deleted terms advance with a null key, so even merge
     * lag has a declared candidate bound and an advancing continuation.
     * TermsEnum orders UTF-8 keys and seekCeil finds the next key:
     * https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/index/TermsEnum.html */
    RankPage directory(String kind, String order, int size, RankAfter after,
                       org.apache.jena.sparql.core.DatasetGraph data) {
        if (size < 1 || size > 64 || !PublicNameProjection.nameKind(kind)
            || !java.util.Set.of("identity", "newest", "updated").contains(order))
            throw new TextIndexException("directory query is not admitted");
        boolean identity = order.equals("identity");
        String prefix = identity ? PublicNameProjection.PREFIX + kind + ":"
            : PublicNameProjection.DIRECTORY + kind + ":" + order + ":";
        try (var rankPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RANK);
             var lease = openReader()) {
            DirectoryReader reader = lease.reader();
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
            try (var witnessPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.WITNESS)) {
                while (term != null && term.utf8ToString().startsWith(prefix) && hits.size() < size) {
                    String id = term.utf8ToString();
                    var members = data.find(PUBLIC_GRAPH, uri(id), uri(RV + (identity ? "resource" : "nameDirectoryResource")), Node.ANY);
                    Node resource = null;
                    try { if (members.hasNext()) resource = members.next().getObject(); }
                    finally { org.apache.jena.atlas.iterator.Iter.close(members); }
                    hits.add(new RankHit(id, 0f, resource != null && resource.isURI() && PublicNameProjection.visible(data, resource) ? resource.getURI() : null));
                    term = iterator.next();
                }
            }
            boolean more = term != null && term.utf8ToString().startsWith(prefix);
            return new RankPage(List.copyOf(hits), hits.size(), more ? "lower-bound" : "exact", commit, more);
        } catch (IOException ex) { throw new TextIndexException("directory query failed", ex); }
    }
    /** One ordered PREFIX dictionary page, including dead entries. Qualification
     * only touches the page's exact maintained membership; a lookahead term
     * determines continuation without opening another candidate or witness. */
    JsonObject prefixWalk(String prefix, String language, int size, String cursor,
                          org.apache.jena.sparql.core.DatasetGraph data) {
        long deadline = System.nanoTime() + 1_500_000_000L;
        if (prefix == null) throw new IllegalArgumentException("prefix walk query is not admitted");
        prefix = PublicNameProjection.normalizedPrefixText(prefix);
        if (language != null) language = language.toLowerCase(java.util.Locale.ROOT);
        if (size < 1 || size > 10 || prefix.isEmpty() || prefix.length() > PublicNameProjection.PREFIX_TEXT_LIMIT
            || language != null && language.length() > 100)
            throw new IllegalArgumentException("prefix walk query is not admitted");
        String scope = PublicNameProjection.prefixScope(prefix, language);
        PrefixAfter after = cursor == null ? null : prefixAfter(cursor, prefix, language);
        try (var rankPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RANK);
             var lease = openReader()) {
            DirectoryReader reader = lease.reader();
            prefixDeadline(deadline);
            String generation = Long.toString(reader.getIndexCommit().getGeneration());
            if (after != null && !after.generation().equals(generation)) throw new RankRestart();
            JsonArray entries = new JsonArray();
            int rejected = 0;
            boolean more = false;
            String last = null;
            var terms = org.apache.lucene.index.MultiTerms.getTerms(reader, lucene.getDocDef().getEntityField());
            if (terms != null) {
                var iterator = terms.iterator();
                String start = after == null ? scope : scope + after.key();
                CommandWork.count("typeahead_prefix_seek_calls", 1);
                if (iterator.seekCeil(new org.apache.lucene.util.BytesRef(start)) != org.apache.lucene.index.TermsEnum.SeekStatus.END) {
                    var term = iterator.term();
                    if (after != null && term.utf8ToString().equals(start)) {
                        CommandWork.count("typeahead_prefix_next_calls", 1); term = iterator.next();
                    }
                    try (var witnessPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.WITNESS)) {
                        while (term != null && term.utf8ToString().startsWith(scope) && entries.size() < size) {
                            prefixDeadline(deadline);
                            String id = term.utf8ToString(), key = id.substring(scope.length());
                            if (!prefixKey(key)) throw new TextIndexException("prefix directory identity is invalid");
                            CommandWork.count("typeahead_prefix_entries_visited", 1);
                            String main = prefixResource(key.substring(1, 33));
                            String unit = prefixResource(key.substring(33));
                            String field = key.charAt(0) == '0' ? "title" : "credit";
                            boolean invalid = !PublicNameProjection.prefixEntryValid(data, id, main, unit, field);
                            prefixDeadline(deadline);
                            JsonObject entry = new JsonObject();
                            entry.put("key", key); entry.put("mainVersion", main); entry.put("matchUnit", unit);
                            entry.put("matchedField", field); entry.put("rejected", invalid);
                            entries.add(entry); if (invalid) rejected++;
                            last = key;
                            CommandWork.count("typeahead_prefix_next_calls", 1);
                            term = iterator.next();
                        }
                    }
                    more = term != null && term.utf8ToString().startsWith(scope);
                }
            }
            JsonObject result = new JsonObject();
            result.put("entries", entries); result.put("generation", generation);
            result.put("examined", entries.size()); result.put("rejected", rejected); result.put("more", more);
            if (more) result.put("cursor", prefixCursor(prefix, language, generation, last));
            else result.put("cursor", org.apache.jena.atlas.json.JsonNull.instance);
            prefixDeadline(deadline);
            return result;
        } catch (IOException error) { throw new TextIndexException("prefix directory query failed", error); }
    }
    private static void prefixDeadline(long deadline) {
        if (Thread.currentThread().isInterrupted() || System.nanoTime() >= deadline)
            throw new TextIndexException("prefix walk deadline exceeded");
    }
    private record PrefixAfter(String generation, String key) {}
    private static boolean prefixKey(String key) { return key != null && key.matches("[01][0-9a-f]{64}"); }
    private static String prefixResource(String key) {
        return "https://rezics.com/id/" + key.substring(0, 8) + "-" + key.substring(8, 12) + "-"
            + key.substring(12, 16) + "-" + key.substring(16, 20) + "-" + key.substring(20);
    }
    private static String prefixCursor(String prefix, String language, String generation, String key) {
        JsonObject state = new JsonObject(); state.put("version", 1); state.put("prefix", prefix);
        if (language == null) state.put("language", org.apache.jena.atlas.json.JsonNull.instance);
        else state.put("language", language);
        state.put("generation", generation); state.put("after", key);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
            org.apache.jena.atlas.json.JSON.toStringFlat(state).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    private static PrefixAfter prefixAfter(String cursor, String prefix, String language) {
        try {
            if (cursor.length() > 2_048 || !cursor.matches("[A-Za-z0-9_-]+")) throw new IllegalArgumentException();
            byte[] bytes = java.util.Base64.getUrlDecoder().decode(cursor);
            if (!java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(cursor)) throw new IllegalArgumentException();
            JsonObject state = org.apache.jena.atlas.json.JSON.parse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
            var version = state.get("version");
            var statePrefix = state.get("prefix");
            var stateLanguage = state.get("language");
            var generation = state.get("generation");
            var after = state.get("after");
            if (version == null || !version.isNumber() || !version.getAsNumber().value().toString().equals("1")
                || statePrefix == null || !statePrefix.isString() || !statePrefix.getAsString().value().equals(prefix)
                || stateLanguage == null || (language == null ? !stateLanguage.isNull()
                    : !stateLanguage.isString() || !stateLanguage.getAsString().value().equals(language))
                || generation == null || !generation.isString() || !generation.getAsString().value().matches("0|[1-9][0-9]{0,63}")
                || after == null || !after.isString() || !prefixKey(after.getAsString().value())) throw new IllegalArgumentException();
            return new PrefixAfter(generation.getAsString().value(), after.getAsString().value());
        } catch (RuntimeException malformed) { throw new IllegalArgumentException("prefix continuation is not admitted", malformed); }
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

    /** Check kinds only on text candidates. An entity PrefixQuery rewrites over
     * every Work name in the segment, even for a one-hit phrase. Stored entity
     * identities already exist in Jena's documents; no new index schema or
     * population bitset is needed. This wrapper preserves the inner score and
     * approximation, including phrase two-phase matching and seek restrictions. */
    private static final class RankKindQuery extends Query {
        private final Query candidates;
        private final String entityField;
        private final boolean workNamesOnly;
        RankKindQuery(Query candidates, String entityField, boolean workNamesOnly) {
            this.candidates = candidates; this.entityField = entityField;
            this.workNamesOnly = workNamesOnly;
        }
        private boolean admitted(Document doc) {
            String id = doc.get(entityField);
            if (id == null) return false;
            return id.startsWith(PublicNameProjection.PREFIX + "work:")
                || !workNamesOnly && !id.startsWith(PublicNameProjection.PREFIX)
                    && !id.startsWith(PublicNameProjection.DIRECTORY);
        }
        @Override public Query rewrite(IndexSearcher searcher) throws IOException {
            Query rewritten = candidates.rewrite(searcher);
            return rewritten == candidates ? this : new RankKindQuery(rewritten, entityField, workNamesOnly);
        }
        @Override public void visit(org.apache.lucene.search.QueryVisitor visitor) {
            candidates.visit(visitor.getSubVisitor(BooleanClause.Occur.MUST, this));
        }
        @Override public String toString(String field) {
            return "rankKind(" + (workNamesOnly ? "work" : "catalogue") + "," + candidates.toString(field) + ")";
        }
        @Override public boolean equals(Object other) {
            return sameClassAs(other) && candidates.equals(((RankKindQuery) other).candidates)
                && entityField.equals(((RankKindQuery) other).entityField)
                && workNamesOnly == ((RankKindQuery) other).workNamesOnly;
        }
        @Override public int hashCode() { return java.util.Objects.hash(classHash(), candidates, entityField, workNamesOnly); }
        @Override public org.apache.lucene.search.Weight createWeight(IndexSearcher searcher,
                org.apache.lucene.search.ScoreMode mode, float boost) throws IOException {
            return new org.apache.lucene.search.FilterWeight(this, searcher.createWeight(candidates, mode, boost)) {
                // Query caching must not turn this candidate check into a
                // whole-segment materialization.
                @Override public boolean isCacheable(org.apache.lucene.index.LeafReaderContext context) { return false; }
                @Override public org.apache.lucene.search.Explanation explain(org.apache.lucene.index.LeafReaderContext context, int doc) throws IOException {
                    var identity = context.reader().storedFields().document(doc, java.util.Set.of(entityField));
                    if (!admitted(identity)) return org.apache.lucene.search.Explanation.noMatch("excluded catalogue kind");
                    return in.explain(context, doc);
                }
                @Override public org.apache.lucene.search.Matches matches(org.apache.lucene.index.LeafReaderContext context, int doc) throws IOException {
                    return admitted(context.reader().storedFields().document(doc, java.util.Set.of(entityField))) ? in.matches(context, doc) : null;
                }
                @Override public org.apache.lucene.search.ScorerSupplier scorerSupplier(org.apache.lucene.index.LeafReaderContext context) throws IOException {
                    var supplier = in.scorerSupplier(context);
                    // Non-scoring term suppliers can defer their absent-term
                    // lookup until cost(). Do not build empty iterators for
                    // every unrelated segment of the catalogue.
                    if (supplier == null || supplier.cost() == 0) return null;
                    var stored = context.reader().storedFields();
                    return new org.apache.lucene.search.ScorerSupplier() {
                        @Override public long cost() { return supplier.cost(); }
                        @Override public void setTopLevelScoringClause() throws IOException { supplier.setTopLevelScoringClause(); }
                        @Override public org.apache.lucene.search.Scorer get(long cost) throws IOException {
                            var scorer = supplier.get(cost);
                            var innerPhase = scorer.twoPhaseIterator();
                            var phase = new org.apache.lucene.search.TwoPhaseIterator(innerPhase == null ? scorer.iterator() : innerPhase.approximation()) {
                                @Override public boolean matches() throws IOException {
                                    if (innerPhase != null && !innerPhase.matches()) return false;
                                    var document = stored.document(approximation().docID(), java.util.Set.of(entityField));
                                    return admitted(document);
                                }
                                @Override public float matchCost() { return 100f + (innerPhase == null ? 0 : innerPhase.matchCost()); }
                            };
                            return new org.apache.lucene.search.Scorer() {
                                @Override public int docID() { return scorer.docID(); }
                                @Override public float score() throws IOException { return scorer.score(); }
                                @Override public org.apache.lucene.search.DocIdSetIterator iterator() { return org.apache.lucene.search.TwoPhaseIterator.asDocIdSetIterator(phase); }
                                @Override public org.apache.lucene.search.TwoPhaseIterator twoPhaseIterator() { return phase; }
                                @Override public int advanceShallow(int target) throws IOException { return scorer.advanceShallow(target); }
                                @Override public float getMaxScore(int upTo) throws IOException { return scorer.getMaxScore(upTo); }
                                @Override public void setMinCompetitiveScore(float score) throws IOException { scorer.setMinCompetitiveScore(score); }
                                @Override public float smoothingScore(int doc) throws IOException { return scorer.smoothingScore(doc); }
                            };
                        }
                    };
                }
            };
        }
    }

    /** Observed Lucene operations, separate from returned TopDocs and RDF
     * witnesses. Nested weights may count the same document at multiple layers;
     * these counters do not claim all physical postings, cache work or I/O. */
    private static final class RankSearcher extends IndexSearcher {
        RankSearcher(org.apache.lucene.index.IndexReader reader) { super(reader); }
        @Override public org.apache.lucene.search.Weight createWeight(Query query, org.apache.lucene.search.ScoreMode mode, float boost) throws IOException {
            return new org.apache.lucene.search.FilterWeight(super.createWeight(query, mode, boost)) {
                @Override public org.apache.lucene.search.ScorerSupplier scorerSupplier(org.apache.lucene.index.LeafReaderContext context) throws IOException {
                    var supplier = in.scorerSupplier(context);
                    if (supplier == null) return null;
                    return new org.apache.lucene.search.ScorerSupplier() {
                        @Override public long cost() { return supplier.cost(); }
                        @Override public void setTopLevelScoringClause() throws IOException { supplier.setTopLevelScoringClause(); }
                        @Override public org.apache.lucene.search.Scorer get(long cost) throws IOException { return observedScorer(supplier.get(cost)); }
                        @Override public org.apache.lucene.search.BulkScorer bulkScorer() throws IOException {
                            var bulk = supplier.bulkScorer(); if (bulk == null) return null;
                            return new org.apache.lucene.search.BulkScorer() {
                                @Override public long cost() { return bulk.cost(); }
                                @Override public int score(org.apache.lucene.search.LeafCollector collector, org.apache.lucene.util.Bits accept, int min, int max) throws IOException {
                                    return bulk.score(new org.apache.lucene.search.LeafCollector() {
                                        @Override public void setScorer(org.apache.lucene.search.Scorable scorer) throws IOException {
                                            collector.setScorer(new org.apache.lucene.search.FilterScorable(scorer) {
                                                @Override public float score() throws IOException { CommandWork.count("rank_lucene_score_calls", 1); return in.score(); }
                                                @Override public float smoothingScore(int doc) throws IOException { return in.smoothingScore(doc); }
                                                @Override public void setMinCompetitiveScore(float score) throws IOException { in.setMinCompetitiveScore(score); }
                                            });
                                        }
                                        @Override public void collect(int doc) throws IOException { CommandWork.count("rank_lucene_collection_events", 1); collector.collect(doc); }
                                        @Override public void collectRange(int min, int max) throws IOException { CommandWork.count("rank_lucene_collection_events", max - min); collector.collectRange(min, max); }
                                        @Override public void collect(org.apache.lucene.search.DocIdStream stream) throws IOException {
                                            collector.collect(new org.apache.lucene.search.DocIdStream() {
                                                @Override public void forEach(int max, org.apache.lucene.search.CheckedIntConsumer<IOException> consumer) throws IOException {
                                                    stream.forEach(max, doc -> { CommandWork.count("rank_lucene_collection_events", 1); consumer.accept(doc); });
                                                }
                                                @Override public int count(int max) throws IOException { int count = stream.count(max); CommandWork.count("rank_lucene_collection_events", count); return count; }
                                                @Override public boolean mayHaveRemaining() { return stream.mayHaveRemaining(); }
                                            });
                                        }
                                        @Override public org.apache.lucene.search.DocIdSetIterator competitiveIterator() throws IOException { return collector.competitiveIterator(); }
                                        @Override public void finish() throws IOException { collector.finish(); }
                                    }, accept, min, max);
                                }
                            };
                        }
                    };
                }
            };
        }
    }
    private static org.apache.lucene.search.DocIdSetIterator observedIterator(org.apache.lucene.search.DocIdSetIterator iterator) {
        return new org.apache.lucene.search.DocIdSetIterator() {
            @Override public int docID() { return iterator.docID(); }
            @Override public long cost() { return iterator.cost(); }
            @Override public int nextDoc() throws IOException { CommandWork.count("rank_lucene_iterator_next_calls", 1); return iterator.nextDoc(); }
            @Override public int advance(int target) throws IOException { CommandWork.count("rank_lucene_iterator_advance_calls", 1); return iterator.advance(target); }
            @Override public int docIDRunEnd() throws IOException { return iterator.docIDRunEnd(); }
            @Override public void intoBitSet(int upTo, org.apache.lucene.util.FixedBitSet bits, int offset) throws IOException {
                CommandWork.count("rank_lucene_iterator_bitset_calls", 1); iterator.intoBitSet(upTo, bits, offset);
            }
        };
    }
    private static org.apache.lucene.search.Scorer observedScorer(org.apache.lucene.search.Scorer scorer) {
        var phase = scorer.twoPhaseIterator();
        var iterator = observedIterator(phase == null ? scorer.iterator() : phase.approximation());
        var observedPhase = phase == null ? null : new org.apache.lucene.search.TwoPhaseIterator(iterator) {
            @Override public boolean matches() throws IOException { CommandWork.count("rank_lucene_two_phase_matches", 1); return phase.matches(); }
            @Override public float matchCost() { return phase.matchCost(); }
            @Override public int docIDRunEnd() throws IOException { return phase.docIDRunEnd(); }
        };
        return new org.apache.lucene.search.Scorer() {
            @Override public int docID() { return scorer.docID(); }
            @Override public float score() throws IOException { CommandWork.count("rank_lucene_score_calls", 1); return scorer.score(); }
            @Override public org.apache.lucene.search.DocIdSetIterator iterator() { return observedPhase == null ? iterator : org.apache.lucene.search.TwoPhaseIterator.asDocIdSetIterator(observedPhase); }
            @Override public org.apache.lucene.search.TwoPhaseIterator twoPhaseIterator() { return observedPhase; }
            @Override public int advanceShallow(int target) throws IOException { return scorer.advanceShallow(target); }
            @Override public float getMaxScore(int upTo) throws IOException { return scorer.getMaxScore(upTo); }
            @Override public void setMinCompetitiveScore(float score) throws IOException { scorer.setMinCompetitiveScore(score); }
            @Override public float smoothingScore(int doc) throws IOException { return scorer.smoothingScore(doc); }
            @Override public java.util.Collection<org.apache.lucene.search.Scorable.ChildScorable> getChildren() throws IOException { return scorer.getChildren(); }
            @Override public void nextDocsAndScores(int upTo, org.apache.lucene.util.Bits accept, org.apache.lucene.search.DocAndFloatFeatureBuffer buffer) throws IOException {
                scorer.nextDocsAndScores(upTo, accept, buffer); CommandWork.count("rank_lucene_batch_docs", buffer.size);
            }
        };
    }
    static final int RANK_WITNESS_LIMIT = 128;
    /** One snapshot-local budget, shared by returned candidates and all name/
     * group proofs. Cached answers cannot change inside this RDF/Lucene basis. */
    private static final class RankProof {
        int witnesses;
        final Map<String,String> admissions = new java.util.HashMap<>(), names = new java.util.HashMap<>();
        final Map<String,Integer> groups = new java.util.HashMap<>();
        final Map<Node,Node> selections = new java.util.HashMap<>();
        final java.util.Set<Node> owners = new java.util.HashSet<>();
        void charge() {
            if (witnesses == RANK_WITNESS_LIMIT) throw new TextIndexException("ranked live-witness budget exceeded");
            witnesses++; CommandWork.count("rank_live_witnesses_visited", 1);
        }
        Node selectedUnit(org.apache.jena.sparql.core.DatasetGraph data, Node selection) {
            if (selections.containsKey(selection)) return selections.get(selection);
            // Exact owner index, outside phrase, score, author or language
            // filters. A nonmatching second public copy is still ambiguity.
            var rows = data.find(PUBLIC_GRAPH, Node.ANY, property("selection"), selection);
            Node unit = null;
            try {
                if (rows.hasNext()) { unit = rows.next().getSubject(); CommandWork.count("rank_selection_units_visited", 1); }
                if (rows.hasNext()) {
                    rows.next(); CommandWork.count("rank_selection_units_visited", 1);
                    throw new TextIndexException("ranked current selection has ambiguous public unit identities");
                }
            } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
            selections.put(selection, unit); return unit;
        }
        void mainLanguages(org.apache.jena.sparql.core.DatasetGraph data, Node main) {
            if (owners.contains(main)) return;
            var heads = data.find(CURRENT_GRAPH, main, property("selectionHead"), Node.ANY);
            java.util.Set<String> languages = new java.util.HashSet<>();
            try { for (int count = 0; heads.hasNext(); count++) {
                if (count == 64) throw new TextIndexException("ranked Main language owner exceeds its admitted bound");
                Node selection = heads.next().getObject();
                Node language = namedValue(data, uri(CommandPolicy.REVISIONS), selection, "language");
                if (language == null) {
                    Node unit = selectedUnit(data, selection);
                    if (unit != null) language = namedValue(data, PUBLIC_GRAPH, unit, "language");
                }
                if (language != null && language.isLiteral()
                    && !languages.add(language.getLiteralLexicalForm().toLowerCase(java.util.Locale.ROOT)))
                    throw new TextIndexException("ranked current Main language selection is ambiguous");
            } } finally { org.apache.jena.atlas.iterator.Iter.close(heads); }
            owners.add(main);
        }
    }
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
    private static String admittedMain(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope, RankProof proof) {
        if (proof.admissions.containsKey(id)) return proof.admissions.get(id);
        proof.charge();
        String result = admittedMainUncached(data, id, scope, proof);
        proof.admissions.put(id, result); return result;
    }
    private static String admittedMainUncached(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope, RankProof proof) {
        RankUnit facts = describeUnit(data, id);
        if (facts == null) return null;
        Node main = facts.main(), selection = facts.selection(), context = facts.context(), language = facts.language();
        Node current = CURRENT_GRAPH;
        Node work = namedValue(data, PUBLIC_GRAPH, uri(id), "work");
        Node revision = namedValue(data, PUBLIC_GRAPH, uri(id), "revision");
        if (work != null && PublicNameProjection.withdrawn(data, work) || PublicNameProjection.withdrawn(data, main)
            || facts.contribution() != null && PublicNameProjection.withdrawn(data, facts.contribution())
            || revision != null && data.contains(uri(CommandPolicy.REVISIONS), revision, org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "ErasedRevision"))) return null;
        if (data.contains(uri(CommandPolicy.REVISIONS), selection, org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "PublicationSelection"))
            && (work == null || !PublicNameProjection.publishedSelection(data, work, main, selection, context))) return null;
        if (data.contains(uri(CommandPolicy.REVISIONS), selection, org.apache.jena.vocabulary.RDF.type.asNode(), uri(RV + "PublicationSelection"))) {
            if (!java.util.Objects.equals(facts.contribution(), namedValue(data, uri(CommandPolicy.REVISIONS), selection, "contribution"))
                || !java.util.Objects.equals(revision, namedValue(data, uri(CommandPolicy.REVISIONS), selection, "selectedDraft"))) return null;
            Node selectedLanguage = namedValue(data, uri(CommandPolicy.REVISIONS), selection, "language");
            if (selectedLanguage != null && (!selectedLanguage.isLiteral()
                || !selectedLanguage.getLiteralLexicalForm().equalsIgnoreCase(language.getLiteralLexicalForm()))) return null;
        }
        if (scope.language() != null && !scope.language().equalsIgnoreCase(language.getLiteralLexicalForm())) return null;
        if (scope.author() != null) {
            Node contribution = facts.contribution();
            if (contribution == null || !data.contains(current, contribution, property("author"), uri(scope.author()))) return null;
        }
        if (scope.realm() == null) {
            if (!context.equals(main) || !data.contains(current, main, property("selectionHead"), selection)) return null;
            proof.mainLanguages(data, main);
        } else {
            // A Zone population contains actual adoptions, not Realm fallbacks.
            if (!context.equals(uri(scope.realm()))) return null;
            // Bodies and names use one canonical Realm/Main owner. An
            // immutable alternate slot must never create a second adoption.
            Node slot = CanonicalPolicy.realmOwner(uri(scope.realm()), main);
            if (CanonicalPolicy.realmSelectionOwnerFailure(data, selection) != null
                || !slot.equals(namedValue(data, uri(CommandPolicy.REVISIONS), selection, "slot")))
                throw new TextIndexException("ranked Realm selection has a noncanonical owner");
            if (!PublicNameProjection.publicRealm(data, uri(scope.realm()))
                || slot == null || !slot.isURI()
                || !data.contains(current, slot, org.apache.jena.vocabulary.RDF.type.asNode(), property("RealmPublicationSlot"))
                || !data.contains(current, slot, property("realm"), uri(scope.realm()))
                || !data.contains(current, slot, property("mainVersion"), main)
                || !java.util.Objects.equals(namedValue(data, current, slot, "work"), namedValue(data, PUBLIC_GRAPH, uri(id), "work"))
                || !data.contains(current, slot, property("selectionHead"), selection)) return null;
            if (CanonicalPolicy.realmSlotOwnerFailure(data, slot) != null)
                throw new TextIndexException("ranked Realm selection owner is invalid");
            Node head = namedValue(data, current, slot, "selectionHead");
            if (head == null) throw new TextIndexException("ranked current Realm selection owner is ambiguous");
        }
        Node unit = proof.selectedUnit(data, selection);
        if (unit == null || !unit.isURI() || !unit.getURI().equals(id)) return null;
        return facts.key();
    }
    private static Node namedValue(org.apache.jena.sparql.core.DatasetGraph data, Node graph, Node subject, String predicate) {
        var rows = data.find(graph, subject, uri(RV + predicate), Node.ANY);
        try {
            if (!rows.hasNext()) return null;
            Node value = rows.next().getObject();
            return rows.hasNext() ? null : value;
        }
        finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
    }
    /** A complete Work-name document retains its cursor identity, while an
     * exact selected body unit supplies the existing public result envelope. */
    private static String nameWitness(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope, RankProof proof) {
        if (proof.names.containsKey(id)) return proof.names.get(id);
        proof.charge();
        String result = nameWitnessUncached(data, id, scope, proof);
        proof.names.put(id, result); return result;
    }
    private static String nameWitnessUncached(org.apache.jena.sparql.core.DatasetGraph data, String id, RankScope scope, RankProof proof) {
        if (!PublicNameProjection.visibleUnit(data, id)) return null;
        Node work = namedValue(data, PUBLIC_GRAPH, uri(id), "resource");
        Node main = work == null ? null : namedValue(data, CURRENT_GRAPH, work, "mainVersion");
        if (!PublicNameProjection.productResource(main)) return null;
        Node context = scope.realm() == null ? main : uri(scope.realm());
        if (scope.realm() != null && !PublicNameProjection.publicRealm(data, context)) return null;
        Node owner = scope.realm() == null ? main : CanonicalPolicy.realmOwner(uri(scope.realm()), main);
        if (scope.realm() != null && !work.equals(namedValue(data, CURRENT_GRAPH, owner, "work"))) return null;
        // HeadCasPolicy admits <=64 distinct Main languages, and a Realm slot
        // has one head. Read that entire owner neighbourhood, checking overflow
        // rather than silently treating an output limit as a language limit.
        int bound = scope.realm() == null ? 64 : 1;
        List<Node> selections = new ArrayList<>();
        var heads = data.find(CURRENT_GRAPH, owner, uri(RV + "selectionHead"), Node.ANY);
        try {
            while (selections.size() < bound && heads.hasNext()) {
                selections.add(heads.next().getObject());
                CommandWork.count("catalogue_name_witness_heads_visited", 1);
            }
            if (heads.hasNext()) throw new TextIndexException("catalogue name selection owner exceeds its admitted bound");
        } finally { org.apache.jena.atlas.iterator.Iter.close(heads); }
        for (Node selection : selections) {
            Node language = namedValue(data, uri(CommandPolicy.REVISIONS), selection, "language");
            // Legacy admitted selections may omit this optional revision copy;
            // their unique selected public body still carries the language.
            if (language != null && (!language.isLiteral() || scope.language() != null
                && !scope.language().equalsIgnoreCase(language.getLiteralLexicalForm()))) continue;
            if (!PublicNameProjection.publishedSelection(data, work, main, selection, context)) continue;
            Node unit = proof.selectedUnit(data, selection);
            Node unitLanguage = unit == null ? null : namedValue(data, PUBLIC_GRAPH, unit, "language");
            if (unit != null && unit.isURI() && work.equals(namedValue(data, PUBLIC_GRAPH, unit, "work"))
                && main.equals(namedValue(data, PUBLIC_GRAPH, unit, "mainVersion"))
                && unitLanguage != null && unitLanguage.isLiteral() && (language == null
                    || language.getLiteralLexicalForm().equalsIgnoreCase(unitLanguage.getLiteralLexicalForm()))
                && namedValue(data, uri(CommandPolicy.REVISIONS), selection, "contribution").equals(namedValue(data, PUBLIC_GRAPH, unit, "contribution"))
                && namedValue(data, uri(CommandPolicy.REVISIONS), selection, "selectedDraft").equals(namedValue(data, PUBLIC_GRAPH, unit, "revision"))
                && admittedMain(data, unit.getURI(), scope, proof) != null) return unit.getURI();
        }
        return null;
    }
    /** Only leaves containing this exact name may open its phrase iterator.
     * Identity and phrase postings still pass through the observed weights. */
    private static int firstWorkNameHit(IndexSearcher searcher, Query query, String field, String name, long deadline) throws IOException {
        var identity = searcher.createWeight(searcher.rewrite(new TermQuery(new Term(field, name))), org.apache.lucene.search.ScoreMode.COMPLETE_NO_SCORES, 1f);
        var phrase = searcher.createWeight(searcher.rewrite(query), org.apache.lucene.search.ScoreMode.COMPLETE_NO_SCORES, 1f);
        for (var leaf : searcher.getIndexReader().leaves()) {
            if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
            var supplier = identity.scorerSupplier(leaf);
            if (supplier == null || supplier.cost() == 0) continue;
            var ids = supplier.get(Long.MAX_VALUE).iterator();
            var live = leaf.reader().getLiveDocs();
            org.apache.lucene.search.DocIdSetIterator matches = null;
            for (int doc = ids.nextDoc(); doc != org.apache.lucene.search.DocIdSetIterator.NO_MORE_DOCS; doc = ids.nextDoc()) {
                if (System.nanoTime() >= deadline) throw new TextIndexException("ranked query deadline exceeded");
                if (live != null && !live.get(doc)) continue;
                if (matches == null) {
                    var scorer = phrase.scorer(leaf);
                    if (scorer == null) break;
                    var phase = scorer.twoPhaseIterator();
                    matches = phase == null ? scorer.iterator() : org.apache.lucene.search.TwoPhaseIterator.asDocIdSetIterator(phase);
                }
                if (matches.docID() < doc) matches.advance(doc);
                if (matches.docID() == doc) return leaf.docBase + doc;
            }
        }
        return -1;
    }

    private static boolean canonicalGroupHit(org.apache.jena.sparql.core.DatasetGraph data, RankScope scope,
        IndexSearcher searcher, Query query, Query workNames, String key, String candidateId, int doc, String entityField, RankProof proof, long deadline) throws IOException {
        if (proof.groups.containsKey(key)) return proof.groups.get(key) == doc;
        Query membership = new TermQuery(new Term(RANK_GROUP, key));
        if (scope.catalogue()) {
            Node work = namedValue(data, CURRENT_GRAPH, uri(key), "work");
            if (PublicNameProjection.productResource(work)) {
                String name = PublicNameProjection.nameUnit(work, "work").getURI();
                if (name.equals(candidateId)) {
                    // This group's own complete name is the highest tier.
                    // Resolve its exact identity before opening title scorers,
                    // instead of scoring titles in every unrelated segment.
                    int first = firstWorkNameHit(searcher, workNames, entityField, name, deadline);
                    proof.groups.put(key, first);
                    if (first >= 0) CommandWork.count("rank_group_candidates_visited", 1);
                    return first == doc;
                }
                membership = new BooleanQuery.Builder().add(membership, BooleanClause.Occur.SHOULD)
                    .add(new TermQuery(new Term(entityField, name)), BooleanClause.Occur.SHOULD).build();
            }
        }
        Query grouped = new BooleanQuery.Builder().add(query, BooleanClause.Occur.MUST).add(membership, BooleanClause.Occur.FILTER).build();
        // Reject an ineligible identity once, including all its name/cache
        // documents. A 1001-name root must not consume 1001 witness probes or
        // hide a current lower-scoring chapter. The existing candidate budget
        // bounds distinct owner witnesses; exhausted uncertainty is explicit.
        var probe = new BooleanQuery.Builder().add(grouped, BooleanClause.Occur.MUST);
        for (int count = 0; count < 64; count++) {
            var top = searcher.search(probe.build(), 1);
            if (top.scoreDocs.length == 0) { proof.groups.put(key, -1); return false; }
            var hit = top.scoreDocs[0];
            String id = searcher.storedFields().document(hit.doc, java.util.Set.of(entityField)).get(entityField);
            CommandWork.count("rank_group_candidates_visited", 1);
            String witness = scope.catalogue() && id.startsWith(PublicNameProjection.PREFIX + "work:") ? nameWitness(data, id, scope, proof) : null;
            String admitted = admittedMain(data, witness == null ? id : witness, scope, proof);
            if (key.equals(admitted)) { proof.groups.put(key, hit.doc); return hit.doc == doc; }
            probe.add(new TermQuery(new Term(entityField, id)), BooleanClause.Occur.MUST_NOT);
        }
        if (searcher.search(probe.build(), 1).scoreDocs.length != 0)
            throw new TextIndexException("ranked group live-witness budget exceeded");
        proof.groups.put(key, -1); return false;
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

    /** ARQ exposes one bounded JSON envelope, followed by the owner's live RDF
     * join. Later commits cannot move a retained rank; expiry is a restart. */
    public static final class RankedFunction extends org.apache.jena.sparql.function.FunctionBase {
        @Override public void checkBuild(String uri, org.apache.jena.sparql.expr.ExprList args) {
            if (args.size() != 5) throw new org.apache.jena.sparql.expr.ExprEvalException("ranked text needs five arguments");
        }
        @Override public org.apache.jena.sparql.expr.NodeValue exec(List<org.apache.jena.sparql.expr.NodeValue> args) {
            throw new org.apache.jena.sparql.expr.ExprEvalException("ranked text requires a dataset");
        }
        @Override protected org.apache.jena.sparql.expr.NodeValue exec(
            List<org.apache.jena.sparql.expr.NodeValue> args, org.apache.jena.sparql.function.FunctionEnv env) {
            JsonObject request = org.apache.jena.atlas.json.JSON.parse(args.get(4).asString());
            if (request.hasKey("catalogueNames")) {
                if (!args.get(0).asNode().equals(uri(RV + "publicTitle")) || !args.get(1).asString().isEmpty()
                    || args.get(2).getInteger().intValueExact() != CatalogueNamePolicy.BODY_NAME_LIMIT || !args.get(3).asString().isEmpty())
                    throw new org.apache.jena.sparql.expr.ExprEvalException("name recipe needs its fixed read envelope");
                return org.apache.jena.sparql.expr.NodeValue.makeString(
                    CatalogueNamePolicy.recipe(env.getDataset(), request.get("catalogueNames").getAsObject()).toString());
            }
            FilteredGraphTextIndex index = functionIndex(env);
            String continuation = args.get(3).asString();
            RankAfter after = null;
            if (!continuation.isEmpty()) {
                JsonObject value = org.apache.jena.atlas.json.JSON.parse(continuation);
                after = new RankAfter(value.get("id").isNull() ? null : value.get("id").getAsString().value(),
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
                    optionalString(scopeValue, "names"), resources, optionalString(scopeValue, "matchMode"));
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
                    if (hit.unit() != null) row.put("unit", hit.unit());
                }
                response.put("hits", hits); response.put("commit", Long.toString(page.commit()));
                response.put("more", page.more());
                if (page.expiresAt() != 0) response.put("expiresAt", page.expiresAt());
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
    @Override public void close() {
        try {
            rankExpiryTask.cancel(false);
            try { closeRankBases(); }
            catch (IOException error) { throw new TextIndexException("ranked reader release failed", error); }
            finally { lucene.close(); }
        }
        finally {
            var observed = mergeIndex.get();
            if (observed.get() == this) mergeIndex.compareAndSet(observed, new java.lang.ref.WeakReference<>(null));
        }
    }
    @Override public void addEntity(Entity entity) {
        CommandWork.count("text_adds", 1);
        CommandWork.timed("text_index", () -> addMeasuredEntity(entity));
    }
    private void addMeasuredEntity(Entity entity) {
        if (!entity.getMap().containsKey(OccurrenceTextSchema.FIELD)) {
            var data = rankData.get();
            if (CommandPolicy.PUBLIC_SEARCH.equals(entity.getGraph())
                && (entity.getMap().containsKey("publicTitle") || data != null && entity.getMap().containsKey("body"))) {
                try { lucene.getIndexWriter().addDocument(rankDocument(entity, data == null ? null : rankMetadata(data, entity.getId()))); }
                catch (IOException error) { throw new TextIndexException("rank metadata write failed", error); }
            } else lucene.addEntity(entity);
            return;
        }
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
        doc.add(new org.apache.lucene.document.SortedDocValuesField(OccurrenceTextSchema.ORDER,
            new org.apache.lucene.util.BytesRef(entity.getId())));
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
            if (!entity.getMap().containsKey(OccurrenceTextSchema.FIELD)) {
                var data = rankData.get();
                if (CommandPolicy.PUBLIC_SEARCH.equals(entity.getGraph())
                    && (entity.getMap().containsKey("publicTitle") || data != null && entity.getMap().containsKey("body"))) {
                    try { lucene.getIndexWriter().updateDocument(new Term(lucene.getDocDef().getEntityField(), entity.getId()), rankDocument(entity, data == null ? null : rankMetadata(data, entity.getId()))); }
                    catch (IOException error) { throw new TextIndexException("rank metadata update failed", error); }
                } else lucene.updateEntity(entity);
                return;
            }
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
        try (var rankPhase = PublicSearchPhaseEvidence.phase(PublicSearchPhaseEvidence.Phase.RANK);
             var lease = openReader()) {
            DirectoryReader reader = lease.reader();
            QueryParser parser = new QueryParser(field, lucene.getQueryAnalyzer());
            parser.setAllowLeadingWildcard(true);
            Query body = parseQuery(parser, qs);
            BooleanQuery.Builder filtered = new BooleanQuery.Builder()
                .add(body, BooleanClause.Occur.MUST);
            if (graph != null) filtered.add(new TermQuery(new Term(definition.getGraphField(), graph)), BooleanClause.Occur.FILTER);
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
                if (entity == null || value == null || sourceGraph == null || graph != null && !graph.equals(sourceGraph)) {
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
