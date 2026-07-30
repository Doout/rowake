package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/webembed"
)

type contextKey string

const cspNonceKey contextKey = "csp-nonce"

type Server struct {
	service app.Service
	logger  *slog.Logger
	dist    fs.FS
	static  http.Handler
}

func New(service app.Service, logger *slog.Logger) (http.Handler, error) {
	if service == nil {
		return nil, errors.New("service is required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	dist, err := fs.Sub(webembed.Dist, "dist")
	if err != nil {
		return nil, fmt.Errorf("open embedded web interface: %w", err)
	}
	s := &Server{
		service: service, logger: logger, dist: dist,
		static: http.FileServer(http.FS(dist)),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/meta", s.meta)
	mux.HandleFunc("GET /api/v1/connections", s.connections)
	mux.HandleFunc("POST /api/v1/connections", s.addConnection)
	mux.HandleFunc("POST /api/v1/databases", s.databases)
	mux.HandleFunc("GET /api/v1/catalog", s.catalog)
	mux.HandleFunc("GET /api/v1/topology", s.topology)
	mux.HandleFunc("GET /api/v1/table", s.table)
	mux.HandleFunc("POST /api/v1/query", s.query)
	mux.Handle("/", s)
	return s.withHeaders(s.withLog(mux)), nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if path == "index.html" {
		s.serveIndex(w, r)
		return
	}
	if info, err := fs.Stat(s.dist, path); err == nil && !info.IsDir() {
		s.static.ServeHTTP(w, r)
		return
	}
	s.serveIndex(w, r)
}

func (s *Server) serveIndex(w http.ResponseWriter, r *http.Request) {
	content, err := fs.ReadFile(s.dist, "index.html")
	if err != nil {
		http.Error(w, "Rowake interface is unavailable", http.StatusInternalServerError)
		return
	}
	nonce, _ := r.Context().Value(cspNonceKey).(string)
	content = []byte(strings.ReplaceAll(string(content), "{{CSP_NONCE}}", nonce))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(content)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	value, err := s.service.Meta(r.Context())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func (s *Server) connections(w http.ResponseWriter, r *http.Request) {
	value, err := s.service.Connections(r.Context())
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"connections": value})
}

func (s *Server) addConnection(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.ConnectionRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode connection request: %w", err))
		return
	}
	value, err := s.service.AddConnection(r.Context(), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusCreated, map[string]any{"connection": value})
}

func (s *Server) databases(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.ConnectionRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode database discovery request: %w", err))
		return
	}
	value, err := s.service.Databases(r.Context(), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"databases": value})
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	connection := strings.TrimSpace(r.URL.Query().Get("connection_id"))
	if connection == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id is required"))
		return
	}
	value, err := s.service.Catalog(r.Context(), connection)
	if err != nil {
		s.writeError(w, http.StatusNotFound, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func (s *Server) topology(w http.ResponseWriter, r *http.Request) {
	connection := strings.TrimSpace(r.URL.Query().Get("connection_id"))
	if connection == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id is required"))
		return
	}
	value, err := s.service.Topology(r.Context(), connection)
	if err != nil {
		s.writeError(w, http.StatusNotFound, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func (s *Server) table(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	connection := strings.TrimSpace(query.Get("connection_id"))
	schema := strings.TrimSpace(query.Get("schema"))
	table := strings.TrimSpace(query.Get("table"))
	if connection == "" || schema == "" || table == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id, schema, and table are required"))
		return
	}
	limit, err := parseLimit(query.Get("limit"))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	value, err := s.service.Table(r.Context(), connection, schema, table, limit)
	if err != nil {
		s.writeError(w, http.StatusNotFound, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.QueryRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode query request: %w", err))
		return
	}
	if strings.TrimSpace(request.ConnectionID) == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id is required"))
		return
	}
	value, err := s.service.Query(r.Context(), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func parseLimit(raw string) (int, error) {
	if raw == "" {
		return 100, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 || value > 1000 {
		return 0, errors.New("limit must be an integer between 1 and 1000")
	}
	return value, nil
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		s.logger.Error("encode response", "error", err)
	}
}

func (s *Server) writeError(w http.ResponseWriter, status int, err error) {
	s.writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *Server) withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonce, err := newCSPNonce()
		if err != nil {
			http.Error(w, "could not secure response", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Security-Policy", fmt.Sprintf("default-src 'self'; img-src 'self' data:; style-src 'self' 'nonce-%s'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", nonce))
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), cspNonceKey, nonce)))
	})
}

func newCSPNonce() (string, error) {
	value := make([]byte, 18)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func (s *Server) withLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.logger.Debug("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
		}
	})
}
