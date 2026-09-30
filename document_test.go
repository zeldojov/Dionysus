package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDocumentPayloadValidate(t *testing.T) {
	tests := []struct {
		name    string
		doc     documentPayload
		wantErr bool
	}{
		{
			name: "valid document",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph", Text: "Zdravo"}},
			},
		},
		{
			name:    "unsupported schema version",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion + 1, Blocks: []paragraphBlock{{ID: "p1", Type: "paragraph"}}},
			wantErr: true,
		},
		{
			name:    "empty blocks",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion},
			wantErr: true,
		},
		{
			name:    "missing block id",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion, Blocks: []paragraphBlock{{Type: "paragraph"}}},
			wantErr: true,
		},
		{
			name: "duplicate block ids",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph"}, {ID: "p1", Type: "paragraph"}},
			},
			wantErr: true,
		},
		{
			name:    "unsupported block type",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion, Blocks: []paragraphBlock{{ID: "h1", Type: "heading"}}},
			wantErr: true,
		},
		{
			name:    "newline in paragraph",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion, Blocks: []paragraphBlock{{ID: "p1", Type: "paragraph", Text: "Prvi\nDrugi"}}},
			wantErr: true,
		},
		{
			name:    "unsupported paragraph alignment",
			doc:     documentPayload{SchemaVersion: currentSchemaVersion, Blocks: []paragraphBlock{{ID: "p1", Type: "paragraph", Align: "diagonal"}}},
			wantErr: true,
		},
		{
			name: "too many blocks",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        make([]paragraphBlock, maxDocumentBlocks+1),
			},
			wantErr: true,
		},
		{
			name: "paragraph too long",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph", Text: strings.Repeat("a", maxParagraphRunes+1)}},
			},
			wantErr: true,
		},
		{
			name: "too many marks",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph", Text: "a", Marks: make([]paragraphMark, maxParagraphMarks+1)}},
			},
			wantErr: true,
		},
		{
			name: "too many links",
			doc: documentPayload{
				SchemaVersion: currentSchemaVersion,
				Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph", Text: "a", Links: make([]paragraphLink, maxParagraphLinks+1)}},
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.doc.validate()
			if test.wantErr && err == nil {
				t.Fatal("validate() returned nil, want error")
			}
			if !test.wantErr && err != nil {
				t.Fatalf("validate() returned error: %v", err)
			}
		})
	}
}

func TestMigrateDocument(t *testing.T) {
	document, err := migrateDocument(documentPayload{
		SchemaVersion: 1,
		Blocks:        []paragraphBlock{{ID: "p1", Type: "paragraph", Text: "Zdravo"}},
	})
	if err != nil {
		t.Fatalf("migrateDocument() returned error: %v", err)
	}
	if document.SchemaVersion != currentSchemaVersion {
		t.Fatalf("migrated schemaVersion = %d, want %d", document.SchemaVersion, currentSchemaVersion)
	}
	if err := document.validate(); err != nil {
		t.Fatalf("migrated document is invalid: %v", err)
	}
}

func TestLoadConfigDevelopmentDefaults(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	for _, name := range []string{"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_SSLMODE"} {
		t.Setenv(name, "")
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig() returned error: %v", err)
	}
	if cfg.dbHost != defaultDBHost || cfg.dbPort != defaultDBPort || cfg.dbUser != defaultDBUser || cfg.dbPassword != "dionysus" || cfg.dbName != defaultDBName || cfg.dbSSLMode != defaultSSLMode {
		t.Fatalf("unexpected development defaults: %+v", cfg)
	}
}

func TestLoadConfigProductionRequiresDatabaseEnvironment(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	for _, name := range []string{"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "DB_SSLMODE"} {
		t.Setenv(name, "")
	}

	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig() returned nil error for incomplete production configuration")
	}
}

func TestLoadConfigProductionForcesTLS(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("DB_HOST", "db.example.test")
	t.Setenv("DB_PORT", "5432")
	t.Setenv("DB_USER", "app")
	t.Setenv("DB_PASSWORD", "secret")
	t.Setenv("DB_NAME", "dionysus")
	t.Setenv("DB_SSLMODE", "disable")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig() returned error: %v", err)
	}
	if cfg.dbSSLMode != "require" {
		t.Fatalf("production sslmode = %q, want require", cfg.dbSSLMode)
	}
}

