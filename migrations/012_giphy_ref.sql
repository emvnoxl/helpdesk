-- 012: a GIPHY GIF in the chat is stored as its id only (GIPHY's rules: no copies); kind = 'giphy'.
ALTER TABLE comments ADD COLUMN gif_ref TEXT;
