package com.rezics.jena;

import org.apache.jena.assembler.Assembler;
import org.apache.jena.assembler.Mode;
import org.apache.jena.query.text.TextIndex;
import org.apache.jena.query.text.TextIndexLucene;
import org.apache.jena.query.text.assembler.TextIndexLuceneAssembler;
import org.apache.jena.rdf.model.Resource;

/** Uses the reviewed Jena Lucene assembler for the physical index, then swaps
 * only the graph-scoped read behavior. */
public final class FilteredGraphTextAssembler extends TextIndexLuceneAssembler {
    private static final String SEARCH_TRANSFORM = "Traditional-Simplified; Hiragana-Katakana";
    /** Scalar substring keys use the same character normalization and script
     * folding as the token analyzer, before its per-script token boundaries. */
    static String foldSearchText(String value) {
        return com.ibm.icu.text.Transliterator.getInstance(SEARCH_TRANSFORM).transliterate(
            com.ibm.icu.text.Normalizer2.getNFKCCasefoldInstance().normalize(value));
    }
    /** cjk-bigram-v2. Fold before bigram generation on both index and query;
     * stored values and their languages are never transformed. Each token
     * stream owns its ICU transliterator (which is mutable, not thread-safe).
     * Cost is streaming O(input characters), with Lucene's bounded tokenizer. */
    public static final class CjkBigramV2 extends org.apache.lucene.analysis.Analyzer {
        @Override protected java.io.Reader initReader(String field, java.io.Reader reader) {
            // Normalize before tokenization: half-width voiced kana must compose
            // before the tokenizer assigns script types and token boundaries.
            return new org.apache.lucene.analysis.icu.ICUNormalizer2CharFilter(reader);
        }
        @Override protected java.io.Reader initReaderForNormalization(String field, java.io.Reader reader) {
            return initReader(field, reader);
        }
        private org.apache.lucene.analysis.TokenStream fold(org.apache.lucene.analysis.TokenStream stream) {
            return new org.apache.lucene.analysis.icu.ICUTransformFilter(stream,
                com.ibm.icu.text.Transliterator.getInstance(SEARCH_TRANSFORM));
        }
        @Override protected TokenStreamComponents createComponents(String field) {
            var tokenizer = new org.apache.lucene.analysis.standard.StandardTokenizer();
            var bigrams = new org.apache.lucene.analysis.cjk.CJKBigramFilter(fold(tokenizer));
            return new TokenStreamComponents(tokenizer, new org.apache.lucene.analysis.StopFilter(
                bigrams, org.apache.lucene.analysis.cjk.CJKAnalyzer.getDefaultStopSet()));
        }
        @Override protected org.apache.lucene.analysis.TokenStream normalize(
            String field, org.apache.lucene.analysis.TokenStream stream) {
            return fold(stream);
        }
    }

    @Override public TextIndex open(Assembler assembler, Resource root, Mode mode) {
        TextIndex index = super.open(assembler, root, mode);
        if (!(index instanceof TextIndexLucene lucene))
            throw new IllegalStateException("Lucene text index is unavailable");
        return new FilteredGraphTextIndex(lucene);
    }

    /** Raw-update QA datasets cannot consume an exclusive-writer journal.
     * Their fault-injection reads retain a streaming audit with no top-N cap. */
    public static final class InventoryFunction extends org.apache.jena.sparql.function.FunctionBase {
        @Override public void checkBuild(String uri, org.apache.jena.sparql.expr.ExprList args) {
            if (!args.isEmpty()) throw new org.apache.jena.sparql.expr.ExprEvalException("inventory takes no arguments");
        }
        @Override public org.apache.jena.sparql.expr.NodeValue exec(java.util.List<org.apache.jena.sparql.expr.NodeValue> args) {
            throw new org.apache.jena.sparql.expr.ExprEvalException("inventory requires a dataset");
        }
        @Override protected org.apache.jena.sparql.expr.NodeValue exec(
            java.util.List<org.apache.jena.sparql.expr.NodeValue> args, org.apache.jena.sparql.function.FunctionEnv env) {
            try {
                return org.apache.jena.sparql.expr.NodeValue.makeInteger(SearchDeltaJournal.auditPopulation(
                    env.getDataset(), FilteredGraphTextIndex.functionIndex(env).lucene()));
            } catch (IllegalStateException unavailable) {
                throw new org.apache.jena.sparql.expr.ExprEvalException(unavailable);
            }
        }
    }
}
