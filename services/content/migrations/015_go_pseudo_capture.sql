ALTER TABLE pkg.go_proxy_capture
  ADD COLUMN capture_profile text NOT NULL DEFAULT 'go-module-proxy-capture-v1'
    CHECK (capture_profile IN ('go-module-proxy-capture-v1',
      'go-module-proxy-capture-v2'));

ALTER TABLE pkg.go_proxy_capture
  ADD CONSTRAINT go_proxy_capture_list_profile CHECK (
    (capture_profile = 'go-module-proxy-capture-v1' AND octet_length(list_bytes) > 0)
    OR (capture_profile = 'go-module-proxy-capture-v2' AND octet_length(list_bytes) = 0));
