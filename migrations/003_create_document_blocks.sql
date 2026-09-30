CREATE TABLE IF NOT EXISTS document_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    block_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    block_type TEXT NOT NULL DEFAULT 'paragraph',
    text TEXT,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(text, ''))
    ) STORED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT document_blocks_document_block_unique UNIQUE (document_id, block_id),
    CONSTRAINT document_blocks_document_position_unique UNIQUE (document_id, position),
    CONSTRAINT document_blocks_data_is_object CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX IF NOT EXISTS document_blocks_order_idx
    ON document_blocks (document_id, position);

CREATE INDEX IF NOT EXISTS document_blocks_search_idx
    ON document_blocks USING GIN (search_vector);

INSERT INTO document_blocks (document_id, block_id, position, block_type, text, data)
SELECT
    d.id,
    block->>'id',
    blocks.position - 1,
    coalesce(block->>'type', 'paragraph'),
    block->>'text',
    jsonb_build_object(
        'marks', coalesce(block->'marks', '[]'::jsonb),
        'links', coalesce(block->'links', '[]'::jsonb),
        'align', coalesce(block->>'align', 'left')
    )
FROM documents AS d
CROSS JOIN LATERAL jsonb_array_elements(d.content->'blocks') WITH ORDINALITY AS blocks(block, position)
WHERE jsonb_typeof(d.content->'blocks') = 'array'
ON CONFLICT (document_id, block_id) DO NOTHING;
