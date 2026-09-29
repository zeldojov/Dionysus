ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Untitled document',
    ADD COLUMN IF NOT EXISTS slug TEXT;

UPDATE documents
SET slug = 'document-' || id::text
WHERE slug IS NULL;

ALTER TABLE documents
    ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS documents_slug_unique
    ON documents (slug);