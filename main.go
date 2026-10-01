package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed web/templates/index.html web/templates/documents.html web/static/*
var webFiles embed.FS

const (
	defaultDBHost  = "127.0.0.1"
	defaultDBPort  = "5432"
	defaultDBUser  = "dionysus_app"
	defaultDBName  = "dionysus"
	defaultSSLMode = "disable"
)

type config struct {
	addr       string
	dbHost     string
	dbPort     string
	dbUser     string
	dbPassword string
	dbName     string
	dbSSLMode  string
}

type server struct {
	db *pgxpool.Pool
}

type healthResponse struct {
	Status string `json:"status"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("load configuration: %v", err)
	}

	ctx := context.Background()
	db, err := pgxpool.New(ctx, cfg.dbConnectionString())
	if err != nil {
		log.Fatalf("create database pool: %v", err)
	}
	defer db.Close()

	if err := db.Ping(ctx); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	app := &server{db: db}
	httpServer := &http.Server{
		Addr:              cfg.addr,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	shutdownCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-shutdownCtx.Done()
		shutdownTimeout, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := httpServer.Shutdown(shutdownTimeout); err != nil {
			log.Printf("shutdown server: %v", err)
		}
	}()

	log.Printf("server listening on %s", cfg.addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	if os.Getenv("APP_ENV") != "production" {
		if err := loadDotEnv(".env"); err != nil && !errors.Is(err, os.ErrNotExist) {
			return config{}, fmt.Errorf("load .env: %w", err)
		}
	}

	environment := os.Getenv("APP_ENV")
	if environment == "" {
		environment = "development"
	}
	if environment != "development" && environment != "production" {
		return config{}, fmt.Errorf("APP_ENV must be development or production")
	}

	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	cfg := config{
		addr:       addr,
		dbHost:     environmentValue("DB_HOST", defaultDBHost),
		dbPort:     environmentValue("DB_PORT", defaultDBPort),
		dbUser:     environmentValue("DB_USER", defaultDBUser),
		dbPassword: os.Getenv("DB_PASSWORD"),
		dbName:     environmentValue("DB_NAME", defaultDBName),
		dbSSLMode:  environmentValue("DB_SSLMODE", defaultSSLMode),
	}
	if environment == "production" {
		for _, name := range []string{"DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"} {
			if os.Getenv(name) == "" {
				return config{}, fmt.Errorf("%s is required when APP_ENV=production", name)
			}
		}
		cfg.dbSSLMode = "require"
	}
	if cfg.dbPassword == "" && environment == "development" {
		cfg.dbPassword = "dionysus"
	}

	return cfg, nil
}

func loadDotEnv(filename string) error {
	file, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		separator := strings.IndexByte(line, '=')
		if separator <= 0 {
			return fmt.Errorf("invalid assignment on line %d", lineNumber)
		}

		name := strings.TrimSpace(line[:separator])
		if name == "" {
			return fmt.Errorf("missing variable name on line %d", lineNumber)
		}
		if _, exists := os.LookupEnv(name); exists {
			continue
		}

		value, err := parseDotEnvValue(strings.TrimSpace(line[separator+1:]))
		if err != nil {
			return fmt.Errorf("invalid value for %s on line %d: %w", name, lineNumber, err)
		}
		if err := os.Setenv(name, value); err != nil {
			return fmt.Errorf("set %s: %w", name, err)
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	return nil
}

func parseDotEnvValue(value string) (string, error) {
	if len(value) >= 2 && value[0] == '\'' && value[len(value)-1] == '\'' {
		return value[1 : len(value)-1], nil
	}
	if len(value) >= 2 && value[0] == '"' {
		parsed, err := strconv.Unquote(value)
		if err != nil {
			return "", err
		}
		return parsed, nil
	}
	return value, nil
}

func environmentValue(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func (cfg config) dbConnectionString() string {
	connectionURL := url.URL{
		Scheme:   "postgres",
		Host:     net.JoinHostPort(cfg.dbHost, cfg.dbPort),
		Path:     "/" + cfg.dbName,
		RawQuery: url.Values{"sslmode": {cfg.dbSSLMode}}.Encode(),
	}
	connectionURL.User = url.UserPassword(cfg.dbUser, cfg.dbPassword)

	return connectionURL.String()
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	staticFiles, err := fs.Sub(webFiles, "web/static")
	if err != nil {
		panic(err)
	}

	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFiles))))
	mux.HandleFunc("GET /", s.documentsPage)
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("POST /documents", s.createDocument)
	mux.HandleFunc("GET /documents", s.listDocuments)
	mux.HandleFunc("GET /documents/{identifier}/blocks/{blockID}/incoming-references", s.listIncomingReferences)
	mux.HandleFunc("DELETE /documents/{identifier}/blocks/{blockID}/incoming-references/{referenceID}", s.removeIncomingReference)
	mux.HandleFunc("GET /documents/{identifier}", s.documentRoute)
	mux.HandleFunc("PATCH /documents/{identifier}/blocks", s.updateBlocks)
	mux.HandleFunc("PATCH /documents/{identifier}", s.renameDocument)
	mux.HandleFunc("DELETE /documents/{identifier}", s.deleteDocument)
	return mux
}

func (s *server) documentRoute(w http.ResponseWriter, r *http.Request) {
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		s.editor(w, r)
		return
	}
	s.getDocument(w, r)
}

func (s *server) editor(w http.ResponseWriter, _ *http.Request) {
	tmpl, err := template.ParseFS(webFiles, "web/templates/index.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := tmpl.Execute(w, nil); err != nil {
		log.Printf("render editor: %v", err)
	}
}

func (s *server) documentsPage(w http.ResponseWriter, _ *http.Request) {
	tmpl, err := template.ParseFS(webFiles, "web/templates/documents.html")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := tmpl.Execute(w, nil); err != nil {
		log.Printf("render documents page: %v", err)
	}
}

func (s *server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok"})
}

func (s *server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.db.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, healthResponse{Status: "unavailable"})
		return
	}

	writeJSON(w, http.StatusOK, healthResponse{Status: "ready"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write JSON response: %v", err)
	}
}
