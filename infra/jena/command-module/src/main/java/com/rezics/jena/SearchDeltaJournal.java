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
import org.apache.jena.query.text.TextIndexException;
import org.apache.jena.query.text.changes.DatasetGraphTextMonitor;
import org.apache.jena.query.text.changes.TextDatasetChanges;
import org.apache.jena.query.text.changes.TextQuadAction;
import org.apache.jena.sparql.core.DatasetGraph;
import org.apache.jena.vocabulary.RDF;
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
    private static final Node CONTENT_SOURCE = uri(RV + "searchDeltaContentSource");
    private static final Node CONTENT_BODY_DIGEST = uri(RV + "searchDeltaContentBodyDigest");
    private static final Node WRITE_EPOCH = uri(RV + "searchDeltaWriteEpoch");
    private static final Node RESET = uri(RV + "searchDeltaReset");
    private static final Node GENERATION = uri(RV + "textIndexGeneration");
    private static final Node DATA_EPOCH = uri(RV + "dataEpoch");
    private static final Node SEQUENCE = uri(RV + "sequence");

    private record Qualification(String epoch, String generation, long ordinal,
                                 long luceneGeneration, long population, String sequence) {}
    private static final Map<DatasetGraph, Qualification> qualified = new WeakHashMap<>();
    private static final Map<DatasetGraph, Recovery> recovering = new WeakHashMap<>();
    private static final java.util.concurrent.ScheduledExecutorService recoveryExecutor =
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor(work -> {
            Thread thread = new Thread(work, "public-text-requalification");
            thread.setDaemon(true);
            return thread;
        });
    private static final class Recovery {
        final java.lang.ref.WeakReference<DatasetGraph> dataset;
        java.util.concurrent.ScheduledFuture<?> pending;
        long delayMs = 100;
        Recovery(DatasetGraph data) { dataset = new java.lang.ref.WeakReference<>(data); }
    }

    static void invalidate(DatasetGraph data) {
        synchronized (qualified) { qualified.remove(data); }
        if (lucene(data) == null) return;
        synchronized (recovering) {
            // Single flight per dataset, including while the audit is running.
            if (recovering.containsKey(data)) return;
            Recovery recovery = new Recovery(data);
            recovering.put(data, recovery);
            schedule(recovery);
        }
    }

    private static void schedule(Recovery recovery) {
        recovery.pending = recoveryExecutor.schedule(() -> recover(recovery), recovery.delayMs,
            java.util.concurrent.TimeUnit.MILLISECONDS);
    }
    private static void recover(Recovery recovery) {
        DatasetGraph data = recovery.dataset.get();
        if (data == null) return;
        boolean ready = false;
        // Native writers use this same monitor through post-commit proof
        // maintenance. Requalification is never a request-time inventory and
        // never installs a baseline for an intervening write.
        synchronized (data) {
            synchronized (recovering) { if (recovering.get(data) != recovery) return; }
            try { ready = qualify(data); }
            catch (RuntimeException transientFailure) { /* retain the closed read gate and retry */ }
        }
        synchronized (recovering) {
            if (recovering.get(data) != recovery) return;
            if (ready) recovering.remove(data);
            else {
                recovery.delayMs = Math.min(30_000, recovery.delayMs * 2);
                schedule(recovery);
            }
        }
    }
    static void stopRecovery(DatasetGraph data) {
        synchronized (recovering) {
            Recovery recovery = recovering.remove(data);
            if (recovery != null) recovery.pending.cancel(false);
        }
    }

    /** Older restored datasets can predate the native journal. Install only
     * its empty baseline before traffic; qualification still audits every RDF
     * and Lucene body. No caller-provided unit inventory is accepted. */
    static boolean qualifyAtStartup(DatasetGraph data) {
        boolean nativeScope = TemplateIndexService.workScopeNativeStorage(data);
        // Failed/repeated startup cannot retain an earlier same-store admission.
        if (nativeScope) TemplateIndexService.withdrawWorkScopeWriter(data);
        data.begin(org.apache.jena.query.ReadWrite.WRITE);
        try {
            if (nativeScope) PublicNameProjection.invalidateWorkScopeQualification(data);
            CommandInvariant.Control position = CommandInvariant.readControl(data);
            if (position == null || position.textGeneration() == null) return false;
            if (!data.contains(GRAPH, STATE, ORDINAL, Node.ANY)) initialize(data);
            data.commit();
        } finally { data.end(); }
        // Admission follows the committed RDF/Lucene audit; a false result or
        // exception must leave repeated startup closed on this same store.
        boolean qualified = qualify(data);
        if (nativeScope && qualified) TemplateIndexService.admitWorkScopeWriter(data);
        return qualified;
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
        synchronized (qualified) { qualified.remove(data); }
        TextIndexLucene index = lucene(data);
        Qualification baseline = auditGeneration(data, index);
        if (baseline == null) { invalidate(data); return false; }
        synchronized (qualified) { qualified.put(data, baseline); }
        return true;
    }

    private static Qualification auditGeneration(DatasetGraph data, TextIndexLucene lucene) {
        return auditGeneration(data, lucene, true);
    }

    private static Qualification auditGeneration(DatasetGraph data, TextIndexLucene lucene, boolean requireAnchor) {
        boolean ownsTransaction = !data.isInTransaction();
        if (ownsTransaction) data.begin(org.apache.jena.query.ReadWrite.READ);
        try {
            CommandInvariant.Control position = CommandInvariant.readControl(data);
            if (position == null || position.textGeneration() == null || lucene == null || position.held()
                || requireAnchor && !data.contains(PUBLIC, ANCHOR, RDF.type.asNode(), uri(RV + "SearchGraphAnchor")))
                return null;
            if (!CanonicalPolicy.auditRealmOwners(data)) return null;
            try (DirectoryReader reader = DirectoryReader.open(lucene.getDirectory())) {
                IndexSearcher searcher = new IndexSearcher(reader);
                boolean rankMetadata = org.apache.lucene.index.FieldInfos.getMergedFieldInfos(reader).fieldInfo(FilteredGraphTextIndex.RANK_SCHEMA) != null;
                Set<String> seen = new LinkedHashSet<>();
                // Membership is graph/document identity, independent of analyzer tokens.
                TermQuery query = new TermQuery(new Term("graph", CommandPolicy.PUBLIC_SEARCH));
                searcher.search(query, new SimpleCollector() {
                    private LeafReaderContext leaf;
                    @Override protected void doSetNextReader(LeafReaderContext context) { leaf = context; }
                    @Override public ScoreMode scoreMode() { return ScoreMode.COMPLETE_NO_SCORES; }
                    @Override public void collect(int doc) throws IOException {
                        Document stored = leaf.reader().storedFields().document(doc);
                        String subject = stored.get("uri");
                        if (rankMetadata && stored.getValues("publicTitle").length != 0 && subject != null
                            && !subject.startsWith(PublicNameProjection.PREFIX) && !subject.startsWith(PublicNameProjection.DIRECTORY)
                            && !FilteredGraphTextIndex.rankMetadataMatches(data, subject, stored))
                            throw new IllegalStateException("public title rank metadata differs from RDF");
                        if (stored.getValues("body").length == 0) return;
                        if (subject != null && !CanonicalPolicy.realmUnitOwnerValid(data, uri(subject)))
                            throw new IllegalStateException("public body has a noncanonical Realm owner");
                        if (subject == null || !seen.add(subject))
                            throw new IllegalStateException("duplicate public body document");
                        if (contentUnit(subject)) {
                            if (verifyContentSubject(data, lucene, subject) != reader.getIndexCommit().getGeneration())
                                throw new IllegalStateException("public Content reader changed during audit");
                        } else {
                            Node unit = uri(subject), body = one(data, PUBLIC, unit, BODY);
                            if (!data.contains(PUBLIC, unit, RDF.type.asNode(), MATCH_UNIT)
                                || body == null || !body.isLiteral() || stored.getValues("body").length != 1
                                || !body.getLiteralLexicalForm().equals(stored.get("body"))
                                || !body.getLiteralLanguage().equalsIgnoreCase(stored.get("lang") == null ? "" : stored.get("lang")))
                                throw new IllegalStateException("public index differs from RDF");
                        }
                        if (rankMetadata && !FilteredGraphTextIndex.rankMetadataMatches(data, subject, stored))
                            throw new IllegalStateException("public rank metadata differs from RDF");
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
                    reader.getIndexCommit().getGeneration(), population, position.sequence().toString());
            } catch (IOException | IllegalStateException | TextIndexException ex) {
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

    private static TextIndexLucene lucene(DatasetGraph data) {
        if (!(data instanceof DatasetGraphText text)) return null;
        return text.getTextIndex() instanceof FilteredGraphTextIndex filtered
            ? filtered.lucene() : text.getTextIndex() instanceof TextIndexLucene direct ? direct : null;
    }

    private static boolean contentUnit(String unit) {
        return unit.startsWith("urn:rezics:content:match-unit:");
    }

    /** Bind only a newly admitted delivery. An old receipt's missing pins
     * cannot be reconstructed from a later relay or the current document. */
    static void retainContentReceiptSource(DatasetGraph data, String receipt) {
        Node receipts = uri(CommandPolicy.RECEIPTS), own = uri(receipt);
        Node unit = one(data, receipts, own, uri(RV + "matchUnit"));
        if (unit == null || !unit.isURI() || !contentUnit(unit.getURI())) return;
        TextEntityDocuments.Source source = FilteredGraphTextIndex.contentBodySource(data, unit.getURI());
        if (source == null) throw new IllegalStateException("new Content receipt has no delivery source");
        String identity = FilteredGraphTextIndex.contentBodyIdentity(data, unit.getURI());
        if (data.contains(receipts, own, CONTENT_SOURCE, Node.ANY)
            || data.contains(receipts, own, CONTENT_BODY_DIGEST, Node.ANY))
            throw new IllegalStateException("Content receipt source is reserved native metadata");
        data.add(receipts, own, CONTENT_SOURCE, literal(source.encoded()));
        data.add(receipts, own, CONTENT_BODY_DIGEST, literal(identity));
    }

    /** Resolve the current freshly admitted receipt by its exact projection point. */
    private static String currentContentBodyDigest(DatasetGraph data, String unit) {
        Node projection = one(data, PUBLIC, uri(unit), uri(RV + "projection"));
        if (projection == null || !projection.isURI()) throw new IllegalStateException("Content projection unavailable");
        var receipts = data.find(uri(CommandPolicy.RECEIPTS), Node.ANY, uri(RV + "projection"), projection);
        Node receipt;
        try {
            if (!receipts.hasNext()) throw new IllegalStateException("original Content receipt unavailable");
            receipt = receipts.next().getSubject();
            if (!receipt.isURI() || receipts.hasNext()) throw new IllegalStateException("original Content receipt ambiguous");
        } finally { org.apache.jena.atlas.iterator.Iter.close(receipts); }
        return contentReceiptBodyDigest(data, receipt.getURI(), unit);
    }

    static String contentReceiptBodyDigest(DatasetGraph data, String receipt, String unit) {
        Node own = uri(receipt), receipts = uri(CommandPolicy.RECEIPTS), subject = uri(unit);
        if (!data.contains(receipts, own, RDF.type.asNode(), uri(RV + "OperationReceipt"))
            || !uri(RV + "Succeeded").equals(one(data, receipts, own, uri(RV + "outcome"))))
            throw new IllegalStateException("original Content receipt is not a successful operation");
        TextEntityDocuments.Source current = FilteredGraphTextIndex.contentBodyMetadataSource(data, unit);
        if (current == null || !literal(current.encoded()).equals(one(data, receipts, own, CONTENT_SOURCE)))
            throw new IllegalStateException("original Content receipt source differs from current authority");
        for (String field : List.of("variant", "resource", "publicationDecision", "eligibility", "projection")) {
            Node value = one(data, PUBLIC, subject, uri(RV + field));
            if (value == null || !value.equals(one(data, receipts, own, uri(RV + field))))
                throw new IllegalStateException("original Content receipt metadata differs: " + field);
        }
        if (!subject.equals(one(data, receipts, own, uri(RV + "matchUnit")))
            || !uri(current.reference()).equals(one(data, receipts, own, uri(RV + "contentRevision"))))
            throw new IllegalStateException("original Content receipt unit/revision differs");
        Node identity = one(data, receipts, own, CONTENT_BODY_DIGEST);
        if (identity == null || !identity.isLiteral() || identity.getLiteralLexicalForm().length() != 64
            || !identity.getLiteralLexicalForm().matches("[0-9a-f]{64}")
            || !literal(identity.getLiteralLexicalForm()).equals(identity))
            throw new IllegalStateException("original Content body identity unavailable");
        return identity.getLiteralLexicalForm();
    }

    /** Lost acknowledgements recheck retained source pins before returning an old receipt.
     * Repair is part of this writer and the existing journal, not another commit. */
    static boolean repairContentReceipt(DatasetGraph data, String receipt, Capture capture,
                                        long completedWriteEpoch) {
        if (capture == null) return false;
        Node receiptNode = uri(receipt);
        if (!data.contains(uri(CommandPolicy.RECEIPTS), receiptNode, uri(RV + "matchUnit"), Node.ANY))
            return false;
        Node unit = one(data, uri(CommandPolicy.RECEIPTS), receiptNode, uri(RV + "matchUnit"));
        if (unit == null || !unit.isURI()) throw new IllegalStateException("receipt MatchUnit ambiguous");
        if (!contentUnit(unit.getURI())) return false;
        Node original = one(data, uri(CommandPolicy.RECEIPTS), receiptNode, CONTENT_SOURCE);
        if (original == null || !original.isLiteral() || original.getLiteralLexicalForm().isEmpty())
            throw new IllegalStateException("original Content receipt source unavailable");
        // Validate authoritative pins first. A changed/malformed head is a refusal,
        // never permission to mint source metadata from retained body text.
        TextEntityDocuments.Source current = FilteredGraphTextIndex.contentBodyMetadataSource(data, unit.getURI());
        if (!original.equals(literal(current == null ? "" : current.encoded())))
            throw new IllegalStateException("original Content receipt source differs from current authority");
        String identity = contentReceiptBodyDigest(data, receipt, unit.getURI());
        String recorded = latestContentSource(data, unit);
        if (recorded != null && !recorded.equals(current == null ? "" : current.encoded()))
            throw new IllegalStateException("receipt Content source differs from recorded delivery");
        String recordedIdentity = latestContentBodyDigest(data, unit);
        if (recordedIdentity != null && !identity.equals(recordedIdentity))
            throw new IllegalStateException("receipt Content body differs from recorded delivery");
        try {
            FilteredGraphTextIndex.verifyContentBodyCommitted(data, unit.getURI(), identity);
            capture.contentReplayIntact = true;
            return false;
        } catch (TextIndexException mismatch) {
            // Old intact receipts remain replayable after journal trimming, but
            // repair requires retained delivery pins rather than inferred source pins.
            if (recorded == null || recordedIdentity == null)
                throw new IllegalStateException("receipt Content repair source unavailable", mismatch);
            if (!identity.equals(FilteredGraphTextIndex.contentBodyIdentity(data, unit.getURI())))
                throw new IllegalStateException("repair text differs from original Content body identity", mismatch);
            capture.touch(unit);
            append(data, capture, completedWriteEpoch);
            return true;
        }
    }

    private static String latestContentSource(DatasetGraph data, Node unit) {
        Node selected = latestContentItem(data, unit);
        if (selected == null) return null;
        Node source = one(data, GRAPH, selected, CONTENT_SOURCE);
        if (source == null && !data.contains(GRAPH, selected, CONTENT_SOURCE, Node.ANY)
            && resetContentItem(data, selected)) return null;
        if (source == null || !source.isLiteral())
            throw new IllegalStateException("receipt Content delivery source unavailable");
        return source.getLiteralLexicalForm();
    }
    private static String latestContentBodyDigest(DatasetGraph data, Node unit) {
        Node selected = latestContentItem(data, unit);
        if (selected == null) return null;
        Node identity = one(data, GRAPH, selected, CONTENT_BODY_DIGEST);
        if (identity == null && !data.contains(GRAPH, selected, CONTENT_BODY_DIGEST, Node.ANY)
            && resetContentItem(data, selected)) return null;
        if (identity == null || !identity.isLiteral() || !literal(identity.getLiteralLexicalForm()).equals(identity)
            || !identity.getLiteralLexicalForm().isEmpty() && (identity.getLiteralLexicalForm().length() != 64
                || !identity.getLiteralLexicalForm().matches("[0-9a-f]{64}")))
            throw new IllegalStateException("receipt Content delivery body identity unavailable");
        return identity.getLiteralLexicalForm();
    }
    private static boolean resetContentItem(DatasetGraph data, Node item) {
        String name = item.getURI();
        return data.contains(GRAPH, uri(name.substring(0, name.indexOf(":unit:"))), RESET, literal("true"));
    }
    private static Node latestContentItem(DatasetGraph data, Node unit) {
        long head = ordinal(data), latest = -1;
        Node selected = null;
        var items = data.find(GRAPH, Node.ANY, UNIT, unit);
        try {
            int count = 0;
            while (items.hasNext()) {
                Node item = items.next().getSubject();
                if (++count > MAX_ENTRIES || !item.isURI() || item.getURI().length() > 128
                    || !item.getURI().matches("urn:rezics:search:delta:(0|[1-9][0-9]*):unit:(0|[1-9][0-9]*)"))
                    throw new IllegalStateException("receipt Content journal malformed");
                String name = item.getURI();
                long number;
                try { number = Long.parseLong(name.substring("urn:rezics:search:delta:".length(), name.indexOf(":unit:"))); }
                catch (NumberFormatException malformed) { throw new IllegalStateException("receipt Content ordinal malformed", malformed); }
                if (number > head || number <= Math.max(0, head - MAX_ENTRIES)
                    || !data.contains(GRAPH, entry(number), UNIT, item) || !unit.equals(one(data, GRAPH, item, UNIT)))
                    throw new IllegalStateException("receipt Content journal outside retained head");
                if (number == latest) throw new IllegalStateException("receipt Content journal duplicate unit");
                if (number > latest) { latest = number; selected = item; }
            }
        } finally { org.apache.jena.atlas.iterator.Iter.close(items); }
        return selected;
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
            || !baseline.generation().equals(replay.get("generation"))) {
            invalidate(data);
            return Map.of("available", false);
        }
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
        if (population < 0 || deltas.isEmpty() && luceneGeneration != baseline.luceneGeneration()) {
            invalidate(data);
            return Map.of("available", false);
        }
        Qualification next = new Qualification(baseline.epoch(), baseline.generation(),
            Long.parseLong((String) replay.get("ordinal")), luceneGeneration, population,
            (String) replay.get("sequence"));
        synchronized (qualified) {
            // A slower read must not overwrite a later writer's qualification.
            if (qualified.get(data) == baseline) {
                qualified.put(data, next);
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
        private final SemanticSourceBasis.Capture semanticSources;
        private final Map<Node, Boolean> before = new LinkedHashMap<>();
        private final Map<Node, Node> works = new LinkedHashMap<>();
        private final Set<Node> realmOwners = new LinkedHashSet<>();
        private final Map<Node, TemplateIndexService.Entity> realmBefore = new LinkedHashMap<>();
        private final Map<org.apache.jena.sparql.core.Quad, Boolean> sourceBefore = new LinkedHashMap<>();
        private final Map<org.apache.jena.sparql.core.Quad, Set<Node>> sourceOwners = new LinkedHashMap<>();
        private boolean scopeApplied;
        private final Set<Node> headTouchedUnits = new LinkedHashSet<>(), publicTouchedUnits = new LinkedHashSet<>();
        private boolean reset;
        private final long deadline;
        private boolean contentReplayIntact;
        boolean contentReplayIntact() { return contentReplayIntact; }

        Capture(DatasetGraph data) { this(data, false); }
        Capture(DatasetGraph data, boolean rebuild) { this(data, rebuild, Long.MAX_VALUE); }
        Capture(DatasetGraph data, boolean rebuild, long deadline) {
            this.data = data; this.reset = rebuild; this.deadline = deadline;
            this.semanticSources = new SemanticSourceBasis.Capture(data);
        }
        void sourceDeadline(long deadline) { semanticSources.deadline(deadline); }
        void finishSemanticSources(long deadline) { semanticSources.finish(deadline); }
        DatasetGraph observed() { return new DatasetGraphTextMonitor(data, this); }
        private void touch(Node unit) {
            if (!unit.isURI() || unit.getURI().getBytes(StandardCharsets.UTF_8).length > 128)
                throw new IllegalArgumentException("public search subject IRI exceeds delta bound");
            if (!before.containsKey(unit) && before.size() >= MAX_UNITS)
                throw new IllegalArgumentException("actual public search delta exceeds 64 units");
            before.putIfAbsent(unit, indexed(data, unit));
        }
        @Override public void start() {}
        @Override public void finish() {}
        @Override public void reset() {}
        /** A real callback follows mutation. Reverse only its exact quad, not
         * an owner inventory, for the first bounded prestate snapshot. */
        private DatasetGraph previous(org.apache.jena.sparql.core.Quad changed, TextQuadAction action) {
            return new org.apache.jena.sparql.core.DatasetGraphWrapper(data) {
                @Override public java.util.Iterator<org.apache.jena.sparql.core.Quad> find(Node graph, Node subject, Node predicate, Node object) {
                    var original = super.find(graph, subject, predicate, object);
                    if (action == TextQuadAction.ADD) return org.apache.jena.atlas.iterator.Iter.filter(original, quad -> !quad.equals(changed));
                    boolean matches = (graph == Node.ANY || graph.equals(changed.getGraph()))
                        && (subject == Node.ANY || subject.equals(changed.getSubject()))
                        && (predicate == Node.ANY || predicate.equals(changed.getPredicate()))
                        && (object == Node.ANY || object.equals(changed.getObject()));
                    return matches ? org.apache.jena.atlas.iterator.Iter.concat(original, java.util.List.of(changed).iterator()) : original;
                }
                @Override public boolean contains(Node graph, Node subject, Node predicate, Node object) {
                    var rows = find(graph, subject, predicate, object);
                    try { return rows.hasNext(); } finally { org.apache.jena.atlas.iterator.Iter.close(rows); }
                }
            };
        }
        private void scopeEffects(DatasetGraph target, long requestedDeadline) {
            long budget = Math.min(deadline, requestedDeadline);
            TemplateIndexService.workScopeBudget(budget);
            if (scopeApplied) return;
            Set<Node> changed = new LinkedHashSet<>();
            for (var entry : sourceBefore.entrySet()) {
                TemplateIndexService.workScopeBudget(budget);
                var quad = entry.getKey();
                if (entry.getValue() == data.contains(quad.getGraph(), quad.getSubject(), quad.getPredicate(), quad.getObject())) continue;
                changed.addAll(sourceOwners.get(quad)); changed.addAll(PublicNameProjection.nameSourceOwners(data, quad));
                CommandWork.count("work_name_source_effect_quads", 1);
                if (changed.size() > MAX_UNITS) throw new IllegalArgumentException("actual Work name source delta exceeds 64 owners");
            }
            PublicNameProjection.actualWorkScopeEffects(target, realmBefore, changed, reset, budget);
            TemplateIndexService.workScopeBudget(budget);
            scopeApplied = true;
        }
        @Override public void change(TextQuadAction action, Node graph, Node subject, Node predicate, Node object) {
            if (action != TextQuadAction.ADD && action != TextQuadAction.DELETE) return;
            TemplateIndexService.workScopeBudget(deadline);
            var quad = new org.apache.jena.sparql.core.Quad(graph, subject, predicate, object);
            semanticSources.change(action, quad);
            if (!reset && PublicNameProjection.nameSourceQuad(quad) && !sourceBefore.containsKey(quad)) {
                // Match the existing item savepoint's retained primary-quad
                // bound. This limits one transaction, never legal names.
                if (sourceBefore.size() == 16_384) throw new IllegalArgumentException("actual Work name source effects exceed the native item bound");
                sourceBefore.put(quad, action == TextQuadAction.DELETE);
                sourceOwners.put(quad, PublicNameProjection.nameSourceOwners(previous(quad, action), quad));
            }
            if (!reset && uri(CommandPolicy.CURRENT).equals(graph) && (action == TextQuadAction.ADD || action == TextQuadAction.DELETE)
                && (uri(RV + "contentPublicationHead").equals(predicate) || uri(RV + "publicSearchEligibilityHead").equals(predicate))) {
                // A source-head-only write must not preserve an older text qualification.
                // Touch its bounded derived units so append fences stale text until relay.
                var units = data.find(PUBLIC, Node.ANY, uri(RV + "variant"), subject);
                try {
                    int count = 0;
                    while (units.hasNext()) {
                        if (++count > MAX_UNITS) throw new IllegalArgumentException("actual Content source delta exceeds 64 units");
                        Node unit = units.next().getSubject();
                        if (unit.isURI() && contentUnit(unit.getURI())) { touch(unit); headTouchedUnits.add(unit); }
                    }
                } finally { org.apache.jena.atlas.iterator.Iter.close(units); }
            }
            if (uri(CommandPolicy.CURRENT).equals(graph) && (action == TextQuadAction.ADD || action == TextQuadAction.DELETE)
                && (RDF.type.asNode().equals(predicate) && uri(RV + "RealmPublicationSlot").equals(object)
                    || data.contains(graph, subject, RDF.type.asNode(), uri(RV + "RealmPublicationSlot")))) {
                if (!reset && !realmOwners.contains(subject) && realmOwners.size() == MAX_UNITS)
                    throw new IllegalArgumentException("actual Realm owner delta exceeds 64 owners");
                if (!reset && realmOwners.add(subject)) realmBefore.put(subject,
                    TemplateIndexService.entity(previous(quad, action), CommandPolicy.CURRENT, subject.getURI()));
            }
            if (subject.isURI() && (subject.getURI().startsWith(PublicNameProjection.PREFIX)
                || subject.getURI().startsWith(PublicNameProjection.DIRECTORY))) return;
            if (!PUBLIC.equals(graph) || action != TextQuadAction.ADD && action != TextQuadAction.DELETE) return;
            if (action == TextQuadAction.DELETE && uri(RV + "work").equals(predicate) && object.isURI())
                works.put(subject, object);
            if (ANCHOR.equals(subject)) { reset = true; return; }
            if (!subject.isURI()) throw new IllegalArgumentException("public search subject is not an IRI");
            if (!reset && subject.getURI().getBytes(StandardCharsets.UTF_8).length > 128)
                throw new IllegalArgumentException("public search subject IRI exceeds delta bound");
            if (!reset) publicTouchedUnits.add(subject);
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
                result.add(new Change(subject.getURI(), candidate.getValue(), after, works.get(subject)));
            }
            return result;
        }
    }
    record Change(String unit, boolean before, boolean after, Node work) {
        Change(String unit, boolean before, boolean after) { this(unit, before, after, null); }
    }
    static boolean matchesClaim(List<Change> changes, String claimed) {
        Set<String> live = new LinkedHashSet<>();
        for (Change change : changes) if (change.after()) live.add(change.unit());
        return claimed == null ? live.isEmpty() : live.equals(Set.of(claimed));
    }
    record Delta(long ordinal, String dataEpoch, String sequence, String generation,
                 long writeEpoch, boolean reset, List<Change> changes, Map<String, String> contentSources) {}

    static void initialize(DatasetGraph data) {
        if (data.contains(GRAPH, STATE, ORDINAL, Node.ANY))
            throw new IllegalStateException("search delta state already exists");
        data.add(GRAPH, STATE, ORDINAL, literal("0"));
    }

    static void append(DatasetGraph data, Capture capture, long completedWriteEpoch) {
        append(data, capture, completedWriteEpoch, capture.deadline);
    }
    static void append(DatasetGraph data, Capture capture, long completedWriteEpoch, long deadline) {
        long budget = Math.min(deadline, capture.deadline);
        TemplateIndexService.workScopeBudget(budget);
        List<Change> changes = capture.changes();
        Set<String> staleHeads = new LinkedHashSet<>();
        Map<String, String> retainedSources = new LinkedHashMap<>();
        Map<String, String> retainedBodies = new LinkedHashMap<>();
        if (!capture.reset) for (Node unit : capture.headTouchedUnits) if (!capture.publicTouchedUnits.contains(unit) && staleContentHeads(data, unit)) {
            staleHeads.add(unit.getURI());
            retainedSources.put(unit.getURI(), data.contains(GRAPH, STATE, ORDINAL, Node.ANY) ? latestContentSource(data, unit) : null);
            retainedBodies.put(unit.getURI(), data.contains(GRAPH, STATE, ORDINAL, Node.ANY) ? latestContentBodyDigest(data, unit) : null);
        }
        for (Node slot : capture.realmOwners) {
            TemplateIndexService.workScopeBudget(budget);
            if (data.contains(uri(CommandPolicy.CURRENT), slot, RDF.type.asNode(), uri(RV + "RealmPublicationSlot"))
                && CanonicalPolicy.realmSlotOwnerFailure(data, slot) != null)
                throw new IllegalStateException("native delta contains a noncanonical Realm owner");
        }
        if (capture.reset && !CanonicalPolicy.auditRealmOwners(data)) throw new IllegalStateException("native reset contains a noncanonical Realm owner");
        capture.scopeEffects(data, budget);
        FilteredGraphTextIndex.refreshRankMetadata(data, changes.stream().filter(value -> !staleHeads.contains(value.unit())).toList(), capture.reset);
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
        // Async source-head replacement closes qualification until relay/audit;
        // it does not request the physical full rebuild represented by capture.reset.
        data.add(GRAPH, id, RESET, literal(Boolean.toString(capture.reset || !staleHeads.isEmpty())));
        for (int i = 0; i < changes.size(); i++) {
            Change value = changes.get(i);
            Node item = change(next, i);
            data.add(GRAPH, id, UNIT, item);
            data.add(GRAPH, item, UNIT, uri(value.unit()));
            data.add(GRAPH, item, BEFORE, literal(Boolean.toString(value.before())));
            data.add(GRAPH, item, AFTER, literal(Boolean.toString(value.after())));
            if (contentUnit(value.unit())) {
                if (staleHeads.contains(value.unit())) {
                    String retained = retainedSources.get(value.unit());
                    if (retained != null) data.add(GRAPH, item, CONTENT_SOURCE, literal(retained));
                    String body = retainedBodies.get(value.unit());
                    if (body != null) data.add(GRAPH, item, CONTENT_BODY_DIGEST, literal(body));
                } else {
                    TextEntityDocuments.Source source = FilteredGraphTextIndex.contentBodySource(data, value.unit());
                    data.add(GRAPH, item, CONTENT_SOURCE, literal(source == null ? "" : source.encoded()));
                    data.add(GRAPH, item, CONTENT_BODY_DIGEST, literal(source == null ? ""
                        : FilteredGraphTextIndex.contentBodyIdentity(data, value.unit())));
                }
            }
        }
        if (next > MAX_ENTRIES) {
            Node expired = entry(next - MAX_ENTRIES);
            var items = data.find(GRAPH, expired, UNIT, Node.ANY);
            List<Node> old = new ArrayList<>();
            while (items.hasNext()) old.add(items.next().getObject());
            for (Node item : old) data.deleteAny(GRAPH, item, Node.ANY, Node.ANY);
            data.deleteAny(GRAPH, expired, Node.ANY, Node.ANY);
        }
        TemplateIndexService.workScopeBudget(budget);
    }

    private static boolean staleContentHeads(DatasetGraph data, Node unit) {
        if (!data.contains(PUBLIC, unit, Node.ANY, Node.ANY)) return false;
        Node variant = one(data, PUBLIC, unit, uri(RV + "variant"));
        Node publication = one(data, PUBLIC, unit, uri(RV + "publicationDecision"));
        Node eligibility = one(data, PUBLIC, unit, uri(RV + "eligibility"));
        if (variant == null || !variant.isURI() || publication == null || !publication.isURI() || eligibility == null || !eligibility.isURI())
            throw new IllegalStateException("Content source links missing or ambiguous");
        Node current = uri(CommandPolicy.CURRENT);
        Node publicationHead = one(data, current, variant, uri(RV + "contentPublicationHead"));
        Node eligibilityHead = one(data, current, variant, uri(RV + "publicSearchEligibilityHead"));
        if (publicationHead == null && data.contains(current, variant, uri(RV + "contentPublicationHead"), Node.ANY)
            || eligibilityHead == null && data.contains(current, variant, uri(RV + "publicSearchEligibilityHead"), Node.ANY)
            || publicationHead != null && !publicationHead.isURI() || eligibilityHead != null && !eligibilityHead.isURI())
            throw new IllegalStateException("Content source heads malformed");
        return !publication.equals(publicationHead) || !eligibility.equals(eligibilityHead);
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
        Map<String, String> contentSources = new LinkedHashMap<>();
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
            if (contentUnit(unit.getURI())) {
                Node source = one(data, GRAPH, item, CONTENT_SOURCE);
                boolean unknownResetSource = source == null && !data.contains(GRAPH, item, CONTENT_SOURCE, Node.ANY)
                    && "true".equals(reset.getLiteralLexicalForm());
                if (!unknownResetSource && (source == null || !source.isLiteral()))
                    throw new IllegalStateException("Content source delta missing or ambiguous");
                if (!unknownResetSource && contentSources.put(unit.getURI(), source.getLiteralLexicalForm()) != null)
                    throw new IllegalStateException("duplicate Content source delta");
                Node identity = one(data, GRAPH, item, CONTENT_BODY_DIGEST);
                boolean unknownResetBody = identity == null && !data.contains(GRAPH, item, CONTENT_BODY_DIGEST, Node.ANY)
                    && "true".equals(reset.getLiteralLexicalForm());
                if (!unknownResetBody && (identity == null || !identity.isLiteral()
                    || !literal(identity.getLiteralLexicalForm()).equals(identity)
                    || !identity.getLiteralLexicalForm().isEmpty() && (identity.getLiteralLexicalForm().length() != 64
                        || !identity.getLiteralLexicalForm().matches("[0-9a-f]{64}"))))
                    throw new IllegalStateException("Content body identity delta missing or ambiguous");
            } else if (data.contains(GRAPH, item, CONTENT_SOURCE, Node.ANY)
                || data.contains(GRAPH, item, CONTENT_BODY_DIGEST, Node.ANY)) {
                throw new IllegalStateException("unexpected Content source delta");
            }
            if (changes.size() > MAX_UNITS) throw new IllegalStateException("search delta entry oversized");
        }
        return new Delta(number, epoch.getLiteralLexicalForm(), sequence.getLiteralLexicalForm(),
            generation.getURI(), Long.parseLong(write.getLiteralLexicalForm()),
            Boolean.parseBoolean(reset.getLiteralLexicalForm()), List.copyOf(changes), Map.copyOf(contentSources));
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
            Map<String, String> contentSources = new LinkedHashMap<>();
            int totalChanges = 0;
            if (since >= 0) for (long number = since + 1; number <= head; number++) {
                Delta delta;
                try { delta = readEntry(data, number); }
                catch (IllegalStateException malformed) { return Map.of("available", false); }
                if (!delta.dataEpoch().equals(position.epoch().getLiteralLexicalForm())
                    || !delta.generation().equals(position.textGeneration().getURI()) || delta.reset()
                    || delta.writeEpoch() > writeEpoch || (delta.writeEpoch() & 1L) != 0L)
                    return Map.of("available", false);
                deltas.add(delta);
                contentSources.putAll(delta.contentSources());
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
                for (var source : contentSources.entrySet()) {
                    TextEntityDocuments.Source current = FilteredGraphTextIndex.contentBodyMetadataSource(data, source.getKey());
                    if (!source.getValue().equals(current == null ? "" : current.encoded()))
                        throw new IllegalStateException("Content source delta differs from current authority");
                }
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
            } catch (IOException | IllegalStateException | TextIndexException ex) {
                return Map.of("available", false);
            }
        } finally { if (ownsTransaction) data.end(); }
    }

    private static void verifySubject(DatasetGraph data, TextIndexLucene lucene,
                                      IndexSearcher searcher, String subject)
        throws IOException {
        if (contentUnit(subject)) {
            if (verifyContentSubject(data, lucene, subject) != ((DirectoryReader) searcher.getIndexReader()).getIndexCommit().getGeneration())
                throw new IllegalStateException("Content reader changed during proof");
            return;
        }
        Node unit = uri(subject);
        boolean exists = indexed(data, unit);
        Node body = exists ? one(data, PUBLIC, unit, BODY) : null;
        BooleanQuery exact = new BooleanQuery.Builder()
            .add(new TermQuery(new Term("uri", subject)), BooleanClause.Occur.MUST)
            .add(new TermQuery(new Term("graph", CommandPolicy.PUBLIC_SEARCH)), BooleanClause.Occur.FILTER)
            .add(new org.apache.lucene.search.FieldExistsQuery("body"), BooleanClause.Occur.FILTER)
            .build();
        var hits = searcher.search(exact, 2);
        if (hits.totalHits.value() > 1) throw new IllegalStateException("too many exact-subject body documents");
        int bodies = 0;
        for (var hit : hits.scoreDocs) {
            Document doc = searcher.storedFields().document(hit.doc);
            String[] values = doc.getValues("body");
            if (values.length == 0) continue;
            if (!CanonicalPolicy.realmUnitOwnerValid(data, unit)) throw new IllegalStateException("exact-subject body has a noncanonical Realm owner");
            if (values.length != 1 || body == null || !body.getLiteralLexicalForm().equals(values[0])
                || !body.getLiteralLanguage().equalsIgnoreCase(doc.get("lang")))
                throw new IllegalStateException("exact-subject body differs from RDF");
            if (org.apache.lucene.index.FieldInfos.getMergedFieldInfos(searcher.getIndexReader()).fieldInfo(FilteredGraphTextIndex.RANK_SCHEMA) != null
                && !FilteredGraphTextIndex.rankMetadataMatches(data, subject, doc))
                throw new IllegalStateException("exact-subject rank metadata differs from RDF");
            bodies++;
        }
        if (bodies != (exists ? 1 : 0)) throw new IllegalStateException("exact-subject index membership differs");
    }
    private static long verifyContentSubject(DatasetGraph data, TextIndexLucene lucene, String subject) {
        var current = FilteredGraphTextIndex.contentBodyMetadataSource(data, subject);
        String identity = current == null ? "" : currentContentBodyDigest(data, subject);
        String source = latestContentSource(data, uri(subject)), body = latestContentBodyDigest(data, uri(subject));
        if (source != null && !source.equals(current == null ? "" : current.encoded())
            || body != null && !body.equals(identity))
            throw new IllegalStateException("public Content differs from recorded delivery");
        return FilteredGraphTextIndex.verifyContentBody(data, lucene, subject, identity, true);
    }
    private SearchDeltaJournal() {}
}
