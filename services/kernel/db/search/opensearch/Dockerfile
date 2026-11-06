FROM opensearchproject/opensearch:3.9.0@sha256:3b55f6b6249cfdb92b52ee59adc8a266203ba9ef9f5d82544fad6f1af2f3609e

# analysis-icu supplies nfkc_cf and Traditional-Simplified; Hiragana-Katakana for cjk_bigram_v2.
RUN /usr/share/opensearch/bin/opensearch-plugin install --batch analysis-icu \
 && /usr/share/opensearch/bin/opensearch-plugin list | grep -q '^analysis-icu'
