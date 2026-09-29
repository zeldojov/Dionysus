package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

const currentSchemaVersion = 2

type documentPayload struct {
	SchemaVersion int              `json:"schemaVersion"`
	Blocks        []paragraphBlock `json:"blocks"`
}

type paragraphBlock struct {
	ID    string          `json:"id"`
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	Align string          `json:"align,omitempty"`
	Marks []paragraphMark `json:"marks,omitempty"`
	Links []paragraphLink `json:"links,omitempty"`
}

type paragraphMark struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Style string `json:"style"`
}

type paragraphLink struct {
	Start         int    `json:"start"`
	End           int    `json:"end"`
	DocumentID    string `json:"documentId"`
	TargetBlockID string `json:"blockId"`
	Reference     bool   `json:"reference,omitempty"`
}

type documentResponse struct {
	ID            string          `json:"id"`
	Title         string          `json:"title"`
	Slug          string          `json:"slug"`
	Content       documentPayload `json:"content"`
	SchemaVersion int             `json:"schemaVersion"`
	Revision      int64           `json:"revision"`
	CreatedAt     time.Time       `json:"createdAt"`
	UpdatedAt     time.Time       `json:"updatedAt"`
}

type documentSummary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Slug      string    `json:"slug"`
	Revision  int64     `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type createDocumentRequest struct {
	Title string `json:"title"`
}

type updateDocumentRequest struct {
	Content  documentPayload `json:"content"`
	Revision int64           `json:"revision"`
}

type renameDocumentRequest struct {
	Title    string `json:"title"`
	Revision int64  `json:"revision"`
}

func (request createDocumentRequest) normalized() (string, string, error) {
	title := strings.TrimSpace(request.Title)
	if title == "" {
		title = "Untitled document"
	}

	slug := slugify(title)
	if slug == "" {
		return "", "", errors.New("title must contain letters or numbers")
	}
	return title, slug, nil
}

func emptyDocument() documentPayload {
	return documentPayload{
		SchemaVersion: currentSchemaVersion,
		Blocks: []paragraphBlock{
			{ID: newID(), Type: "paragraph", Text: ""},
		},
	}
}

func (document documentPayload) validate() error {
	if document.SchemaVersion != currentSchemaVersion {
		return fmt.Errorf("unsupported schemaVersion: %d", document.SchemaVersion)
	}
	if len(document.Blocks) == 0 {
		return errors.New("document must contain at least one block")
	}

	seenIDs := make(map[string]struct{}, len(document.Blocks))
	for _, block := range document.Blocks {
		if block.ID == "" {
			return errors.New("paragraph block id is required")
		}
		if _, exists := seenIDs[block.ID]; exists {
			return fmt.Errorf("duplicate block id: %s", block.ID)
		}
		seenIDs[block.ID] = struct{}{}

		if block.Type != "paragraph" {
			return fmt.Errorf("unsupported block type: %s", block.Type)
		}
		if strings.ContainsAny(block.Text, "\r\n") {
			return errors.New("paragraph text must not contain newline characters")
		}
		switch block.Align {
		case "", "left", "center", "right", "justify":
		default:
			return fmt.Errorf("unsupported paragraph alignment: %s", block.Align)
		}
		textLength := len(utf16.Encode([]rune(block.Text)))
		for _, mark := range block.Marks {
			if mark.Start < 0 || mark.End <= mark.Start || mark.End > textLength {
				return fmt.Errorf("invalid paragraph mark range: %d-%d", mark.Start, mark.End)
			}
			switch mark.Style {
			case "bold", "italic", "underline", "strike", "highlight", "subscript", "superscript":
			default:
				return fmt.Errorf("unsupported paragraph mark style: %s", mark.Style)
			}
		}
		for _, link := range block.Links {
			if link.Start < 0 || link.End <= link.Start || link.End > textLength {
				return fmt.Errorf("invalid paragraph link range: %d-%d", link.Start, link.End)
			}
			if link.DocumentID == "" || link.TargetBlockID == "" {
				return errors.New("paragraph link target is required")
			}
		}
	}

	return nil
}

func migrateDocument(document documentPayload) (documentPayload, error) {
	switch document.SchemaVersion {
	case 1:
		document.SchemaVersion = currentSchemaVersion
		return document, nil
	case currentSchemaVersion:
		return document, nil
	default:
		return documentPayload{}, fmt.Errorf("unsupported schemaVersion: %d", document.SchemaVersion)
	}
}

func newID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("generate paragraph id: " + err.Error())
	}
	return fmt.Sprintf("paragraph-%x", value)
}

func slugify(value string) string {
	value = strings.Map(func(r rune) rune {
		mapped, exists := map[rune]rune{
			'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Ђ': 'Đ', 'Е': 'E', 'Ж': 'Ž', 'З': 'Z', 'И': 'I', 'Ј': 'J', 'К': 'K', 'Л': 'L', 'Љ': 'L', 'М': 'M', 'Н': 'N', 'Њ': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T', 'Ћ': 'Ć', 'У': 'U', 'Ф': 'F', 'Х': 'H', 'Ц': 'C', 'Ч': 'Č', 'Џ': 'D', 'Ш': 'Š',
			'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'đ', 'е': 'e', 'ж': 'ž', 'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'l', 'м': 'm', 'н': 'n', 'њ': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ћ': 'ć', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'č', 'џ': 'd', 'ш': 'š',
			'Č': 'C', 'Ć': 'C', 'Ž': 'Z', 'Š': 'S', 'Đ': 'D', 'č': 'c', 'ć': 'c', 'ž': 'z', 'š': 's', 'đ': 'd',
		}[r]
		if exists {
			return mapped
		}
		return r
	}, value)

	var slug strings.Builder
	lastWasSeparator := false
	for _, r := range strings.ToLower(value) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			slug.WriteRune(r)
			lastWasSeparator = false
		case !lastWasSeparator && (unicode.IsSpace(r) || r == '-'):
			slug.WriteByte('-')
			lastWasSeparator = true
		}
	}

	return strings.Trim(slug.String(), "-")
}
