CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content JSONB NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT documents_content_is_object
        CHECK (jsonb_typeof(content) = 'object'),
    CONSTRAINT documents_schema_version_positive
        CHECK (schema_version > 0),
    CONSTRAINT documents_revision_positive
        CHECK (revision > 0)
);