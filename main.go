package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed web/templates/index.html web/templates/documents.html web/static/*
var webFiles embed.FS

const (
	dbHost     = "127.0.0.1"
	dbPort     = "5432"
	dbUser     = "dionysus_app"
	dbPassword = "dionysus"
	dbName     = "dionysus"
	dbSSLMode  = "disable"
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
	cfg := loadConfig()

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

func loadConfig() config {
	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}

	return config{
		addr:       addr,
		dbHost:     dbHost,
		dbPort:     dbPort,
		dbUser:     dbUser,
		dbPassword: dbPassword,
		dbName:     dbName,
		dbSSLMode:  dbSSLMode,
	}
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
	mux.HandleFunc("GET /documents/{identifier}", s.documentRoute)
	mux.HandleFunc("PUT /documents/{identifier}", s.updateDocument)
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
