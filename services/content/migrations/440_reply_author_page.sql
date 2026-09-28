-- A person's public posts and comments page seeks by author and creation time.
CREATE INDEX reply_author_page ON content.reply (author, created_at DESC, id DESC)
  WHERE origin_realm IS NOT NULL;
