package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var errReferencedParagraphLocked = errors.New("referenced paragraph is locked")

func (s *server) createDocument(w http.ResponseWriter, r *http.Request) {
	request := createDocumentRequest{}
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &request); err != nil {
			writeDecodeError(w, err)
			return
		}
	}
	baseTitle, _, err := request.normalized()
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	content := emptyDocument()
	if err := content.validate(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	var document documentResponse
	for suffix := 1; suffix <= 1000; suffix++ {
		candidateTitle := baseTitle
		if suffix > 1 {
			candidateTitle = fmt.Sprintf("%s %d", baseTitle, suffix)
		}
		candidateTitle, candidateSlug, err := (createDocumentRequest{Title: candidateTitle}).normalized()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}

		document, err = s.insertDocument(r.Context(), candidateTitle, candidateSlug, content.SchemaVersion)
		if !isUniqueViolation(err) {
			break
		}
	}
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, errors.New("could not generate a unique document slug"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	document.Content = content
	if err := s.syncDocumentBlocks(r.Context(), document.ID, document.Content.Blocks, true); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	document, err = s.findDocument(r.Context(), document.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusCreated, document)
}

func (s *server) getDocument(w http.ResponseWriter, r *http.Request) {
	document, err := s.findDocument(r.Context(), r.PathValue("identifier"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, document)
}

func (s *server) listDocuments(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `
		SELECT id, title, slug, revision, updated_at
		FROM documents
		ORDER BY updated_at DESC
		LIMIT $1
	`, maxDocumentsPerListPage)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	documents := make([]documentSummary, 0)
	for rows.Next() {
		var document documentSummary
		if err := rows.Scan(&document.ID, &document.Title, &document.Slug, &document.Revision, &document.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		documents = append(documents, document)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, documents)
}

func (s *server) listIncomingReferences(w http.ResponseWriter, r *http.Request) {
	document, err := s.findDocument(r.Context(), r.PathValue("identifier"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT r.id, r.source_document_id, d.title, d.slug, r.source_block_id
		FROM document_references AS r
		JOIN documents AS d ON d.id = r.source_document_id
		WHERE r.target_document_id = $1 AND r.target_block_id = $2
		ORDER BY d.title, r.source_block_id, r.id
	`, document.ID, r.PathValue("blockID"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	defer rows.Close()

	references := []incomingReference{}
	for rows.Next() {
		var reference incomingReference
		if err := rows.Scan(&reference.ID, &reference.SourceDocumentID, &reference.SourceDocument, &reference.SourceSlug, &reference.SourceBlockID); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		references = append(references, reference)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, references)
}

func (s *server) removeIncomingReference(w http.ResponseWriter, r *http.Request) {
	referenceID, err := strconv.ParseInt(r.PathValue("referenceID"), 10, 64)
	if err != nil || referenceID < 1 {
		writeError(w, http.StatusBadRequest, errors.New("reference id must be positive"))
		return
	}
	document, err := s.findDocument(r.Context(), r.PathValue("identifier"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.deleteIncomingReference(r.Context(), document.ID, r.PathValue("blockID"), referenceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, errors.New("incoming reference not found"))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *server) deleteIncomingReference(ctx context.Context, targetDocumentID, targetBlockID string, referenceID int64) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var sourceDocumentID, sourceBlockID string
	var sourceOffset int
	err = tx.QueryRow(ctx, `
		SELECT source_document_id, source_block_id, source_offset
		FROM document_references
		WHERE id = $1 AND target_document_id = $2 AND target_block_id = $3
		FOR UPDATE
	`, referenceID, targetDocumentID, targetBlockID).Scan(&sourceDocumentID, &sourceBlockID, &sourceOffset)
	if err != nil {
		return err
	}

	var dataJSON []byte
	if err := tx.QueryRow(ctx, `
		SELECT data FROM document_blocks
		WHERE document_id = $1 AND block_id = $2
		FOR UPDATE
	`, sourceDocumentID, sourceBlockID).Scan(&dataJSON); err != nil {
		return err
	}
	var metadata struct {
		Marks      []paragraphMark      `json:"marks"`
		Links      []paragraphLink      `json:"links"`
		References []paragraphReference `json:"references"`
		Align      string               `json:"align"`
	}
	if err := json.Unmarshal(dataJSON, &metadata); err != nil {
		return err
	}
	references := metadata.References[:0]
	for _, reference := range metadata.References {
		isRemovedReference := reference.Start == sourceOffset &&
			reference.DocumentID == targetDocumentID &&
			reference.TargetBlockID == targetBlockID
		if !isRemovedReference {
			references = append(references, reference)
		}
	}
	metadata.References = references
	updatedData, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE document_blocks SET data = $1, updated_at = now()
		WHERE document_id = $2 AND block_id = $3
	`, updatedData, sourceDocumentID, sourceBlockID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE documents SET revision = revision + 1, updated_at = now() WHERE id = $1`, sourceDocumentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_references WHERE id = $1`, referenceID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *server) updateBlocks(w http.ResponseWriter, r *http.Request) {
	var request updateBlocksRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeDecodeError(w, err)
		return
	}
	if request.Revision < 1 {
		writeError(w, http.StatusBadRequest, errors.New("revision must be positive"))
		return
	}

	document, err := s.findDocument(r.Context(), r.PathValue("identifier"))
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, errors.New("document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if document.Revision != request.Revision {
		writeError(w, http.StatusConflict, errors.New("document revision conflict"))
		return
	}

	if request.ReplaceAll {
		document.Content.Blocks = request.Blocks
	} else {
		blocksByID := make(map[string]int, len(document.Content.Blocks))
		for index, block := range document.Content.Blocks {
			blocksByID[block.ID] = index
		}
		for _, block := range request.Blocks {
			index, exists := blocksByID[block.ID]
			if !exists {
				writeError(w, http.StatusBadRequest, fmt.Errorf("unknown block id: %s", block.ID))
				return
			}
			document.Content.Blocks[index] = block
		}
	}

	if err := document.Content.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	saved, err := s.replaceBlocks(r.Context(), r.PathValue("identifier"), document.Content.SchemaVersion, document.Content.Blocks, request.ReplaceAll, request.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, errors.New("document revision conflict or document not found"))
		return
	}
	if errors.Is(err, errReferencedParagraphLocked) {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (s *server) syncDocumentBlocks(ctx context.Context, documentID string, blocks []paragraphBlock, replaceAll bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := syncDocumentBlocksTx(ctx, tx, documentID, blocks, replaceAll); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func syncDocumentBlocksTx(ctx context.Context, tx pgx.Tx, documentID string, blocks []paragraphBlock, replaceAll bool) error {
	if replaceAll {
		if _, err := tx.Exec(ctx, `DELETE FROM document_blocks WHERE document_id = $1`, documentID); err != nil {
			return err
		}
	}
	for position, block := range blocks {
		data, err := json.Marshal(map[string]any{
			"marks":      block.Marks,
			"links":      block.Links,
			"references": block.References,
			"align":      block.Align,
		})
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_blocks (document_id, block_id, position, block_type, text, data)
			VALUES ($1, $2, $3, $4, $5, $6)
			ON CONFLICT (document_id, block_id) DO UPDATE SET
				position = EXCLUDED.position,
				block_type = EXCLUDED.block_type,
				text = EXCLUDED.text,
				data = EXCLUDED.data,
				updated_at = now()
		`, documentID, block.ID, position, block.Type, block.Text, data); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_references WHERE source_document_id = $1`, documentID); err != nil {
		return err
	}
	for _, block := range blocks {
		for _, reference := range block.References {
			if _, err := tx.Exec(ctx, `
				INSERT INTO document_references (
					source_document_id, source_block_id, source_offset, target_document_id, target_block_id
				)
				VALUES ($1, $2, $3, $4, $5)
			`, documentID, block.ID, reference.Start, reference.DocumentID, reference.TargetBlockID); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateReferencedBlocksTx(ctx context.Context, tx pgx.Tx, documentID string, blocks []paragraphBlock) error {
	rows, err := tx.Query(ctx, `
		SELECT block_id, text
		FROM document_blocks
		WHERE document_id = $1
		  AND EXISTS (
			SELECT 1
			FROM document_references
			WHERE target_document_id = $1 AND target_block_id = document_blocks.block_id
		  )
	`, documentID)
	if err != nil {
		return err
	}
	defer rows.Close()

	proposed := make(map[string]paragraphBlock, len(blocks))
	for _, block := range blocks {
		proposed[block.ID] = block
	}
	for rows.Next() {
		var blockID, text string
		if err := rows.Scan(&blockID, &text); err != nil {
			return err
		}
		block, exists := proposed[blockID]
		if !exists {
			return fmt.Errorf("%w: paragraph %s cannot be removed", errReferencedParagraphLocked, blockID)
		}
		if block.Type != "paragraph" || block.Text != text {
			return fmt.Errorf("%w: paragraph %s text cannot be changed", errReferencedParagraphLocked, blockID)
		}
	}
	return rows.Err()
}

func (s *server) replaceBlocks(ctx context.Context, identifier string, schemaVersion int, blocks []paragraphBlock, replaceAll bool, revision int64) (documentResponse, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return documentResponse{}, err
	}
	defer tx.Rollback(ctx)

	var documentID string
	err = tx.QueryRow(ctx, `
		UPDATE documents
		SET schema_version = $1,
		    revision = revision + 1,
		    updated_at = now()
		WHERE (slug = $2 OR id::text = $2) AND revision = $3
		RETURNING id
	`, schemaVersion, identifier, revision).Scan(&documentID)
	if err != nil {
		return documentResponse{}, err
	}
	if err := validateReferencedBlocksTx(ctx, tx, documentID, blocks); err != nil {
		return documentResponse{}, err
	}
	if err := syncDocumentBlocksTx(ctx, tx, documentID, blocks, replaceAll); err != nil {
		return documentResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return documentResponse{}, err
	}
	return s.findDocument(ctx, documentID)
}

func (s *server) deleteDocument(w http.ResponseWriter, r *http.Request) {
	revision, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
	if err != nil || revision < 1 {
		writeError(w, http.StatusBadRequest, errors.New("revision must be positive"))
		return
	}

	err = s.removeDocument(r.Context(), r.PathValue("identifier"), revision)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, errors.New("document revision conflict or document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *server) renameDocument(w http.ResponseWriter, r *http.Request) {
	var request renameDocumentRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeDecodeError(w, err)
		return
	}
	if request.Revision < 1 {
		writeError(w, http.StatusBadRequest, errors.New("revision must be positive"))
		return
	}

	title, slug, err := (createDocumentRequest{Title: request.Title}).normalized()
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	document, err := s.renameDocumentRecord(
		r.Context(),
		r.PathValue("identifier"),
		title,
		slug,
		request.Revision,
	)
	if isUniqueViolation(err) {
		writeError(w, http.StatusConflict, errors.New("document slug already exists"))
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusConflict, errors.New("document revision conflict or document not found"))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	writeJSON(w, http.StatusOK, document)
}

func (s *server) insertDocument(ctx context.Context, title, slug string, schemaVersion int) (documentResponse, error) {
	var document documentResponse
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		INSERT INTO documents (title, slug, schema_version)
		VALUES ($1, $2, $3)
		RETURNING id, title, slug, schema_version, revision, created_at, updated_at
	`, title, slug, schemaVersion).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
}

func (s *server) loadDocumentBlocks(ctx context.Context, documentID string) ([]paragraphBlock, error) {
	rows, err := s.db.Query(ctx, `
		SELECT block_id, block_type, text, data
		FROM document_blocks
		WHERE document_id = $1
		ORDER BY position
	`, documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	blocks := make([]paragraphBlock, 0)
	for rows.Next() {
		var block paragraphBlock
		var dataJSON []byte
		if err := rows.Scan(&block.ID, &block.Type, &block.Text, &dataJSON); err != nil {
			return nil, err
		}
		var metadata struct {
			Marks      []paragraphMark      `json:"marks"`
			Links      []paragraphLink      `json:"links"`
			References []paragraphReference `json:"references"`
			Align      string               `json:"align"`
		}
		if err := json.Unmarshal(dataJSON, &metadata); err != nil {
			return nil, err
		}
		block.Marks = metadata.Marks
		block.Links = metadata.Links
		block.References = metadata.References
		block.Align = metadata.Align
		var legacy struct {
			Links []struct {
				Start         int    `json:"start"`
				End           int    `json:"end"`
				URL           string `json:"url"`
				DocumentID    string `json:"documentId"`
				TargetBlockID string `json:"blockId"`
				Type          string `json:"type"`
				Reference     bool   `json:"reference"`
			} `json:"links"`
		}
		if err := json.Unmarshal(dataJSON, &legacy); err != nil {
			return nil, err
		}
		legacyHasReferences := false
		for _, link := range legacy.Links {
			if link.Type == "reference" || link.Reference || link.DocumentID != "" || link.TargetBlockID != "" {
				legacyHasReferences = true
				break
			}
		}
		if legacyHasReferences {
			block.Links = nil
			block.References = nil
			for _, link := range legacy.Links {
				if link.Type == "reference" || link.Reference || link.DocumentID != "" || link.TargetBlockID != "" {
					block.References = append(block.References, paragraphReference{
						Start: link.Start, End: link.End, DocumentID: link.DocumentID, TargetBlockID: link.TargetBlockID,
					})
				} else if link.URL != "" {
					block.Links = append(block.Links, paragraphLink{Start: link.Start, End: link.End, URL: link.URL})
				}
			}
		}
		blocks = append(blocks, block)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return blocks, nil
}

func (s *server) loadReferencedBlockIDs(ctx context.Context, documentID string) ([]string, error) {
	rows, err := s.db.Query(ctx, `
		SELECT DISTINCT target_block_id
		FROM document_references
		WHERE target_document_id = $1
		ORDER BY target_block_id
	`, documentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	blockIDs := []string{}
	for rows.Next() {
		var blockID string
		if err := rows.Scan(&blockID); err != nil {
			return nil, err
		}
		blockIDs = append(blockIDs, blockID)
	}
	return blockIDs, rows.Err()
}

func (s *server) findDocument(ctx context.Context, identifier string) (documentResponse, error) {
	var document documentResponse
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		SELECT id, title, slug, schema_version, revision, created_at, updated_at
		FROM documents
		WHERE slug = $1 OR id::text = $1
	`, identifier).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	blocks, err := s.loadDocumentBlocks(ctx, document.ID)
	if err != nil {
		return documentResponse{}, err
	}
	referencedBlockIDs, err := s.loadReferencedBlockIDs(ctx, document.ID)
	if err != nil {
		return documentResponse{}, err
	}
	document.Content = documentPayload{
		SchemaVersion: currentSchemaVersion,
		Blocks:        blocks,
	}
	document.SchemaVersion = currentSchemaVersion
	document.ReferencedBlockIDs = referencedBlockIDs
	if err := document.Content.validate(); err != nil {
		return documentResponse{}, err
	}
	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
}

func (s *server) renameDocumentRecord(ctx context.Context, identifier, title, slug string, revision int64) (documentResponse, error) {
	var document documentResponse

	err := s.db.QueryRow(ctx, `
		UPDATE documents
		SET title = $1,
		    slug = $2,
		    revision = revision + 1,
		    updated_at = now()
		WHERE (slug = $3 OR id::text = $3) AND revision = $4
		RETURNING id
	`, title, slug, identifier, revision).Scan(&document.ID)
	if err != nil {
		return documentResponse{}, err
	}
	return s.findDocument(ctx, document.ID)
}

func (s *server) removeDocument(ctx context.Context, identifier string, revision int64) error {
	var deletedID string
	err := s.db.QueryRow(ctx, `
		DELETE FROM documents
		WHERE (slug = $1 OR id::text = $1) AND revision = $2
		RETURNING id
	`, identifier, revision).Scan(&deletedID)
	return err
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}

	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("request body must contain one JSON value")
	}
	return nil
}

func writeDecodeError(w http.ResponseWriter, err error) {
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		writeError(w, http.StatusRequestEntityTooLarge, errors.New("request body exceeds the 1 MiB limit"))
		return
	}
	writeError(w, http.StatusBadRequest, err)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func isUniqueViolation(err error) bool {
	var pgError *pgconn.PgError
	return errors.As(err, &pgError) && pgError.Code == "23505"
}