func TestLoadDotEnv(t *testing.T) {
	filename := filepath.Join(t.TempDir(), ".env")
	contents := "# comment\nDIONYSUS_TEST_PLAIN=value\nexport DIONYSUS_TEST_DOUBLE=\"hello world\"\nDIONYSUS_TEST_SINGLE='quoted value'\n"
	if err := os.WriteFile(filename, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DIONYSUS_TEST_PLAIN", "shell value")
	if err := loadDotEnv(filename); err != nil {
		t.Fatalf("loadDotEnv() returned error: %v", err)
	}
	if got := os.Getenv("DIONYSUS_TEST_PLAIN"); got != "shell value" {
		t.Fatalf("shell environment value = %q, want shell value", got)
	}
	if got := os.Getenv("DIONYSUS_TEST_DOUBLE"); got != "hello world" {
		t.Fatalf("double-quoted value = %q, want hello world", got)
	}
	if got := os.Getenv("DIONYSUS_TEST_SINGLE"); got != "quoted value" {
		t.Fatalf("single-quoted value = %q, want quoted value", got)
	}
}

func TestSlugify(t *testing.T) {
	tests := map[string]string{
		"Moj prvi dokument": "moj-prvi-dokument",
		"Čć Žž Šš Đđ":       "cc-zz-ss-dd",
		"Наслов документа":  "naslov-dokumenta",
	}

	for input, want := range tests {
		if got := slugify(input); got != want {
			t.Errorf("slugify(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestDocumentTitleLimit(t *testing.T) {
	_, _, err := (createDocumentRequest{Title: strings.Repeat("a", maxDocumentTitleRunes+1)}).normalized()
	if err == nil {
		t.Fatal("normalized() returned nil error for an oversized title")
	}
}

func TestDocumentAPI(t *testing.T) {
	if os.Getenv("APP_ENV") == "production" {
		t.Skip("database integration test uses local development defaults")
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	db, err := pgxpool.New(context.Background(), cfg.dbConnectionString())
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Ping(context.Background()); err != nil {
		t.Skipf("database unavailable: %v", err)
	}

	app := &server{db: db}
	testServer := httptest.NewServer(app.routes())
	t.Cleanup(testServer.Close)

	created := createTestDocument(t, testServer)
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), "DELETE FROM documents WHERE id = $1", created.ID)
	})

	other := createTestDocumentWithTitle(t, testServer, "Drugi test dokument")
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), "DELETE FROM documents WHERE id = $1", other.ID)
	})

	duplicate := createTestDocumentWithTitle(t, testServer, created.Title)
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), "DELETE FROM documents WHERE id = $1", duplicate.ID)
	})
	if duplicate.Title == created.Title || duplicate.Slug != slugify(duplicate.Title) {
		t.Fatalf("duplicate document title/slug do not correspond: title=%q slug=%q", duplicate.Title, duplicate.Slug)
	}

	listResponse, err := http.Get(testServer.URL + "/documents")
	if err != nil {
		t.Fatal(err)
	}
	defer listResponse.Body.Close()
	if listResponse.StatusCode != http.StatusOK {
		t.Fatalf("GET /documents status = %d, want %d", listResponse.StatusCode, http.StatusOK)
	}
	var listed []documentSummary
	if err := json.NewDecoder(listResponse.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if !containsDocumentSummary(listed, created.ID) || !containsDocumentSummary(listed, other.ID) {
		t.Fatalf("document list does not contain created documents: %+v", listed)
	}

	getResponse, err := http.Get(testServer.URL + "/documents/" + created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer getResponse.Body.Close()
	if getResponse.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want %d", getResponse.StatusCode, http.StatusOK)
	}

	var fetched documentResponse
	if err := json.NewDecoder(getResponse.Body).Decode(&fetched); err != nil {
		t.Fatal(err)
	}
	if fetched.ID != created.ID {
		t.Fatalf("GET id = %q, want %q", fetched.ID, created.ID)
	}

	slugResponse, err := http.Get(testServer.URL + "/documents/" + created.Slug)
	if err != nil {
		t.Fatal(err)
	}
	slugResponse.Body.Close()
	if slugResponse.StatusCode != http.StatusOK {
		t.Fatalf("GET by slug status = %d, want %d", slugResponse.StatusCode, http.StatusOK)
	}

	updatedContent := created.Content
	updatedContent.Blocks[0].Text = "Zdravo"
	updateBody := updateBlocksRequest{Blocks: []paragraphBlock{updatedContent.Blocks[0]}, Revision: created.Revision}
	updateJSON, err := json.Marshal(updateBody)
	if err != nil {
		t.Fatal(err)
	}
	updateRequest, err := http.NewRequest(http.MethodPatch, testServer.URL+"/documents/"+created.ID+"/blocks", bytes.NewReader(updateJSON))
	if err != nil {
		t.Fatal(err)
	}
	updateRequest.Header.Set("Content-Type", "application/json")
	updateResponse, err := http.DefaultClient.Do(updateRequest)
	if err != nil {
		t.Fatal(err)
	}
	updateResponse.Body.Close()
	if updateResponse.StatusCode != http.StatusOK {
		t.Fatalf("block PATCH status = %d, want %d", updateResponse.StatusCode, http.StatusOK)
	}

	renameBody, err := json.Marshal(renameDocumentRequest{Title: "Novi test dokument", Revision: 2})
	if err != nil {
		t.Fatal(err)
	}
	renameRequest, err := http.NewRequest(http.MethodPatch, testServer.URL+"/documents/"+created.Slug, bytes.NewReader(renameBody))
	if err != nil {
		t.Fatal(err)
	}
	renameRequest.Header.Set("Content-Type", "application/json")
	renameResponse, err := http.DefaultClient.Do(renameRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer renameResponse.Body.Close()
	if renameResponse.StatusCode != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d", renameResponse.StatusCode, http.StatusOK)
	}

	var renamed documentResponse
	if err := json.NewDecoder(renameResponse.Body).Decode(&renamed); err != nil {
		t.Fatal(err)
	}
	if renamed.Title != "Novi test dokument" || renamed.Slug != "novi-test-dokument" || renamed.Revision != 3 {
		t.Fatalf("unexpected renamed document: %+v", renamed)
	}

	newSlugResponse, err := http.Get(testServer.URL + "/documents/" + renamed.Slug)
	if err != nil {
		t.Fatal(err)
	}
	newSlugResponse.Body.Close()
	if newSlugResponse.StatusCode != http.StatusOK {
		t.Fatalf("GET renamed slug status = %d, want %d", newSlugResponse.StatusCode, http.StatusOK)
	}

	duplicateRenameBody, err := json.Marshal(renameDocumentRequest{Title: other.Title, Revision: renamed.Revision})
	if err != nil {
		t.Fatal(err)
	}
	duplicateRenameRequest, err := http.NewRequest(http.MethodPatch, testServer.URL+"/documents/"+renamed.Slug, bytes.NewReader(duplicateRenameBody))
	if err != nil {
		t.Fatal(err)
	}
	duplicateRenameRequest.Header.Set("Content-Type", "application/json")
	duplicateRenameResponse, err := http.DefaultClient.Do(duplicateRenameRequest)
	if err != nil {
		t.Fatal(err)
	}
	duplicateRenameResponse.Body.Close()
	if duplicateRenameResponse.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate rename status = %d, want %d", duplicateRenameResponse.StatusCode, http.StatusConflict)
	}

	staleRequest, err := http.NewRequest(http.MethodPatch, testServer.URL+"/documents/"+created.ID+"/blocks", bytes.NewReader(updateJSON))
	if err != nil {
		t.Fatal(err)
	}
	staleRequest.Header.Set("Content-Type", "application/json")
	staleResponse, err := http.DefaultClient.Do(staleRequest)
	if err != nil {
		t.Fatal(err)
	}
	staleResponse.Body.Close()
	if staleResponse.StatusCode != http.StatusConflict {
		t.Fatalf("stale block PATCH status = %d, want %d", staleResponse.StatusCode, http.StatusConflict)
	}

	staleDeleteRequest, err := http.NewRequest(http.MethodDelete, testServer.URL+"/documents/"+renamed.Slug+"?revision=2", nil)
	if err != nil {
		t.Fatal(err)
	}
	staleDeleteResponse, err := http.DefaultClient.Do(staleDeleteRequest)
	if err != nil {
		t.Fatal(err)
	}
	staleDeleteResponse.Body.Close()
	if staleDeleteResponse.StatusCode != http.StatusConflict {
		t.Fatalf("stale DELETE status = %d, want %d", staleDeleteResponse.StatusCode, http.StatusConflict)
	}

	deleteRequest, err := http.NewRequest(http.MethodDelete, testServer.URL+"/documents/"+renamed.Slug+"?revision=3", nil)
	if err != nil {
		t.Fatal(err)
	}
	deleteResponse, err := http.DefaultClient.Do(deleteRequest)
	if err != nil {
		t.Fatal(err)
	}
	deleteResponse.Body.Close()
	if deleteResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status = %d, want %d", deleteResponse.StatusCode, http.StatusNoContent)
	}

	deletedGetResponse, err := http.Get(testServer.URL + "/documents/" + renamed.Slug)
	if err != nil {
		t.Fatal(err)
	}
	deletedGetResponse.Body.Close()
	if deletedGetResponse.StatusCode != http.StatusNotFound {
		t.Fatalf("GET deleted document status = %d, want %d", deletedGetResponse.StatusCode, http.StatusNotFound)
	}
}

func containsDocumentSummary(documents []documentSummary, id string) bool {
	for _, document := range documents {
		if document.ID == id {
			return document.Title != "" && document.Slug != ""
		}
	}
	return false
}

func createTestDocument(t *testing.T, testServer *httptest.Server) documentResponse {
	t.Helper()
	return createTestDocumentWithTitle(t, testServer, "Moj test dokument")
}

func createTestDocumentWithTitle(t *testing.T, testServer *httptest.Server, title string) documentResponse {
	t.Helper()
	requestJSON, err := json.Marshal(createDocumentRequest{Title: title})
	if err != nil {
		t.Fatal(err)
	}
	requestBody := bytes.NewReader(requestJSON)
	response, err := http.Post(testServer.URL+"/documents", "application/json", requestBody)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d", response.StatusCode, http.StatusCreated)
	}

	var document documentResponse
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatal(err)
	}
	if document.ID == "" || document.Slug == "" || document.Revision != 1 {
		t.Fatalf("unexpected created document: %+v", document)
	}
	return document
}
