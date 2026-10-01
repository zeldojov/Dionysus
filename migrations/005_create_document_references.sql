CREATE TABLE IF NOT EXISTS document_references (
    id BIGSERIAL PRIMARY KEY,
    source_document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source_block_id TEXT NOT NULL,
    source_offset INTEGER NOT NULL,
    target_document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_block_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_references_source_offset_nonnegative CHECK (source_offset >= 0)
);

CREATE INDEX IF NOT EXISTS document_references_target_idx
    ON document_references (target_document_id, target_block_id);

CREATE INDEX IF NOT EXISTS document_references_source_idx
    ON document_references (source_document_id, source_block_id);

CREATE UNIQUE INDEX IF NOT EXISTS document_references_identity_idx
    ON document_references (
        source_document_id, source_block_id, source_offset, target_document_id, target_block_id
    );

INSERT INTO document_references (
    source_document_id, source_block_id, source_offset, target_document_id, target_block_id
)
SELECT
    source.document_id,
    source.block_id,
    (link->>'start')::INTEGER,
    (link->>'documentId')::UUID,
    link->>'blockId'
FROM document_blocks AS source
CROSS JOIN LATERAL jsonb_array_elements(CASE
    WHEN jsonb_typeof(source.data->'links') = 'array' THEN source.data->'links'
    ELSE '[]'::jsonb
END) AS link
JOIN documents AS target ON target.id = (link->>'documentId')::UUID
WHERE link->>'type' = 'reference' OR link->>'reference' = 'true'
ON CONFLICT (source_document_id, source_block_id, source_offset, target_document_id, target_block_id) DO NOTHING;