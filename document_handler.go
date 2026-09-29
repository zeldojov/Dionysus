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

func (s *server) createDocument(w http.ResponseWriter, r *http.Request) {
	request := createDocumentRequest{}
	if r.ContentLength > 0 {
		if err := decodeJSON(w, r, &request); err != nil {
			writeError(w, http.StatusBadRequest, err)
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

	contentJSON, err := json.Marshal(content)
	if err != nil {
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

		document, err = s.insertDocument(r.Context(), candidateTitle, candidateSlug, contentJSON, content.SchemaVersion)
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
	`)
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

func (s *server) updateDocument(w http.ResponseWriter, r *http.Request) {
	var request updateDocumentRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if request.Revision < 1 {
		writeError(w, http.StatusBadRequest, errors.New("revision must be positive"))
		return
	}
	content, err := migrateDocument(request.Content)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := content.validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	contentJSON, err := json.Marshal(content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	document, err := s.replaceDocument(
		r.Context(),
		r.PathValue("identifier"),
		contentJSON,
		content.SchemaVersion,
		request.Revision,
	)
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
		writeError(w, http.StatusBadRequest, err)
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

func (s *server) insertDocument(ctx context.Context, title, slug string, content []byte, schemaVersion int) (documentResponse, error) {
	var document documentResponse
	var contentJSON []byte
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		INSERT INTO documents (title, slug, content, schema_version)
		VALUES ($1, $2, $3, $4)
		RETURNING id, title, slug, content, schema_version, revision, created_at, updated_at
	`, title, slug, content, schemaVersion).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&contentJSON,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	if err := json.Unmarshal(contentJSON, &document.Content); err != nil {
		return documentResponse{}, err
	}
	document.Content, err = migrateDocument(document.Content)
	if err != nil {
		return documentResponse{}, err
	}
	document.SchemaVersion = document.Content.SchemaVersion
	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
}

func (s *server) findDocument(ctx context.Context, identifier string) (documentResponse, error) {
	var document documentResponse
	var contentJSON []byte
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		SELECT id, title, slug, content, schema_version, revision, created_at, updated_at
		FROM documents
		WHERE slug = $1 OR id::text = $1
	`, identifier).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&contentJSON,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	if err := json.Unmarshal(contentJSON, &document.Content); err != nil {
		return documentResponse{}, err
	}
	document.Content, err = migrateDocument(document.Content)
	if err != nil {
		return documentResponse{}, err
	}
	document.SchemaVersion = document.Content.SchemaVersion
	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
}

func (s *server) replaceDocument(ctx context.Context, id string, content []byte, schemaVersion int, revision int64) (documentResponse, error) {
	var document documentResponse
	var contentJSON []byte
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		UPDATE documents
		SET content = $1,
		    schema_version = $2,
		    revision = revision + 1,
		    updated_at = now()
		WHERE (slug = $3 OR id::text = $3) AND revision = $4
		RETURNING id, title, slug, content, schema_version, revision, created_at, updated_at
	`, content, schemaVersion, id, revision).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&contentJSON,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	if err := json.Unmarshal(contentJSON, &document.Content); err != nil {
		return documentResponse{}, err
	}
	document.Content, err = migrateDocument(document.Content)
	if err != nil {
		return documentResponse{}, err
	}
	document.SchemaVersion = document.Content.SchemaVersion
	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
}

func (s *server) renameDocumentRecord(ctx context.Context, identifier, title, slug string, revision int64) (documentResponse, error) {
	var document documentResponse
	var contentJSON []byte
	var createdAt, updatedAt time.Time

	err := s.db.QueryRow(ctx, `
		UPDATE documents
		SET title = $1,
		    slug = $2,
		    revision = revision + 1,
		    updated_at = now()
		WHERE (slug = $3 OR id::text = $3) AND revision = $4
		RETURNING id, title, slug, content, schema_version, revision, created_at, updated_at
	`, title, slug, identifier, revision).Scan(
		&document.ID,
		&document.Title,
		&document.Slug,
		&contentJSON,
		&document.SchemaVersion,
		&document.Revision,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return documentResponse{}, err
	}

	if err := json.Unmarshal(contentJSON, &document.Content); err != nil {
		return documentResponse{}, err
	}
	document.CreatedAt = createdAt
	document.UpdatedAt = updatedAt
	return document, nil
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

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func isUniqueViolation(err error) bool {
	var pgError *pgconn.PgError
	return errors.As(err, &pgError) && pgError.Code == "23505"
}
