# Dionysus

Dionysus is a JSON-driven WYSIWYG editor built with Go, PostgreSQL, Go templates,
and vanilla JavaScript. The document JSON is canonical; the HTML editor is only
a projection of that JSON.

## Features

- Flat document model with paragraph blocks only
- PostgreSQL JSONB document storage
- Stable UUIDs and unique title-derived slugs
- Create, open, update, rename, and delete documents
- Debounced autosave with visible save states
- Revision checks with local conflict recovery
- Undo and redo with keyboard shortcuts and toolbar buttons
- No Markdown import or editor format conversion

## Requirements

- Go 1.27 or newer
- PostgreSQL 18 or a compatible PostgreSQL version
- `psql` for applying migrations

## Local setup

Create the application database and user:

```sql
CREATE USER dionysus_app WITH PASSWORD 'dionysus';
CREATE DATABASE dionysus OWNER dionysus_app;
```

Apply migrations in order:

```bash
psql "postgres://dionysus_app:dionysus@127.0.0.1:5432/dionysus?sslmode=disable" \
	-f migrations/001_create_documents.sql
psql "postgres://dionysus_app:dionysus@127.0.0.1:5432/dionysus?sslmode=disable" \
	-f migrations/002_add_document_title_slug.sql
```

The local database connection defaults are defined in `main.go`. The HTTP
address can be changed with `HTTP_ADDR`; the default is `:8080`.

Start the application:

```bash
go run .
```

Open <http://localhost:8080> to view the document list.

Run tests:

```bash
go test ./...
```

Install and run browser tests:

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

The Playwright suite starts the Go server automatically and covers the document
editing lifecycle, autosave state, undo/redo, rename/delete, and two-page
revision conflict recovery. On Linux, Playwright may also require browser
system dependencies; use `npx playwright install --with-deps chromium` when
you have permission to install them.

## Document model

Documents use a flat list of blocks. Nested blocks and block type changes are
not supported yet.

```json
{
	"schemaVersion": 1,
	"blocks": [
		{
			"id": "paragraph-example",
			"type": "paragraph",
			"text": "Hello from Dionysus",
			"align": "left"
		}
	]
}
```

Paragraph alignment is optional and accepts `left`, `center`, `right`, or
`justify`. Missing alignment defaults to `left`. Justified paragraphs may use
CSS hyphenation and line wrapping for display; the stored paragraph text is not
modified.

Each paragraph is a single line. The server validates schema version, block
IDs, block type, and paragraph text before saving.

Paragraph links are stored as text ranges and target a document UUID plus a
paragraph block ID:

```json
{
	"id": "paragraph-source",
	"type": "paragraph",
	"text": "Open the target paragraph",
	"links": [
		{
			"start": 0,
			"end": 4,
			"documentId": "document-uuid",
			"blockId": "paragraph-target"
		}
	]
}
```

The editor renders each block as `block-{blockId}` and links use the form
`/documents/{documentUUID}#block-{blockId}`. A link can target a paragraph in
the same document or another document.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/` | Documents list page |
| `GET` | `/documents` | Document summaries as JSON |
| `POST` | `/documents` | Create a document |
| `GET` | `/documents/{identifier}` | Read by slug or UUID |
| `PUT` | `/documents/{identifier}` | Replace JSON content |
| `PATCH` | `/documents/{identifier}` | Rename title and regenerate slug |
| `DELETE` | `/documents/{identifier}?revision=N` | Delete with revision check |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/readyz` | Database readiness check |

Content updates and renames require the current positive `revision`. Successful
updates increment it. A stale revision returns `409 Conflict`.

When creating a document, a conflicting title receives a numeric suffix and the
slug is then generated from that final title: `My document` becomes
`my-document`, followed by `My document 2` / `my-document-2`, and so on.
Renaming is strict and returns `409 Conflict` when the requested slug is already
in use.

The list endpoint returns lightweight summaries:

```json
{
	"id": "uuid",
	"title": "My document",
	"slug": "my-document",
	"revision": 3,
	"updatedAt": "2026-09-28T11:30:00Z"
}
```

## Editor behavior

Content changes are saved 700 ms after the last edit. If a save is already in
flight, the next save waits until that request completes. On a revision
conflict, the newest local JSON is stored in `localStorage`, the latest server
revision is loaded, and the local content is retried. This keeps the user's
local edits available across a page reload.

Undo and redo are available through the editor buttons or `Ctrl/Cmd+Z` and
`Ctrl/Cmd+Shift+Z`. The in-memory history keeps the latest 100 content states.

Inline paragraph marks support `bold`, `italic`, `underline`, `strike`,
`highlight`, `subscript`, and `superscript`. Subscript and superscript change
only the rendered formatting; the paragraph's canonical `text` remains
unchanged.