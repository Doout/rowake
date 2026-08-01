package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
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
	service     app.Service
	logger      *slog.Logger
	accessToken string
	dist        fs.FS
	static      http.Handler
}

func New(service app.Service, logger *slog.Logger) (http.Handler, error) {
	return NewWithAccessToken(service, logger, "")
}

func NewWithAccessToken(service app.Service, logger *slog.Logger, accessToken string) (http.Handler, error) {
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
		service: service, logger: logger, accessToken: strings.TrimSpace(accessToken), dist: dist,
		static: http.FileServer(http.FS(dist)),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /api/v1/meta", s.meta)
	mux.HandleFunc("GET /api/v1/connections", s.connections)
	mux.HandleFunc("POST /api/v1/connections", s.addConnection)
	mux.HandleFunc("POST /api/v1/connections/test", s.testConnection)
	mux.HandleFunc("PUT /api/v1/connections/{id}", s.updateConnection)
	mux.HandleFunc("GET /api/v1/connections/{id}/profile", s.connectionProfile)
	mux.HandleFunc("POST /api/v1/connections/{id}/disconnect", s.disconnectConnection)
	mux.HandleFunc("POST /api/v1/connections/{id}/reconnect", s.reconnectConnection)
	mux.HandleFunc("DELETE /api/v1/connections/{id}", s.removeConnection)
	mux.HandleFunc("POST /api/v1/databases", s.databases)
	mux.HandleFunc("GET /api/v1/catalog", s.catalog)
	mux.HandleFunc("GET /api/v1/topology", s.topology)
	mux.HandleFunc("GET /api/v1/table", s.table)
	mux.HandleFunc("POST /api/v1/table/page", s.tablePage)
	mux.HandleFunc("POST /api/v1/query", s.query)
	mux.HandleFunc("POST /api/v1/explain", s.explain)
	mux.HandleFunc("GET /api/v1/schema-snapshot", s.schemaSnapshot)
	mux.Handle("/", s)
	return s.withHeaders(s.withLog(s.withAccess(mux))), nil
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

func (s *Server) testConnection(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.ConnectionRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode connection test: %w", err))
		return
	}
	if err := s.service.TestConnection(r.Context(), request); err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) updateConnection(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.ConnectionRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode connection update: %w", err))
		return
	}
	value, err := s.service.UpdateConnection(r.Context(), r.PathValue("id"), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"connection": value})
}

func (s *Server) connectionProfile(w http.ResponseWriter, r *http.Request) {
	value, err := s.service.ConnectionProfile(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusNotFound, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"profile": value})
}

func (s *Server) disconnectConnection(w http.ResponseWriter, r *http.Request) {
	value, err := s.service.DisconnectConnection(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"connection": value})
}

func (s *Server) reconnectConnection(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	var request struct {
		Password string `json:"password"`
	}
	if r.ContentLength != 0 {
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode reconnect request: %w", err))
			return
		}
	}
	value, err := s.service.ReconnectConnection(r.Context(), r.PathValue("id"), request.Password)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"connection": value})
}

func (s *Server) removeConnection(w http.ResponseWriter, r *http.Request) {
	if err := s.service.RemoveConnection(r.Context(), r.PathValue("id")); err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

func (s *Server) tablePage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.TablePageRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode table page request: %w", err))
		return
	}
	if strings.TrimSpace(request.ConnectionID) == "" || strings.TrimSpace(request.Schema) == "" || strings.TrimSpace(request.Table) == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id, schema, and table are required"))
		return
	}
	if request.Limit < 0 || request.Limit > 1000 {
		s.writeError(w, http.StatusBadRequest, errors.New("limit must be between 1 and 1000"))
		return
	}
	value, err := s.service.TablePage(r.Context(), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
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

func (s *Server) explain(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request app.QueryRequest
	if err := decoder.Decode(&request); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Errorf("decode explain request: %w", err))
		return
	}
	if strings.TrimSpace(request.ConnectionID) == "" || strings.TrimSpace(request.SQL) == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id and sql are required"))
		return
	}
	value, err := s.service.Explain(r.Context(), request)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err)
		return
	}
	s.writeJSON(w, http.StatusOK, value)
}

func (s *Server) schemaSnapshot(w http.ResponseWriter, r *http.Request) {
	connectionID := strings.TrimSpace(r.URL.Query().Get("connection_id"))
	if connectionID == "" {
		s.writeError(w, http.StatusBadRequest, errors.New("connection_id is required"))
		return
	}
	value, err := s.service.SchemaSnapshot(r.Context(), connectionID)
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

func (s *Server) withAccess(next http.Handler) http.Handler {
	if s.accessToken == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if supplied := strings.TrimSpace(r.URL.Query().Get("token")); supplied != "" && secureTokenEqual(supplied, s.accessToken) {
			http.SetCookie(w, &http.Cookie{
				Name: "rowake_access", Value: supplied, Path: "/", HttpOnly: true,
				SameSite: http.SameSiteStrictMode, MaxAge: 12 * 60 * 60,
			})
			query := r.URL.Query()
			query.Del("token")
			destination := *r.URL
			destination.RawQuery = query.Encode()
			http.Redirect(w, r, destination.String(), http.StatusSeeOther)
			return
		}
		authorized := false
		if header := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(header, "Bearer ") {
			authorized = secureTokenEqual(strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")), s.accessToken)
		}
		if !authorized {
			if cookie, err := r.Cookie("rowake_access"); err == nil {
				authorized = secureTokenEqual(cookie.Value, s.accessToken)
			}
		}
		if !authorized {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				s.writeError(w, http.StatusUnauthorized, errors.New("Rowake access token is required"))
			} else {
				http.Error(w, "Rowake access token is required. Open this URL with ?token=<access-token> once to start a protected session.", http.StatusUnauthorized)
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func secureTokenEqual(left, right string) bool {
	if len(left) != len(right) || left == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
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
