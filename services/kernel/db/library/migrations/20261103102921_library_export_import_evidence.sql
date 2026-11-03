-- migrate:up
-- Installed import evidence joins the same owner revision boundary, without exporting review capabilities.
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.bangumi_upload
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.bangumi_upload_row
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();
CREATE TRIGGER export_owner_fence AFTER INSERT OR UPDATE OR DELETE ON library.list_import_mal
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

-- migrate:down
DROP TRIGGER export_owner_fence ON library.list_import_mal;
DROP TRIGGER export_owner_fence ON library.bangumi_upload_row;
DROP TRIGGER export_owner_fence ON library.bangumi_upload;
