package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
)

var ErrConnectionRequired = errors.New("no database connection is configured")

type connectionState struct {
	info     app.Connection
	request  app.ConnectionRequest
	database *sql.DB
	identity string
	cleanup  func()
}

type Service struct {
	version     string
	mu          sync.RWMutex
	nextID      uint64
	connections map[string]*connectionState
	order       []string
	storePath   string
	saved       []app.ConnectionRequest
}

func New(version string) *Service {
	if strings.TrimSpace(version) == "" {
		version = "dev"
	}
	return &Service{
		version:     version,
		connections: make(map[string]*connectionState),
		order:       make([]string, 0),
	}
}

func (s *Service) Meta(context.Context) (app.Meta, error) {
	s.mu.RLock()
	persistenceEnabled := s.storePath != ""
	s.mu.RUnlock()
	return app.Meta{
		Name:    "Rowake",
		Version: s.version,
		Features: map[string]bool{
			"connection_persistence": persistenceEnabled,
			"postgres":               true,
			"postgres_discovery":     true,
		},
	}, nil
}

func (s *Service) Connections(context.Context) ([]app.Connection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	connections := make([]app.Connection, 0, len(s.order))
	for _, id := range s.order {
		connections = append(connections, s.connections[id].info)
	}
	return connections, nil
}

func (s *Service) AddConnection(ctx context.Context, request app.ConnectionRequest) (app.Connection, error) {
	return s.addConnection(ctx, request, true)
}

func (s *Service) addConnection(ctx context.Context, request app.ConnectionRequest, save bool) (app.Connection, error) {
	switch strings.ToLower(strings.TrimSpace(request.Engine)) {
	case "sqlite":
		return s.addSQLiteConnection(ctx, request, save)
	case "postgres", "postgresql":
		return s.addPostgresConnection(ctx, request, save)
	default:
		return app.Connection{}, errors.New("database engine must be SQLite or PostgreSQL")
	}
}

func (s *Service) addSQLiteConnection(ctx context.Context, request app.ConnectionRequest, save bool) (app.Connection, error) {
	path, err := resolveSQLitePath(request.DataSourceName)
	if err != nil {
		return app.Connection{}, err
	}

	s.mu.RLock()
	for _, state := range s.connections {
		if state.info.Engine == "sqlite" && state.identity == path {
			s.mu.RUnlock()
			return app.Connection{}, errors.New("this SQLite database is already connected")
		}
	}
	s.mu.RUnlock()

	source := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro"}).String()
	database, err := db.Open(ctx, db.OpenOptions{
		Driver:          "sqlite3",
		DataSourceName:  source,
		MaxOpen:         1,
		MaxIdle:         1,
		ConnectionProbe: 5 * time.Second,
	})
	if err != nil {
		return app.Connection{}, err
	}
	var schemaVersion int
	if err := database.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&schemaVersion); err != nil {
		_ = database.Close()
		return app.Connection{}, fmt.Errorf("open SQLite database: %w", err)
	}

	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = filepath.Base(path)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, state := range s.connections {
		if state.info.Engine == "sqlite" && state.identity == path {
			_ = database.Close()
			return app.Connection{}, errors.New("this SQLite database is already connected")
		}
	}
	s.nextID++
	connection := app.Connection{
		ID:       fmt.Sprintf("sqlite-%d", s.nextID),
		Name:     name,
		Engine:   "sqlite",
		Address:  path,
		Database: filepath.Base(path),
		Status:   "connected",
		ReadOnly: true,
	}
	if save && s.storePath != "" {
		saved := upsertSavedConnection(s.saved, app.ConnectionRequest{
			Name:           name,
			Engine:         "sqlite",
			DataSourceName: path,
		})
		if err := writeConnectionStore(s.storePath, saved); err != nil {
			_ = database.Close()
			return app.Connection{}, fmt.Errorf("save connection: %w", err)
		}
		s.saved = saved
	}
	s.connections[connection.ID] = &connectionState{
		info: connection,
		request: app.ConnectionRequest{
			Name: name, Engine: "sqlite", DataSourceName: path,
		},
		database: database,
		identity: path,
	}
	s.order = append(s.order, connection.ID)
	return connection, nil
}

func (s *Service) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var closeError error
	for _, state := range s.connections {
		if state.database != nil {
			if state.cleanup != nil {
				state.cleanup()
			} else if err := state.database.Close(); err != nil {
				closeError = errors.Join(closeError, err)
			}
		}
	}
	s.connections = make(map[string]*connectionState)
	s.order = nil
	return closeError
}

func (s *Service) connection(id string) (*connectionState, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	state, ok := s.connections[strings.TrimSpace(id)]
	if !ok {
		return nil, ErrConnectionRequired
	}
	return state, nil
}

func resolveSQLitePath(raw string) (string, error) {
	path := strings.TrimSpace(raw)
	if path == "" {
		return "", errors.New("database file is required")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("find home directory: %w", err)
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve database file: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", errors.New("database file does not exist")
		}
		return "", fmt.Errorf("inspect database file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("database file must be a regular file")
	}
	return path, nil
}

func durationMilliseconds(duration time.Duration) int {
	milliseconds := duration.Milliseconds()
	if milliseconds == 0 && duration > 0 {
		return 1
	}
	return int(milliseconds)
}
