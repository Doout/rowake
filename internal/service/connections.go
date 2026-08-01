package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ConnectionProfile(_ context.Context, connectionID string) (app.ConnectionRequest, error) {
	state, err := s.connection(connectionID)
	if err != nil {
		return app.ConnectionRequest{}, err
	}
	return persistentConnectionRequest(state.request), nil
}

func (s *Service) TestConnection(ctx context.Context, request app.ConnectionRequest) error {
	switch strings.ToLower(strings.TrimSpace(request.Engine)) {
	case "sqlite":
		path, err := resolveSQLitePath(request.DataSourceName)
		if err != nil {
			return err
		}
		database, err := openSQLiteReadOnly(ctx, path)
		if err != nil {
			return err
		}
		return database.Close()
	case "postgres", "postgresql":
		config, err := postgresConfig(request, "")
		if err != nil {
			return err
		}
		database, cleanup, err := openPostgres(ctx, config)
		if err != nil {
			return sanitizeConnectionError(err, request)
		}
		_ = database
		cleanup()
		return nil
	default:
		return errors.New("database engine must be SQLite or PostgreSQL")
	}
}

func (s *Service) UpdateConnection(ctx context.Context, connectionID string, request app.ConnectionRequest) (app.Connection, error) {
	connectionID = strings.TrimSpace(connectionID)
	s.mu.RLock()
	current, ok := s.connections[connectionID]
	if !ok {
		s.mu.RUnlock()
		return app.Connection{}, ErrConnectionRequired
	}
	oldRequest := current.request
	oldIdentity := current.identity
	engine := current.info.Engine
	s.mu.RUnlock()

	requestedEngine := strings.ToLower(strings.TrimSpace(request.Engine))
	if requestedEngine == "postgresql" {
		requestedEngine = "postgres"
	}
	if requestedEngine != engine {
		return app.Connection{}, errors.New("a connection profile cannot change database engine")
	}

	var (
		database *sql.DB
		cleanup  func()
		identity string
		profile  app.ConnectionRequest
		info     app.Connection
		err      error
	)
	if engine == "sqlite" {
		var path string
		path, err = resolveSQLitePath(request.DataSourceName)
		if err == nil {
			database, err = openSQLiteReadOnly(ctx, path)
		}
		if err == nil {
			name := strings.TrimSpace(request.Name)
			if name == "" {
				name = filepath.Base(path)
			}
			identity = path
			profile = app.ConnectionRequest{Name: name, Engine: "sqlite", DataSourceName: path}
			info = app.Connection{ID: connectionID, Name: name, Engine: "sqlite", Address: path, Database: filepath.Base(path), Status: "connected", ReadOnly: true}
		}
	} else {
		var config *pgx.ConnConfig
		config, err = postgresConfig(request, "")
		if err == nil {
			database, cleanup, err = openPostgres(ctx, config)
		}
		if err == nil {
			name := strings.TrimSpace(request.Name)
			if name == "" {
				name = config.Database
			}
			identity = postgresIdentity(config)
			profile = postgresProfileFromConfig(request, name, config)
			info = app.Connection{ID: connectionID, Name: name, Engine: "postgres", Address: postgresAddress(config), Database: config.Database, Status: "connected", ReadOnly: true}
		}
	}
	if err != nil {
		return app.Connection{}, sanitizeConnectionError(err, request)
	}

	closeReplacement := func() {
		if cleanup != nil {
			cleanup()
		} else if database != nil {
			_ = database.Close()
		}
	}
	s.mu.Lock()
	current, ok = s.connections[connectionID]
	if !ok || current.identity != oldIdentity {
		s.mu.Unlock()
		closeReplacement()
		return app.Connection{}, errors.New("connection changed while updating")
	}
	for id, candidate := range s.connections {
		if id != connectionID && candidate.info.Engine == engine && candidate.identity == identity {
			s.mu.Unlock()
			closeReplacement()
			return app.Connection{}, errors.New("this database is already connected")
		}
	}
	nextSaved := upsertSavedConnection(removeSavedConnection(s.saved, oldRequest), persistentConnectionRequest(profile))
	if s.storePath != "" {
		if err := writeConnectionStore(s.storePath, nextSaved); err != nil {
			s.mu.Unlock()
			closeReplacement()
			return app.Connection{}, fmt.Errorf("save connection profile: %w", err)
		}
	}
	oldDatabase, oldCleanup := current.database, current.cleanup
	current.info = info
	current.request = profile
	current.identity = identity
	current.database = database
	current.cleanup = cleanup
	if s.storePath != "" {
		s.saved = nextSaved
	}
	s.mu.Unlock()
	if oldCleanup != nil {
		oldCleanup()
	} else if oldDatabase != nil {
		_ = oldDatabase.Close()
	}
	return info, nil
}

func (s *Service) DisconnectConnection(_ context.Context, connectionID string) (app.Connection, error) {
	s.mu.Lock()
	state, ok := s.connections[strings.TrimSpace(connectionID)]
	if !ok {
		s.mu.Unlock()
		return app.Connection{}, ErrConnectionRequired
	}
	if state.database == nil {
		connection := state.info
		s.mu.Unlock()
		return connection, nil
	}
	database, cleanup := state.database, state.cleanup
	state.database = nil
	state.cleanup = nil
	state.info.Status = "disconnected"
	connection := state.info
	s.mu.Unlock()
	if cleanup != nil {
		cleanup()
	} else if err := database.Close(); err != nil {
		return app.Connection{}, fmt.Errorf("disconnect database: %w", err)
	}
	return connection, nil
}

func (s *Service) ReconnectConnection(ctx context.Context, connectionID, password string) (app.Connection, error) {
	s.mu.RLock()
	state, ok := s.connections[strings.TrimSpace(connectionID)]
	if !ok {
		s.mu.RUnlock()
		return app.Connection{}, ErrConnectionRequired
	}
	if state.database != nil {
		connection := state.info
		s.mu.RUnlock()
		return connection, nil
	}
	request := state.request
	identity := state.identity
	s.mu.RUnlock()
	if password != "" {
		request.Password = password
	}

	var database *sql.DB
	var cleanup func()
	var err error
	if request.Engine == "postgres" {
		config, configErr := postgresConfig(request, "")
		if configErr != nil {
			return app.Connection{}, configErr
		}
		database, cleanup, err = openPostgres(ctx, config)
	} else {
		database, err = openSQLiteReadOnly(ctx, request.DataSourceName)
	}
	if err != nil {
		return app.Connection{}, sanitizeConnectionError(err, request)
	}

	s.mu.Lock()
	current, ok := s.connections[strings.TrimSpace(connectionID)]
	if !ok || current.identity != identity || current.database != nil {
		s.mu.Unlock()
		if cleanup != nil {
			cleanup()
		} else {
			_ = database.Close()
		}
		return app.Connection{}, errors.New("connection changed while reconnecting")
	}
	current.database = database
	current.cleanup = cleanup
	current.request = request
	current.info.Status = "connected"
	connection := current.info
	s.mu.Unlock()
	return connection, nil
}

func (s *Service) RemoveConnection(_ context.Context, connectionID string) error {
	connectionID = strings.TrimSpace(connectionID)
	s.mu.Lock()
	state, ok := s.connections[connectionID]
	if !ok {
		s.mu.Unlock()
		return ErrConnectionRequired
	}
	nextSaved := removeSavedConnection(s.saved, state.request)
	if s.storePath != "" {
		if err := writeConnectionStore(s.storePath, nextSaved); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("remove saved connection: %w", err)
		}
	}
	delete(s.connections, connectionID)
	for index, id := range s.order {
		if id == connectionID {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
	s.saved = nextSaved
	database, cleanup := state.database, state.cleanup
	s.mu.Unlock()
	if database == nil {
		return nil
	}
	if cleanup != nil {
		cleanup()
		return nil
	}
	return database.Close()
}

func openSQLiteReadOnly(ctx context.Context, path string) (*sql.DB, error) {
	resolved, err := resolveSQLitePath(path)
	if err != nil {
		return nil, err
	}
	source := (&url.URL{Scheme: "file", Path: resolved, RawQuery: "mode=ro"}).String()
	database, err := db.Open(ctx, db.OpenOptions{
		Driver:          "sqlite3",
		DataSourceName:  source,
		MaxOpen:         1,
		MaxIdle:         1,
		ConnectionProbe: 5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	var schemaVersion int
	if err := database.QueryRowContext(ctx, "PRAGMA schema_version").Scan(&schemaVersion); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	return database, nil
}

func persistentConnectionRequest(request app.ConnectionRequest) app.ConnectionRequest {
	request.Password = ""
	if strings.EqualFold(request.Engine, "postgres") || strings.EqualFold(request.Engine, "postgresql") {
		request.Engine = "postgres"
		if endpoint, err := url.Parse(strings.TrimSpace(request.DataSourceName)); err == nil && endpoint.Hostname() != "" {
			request.Host = endpoint.Hostname()
			if port, parseErr := strconv.Atoi(endpoint.Port()); parseErr == nil {
				request.Port = port
			}
			if request.Port == 0 {
				request.Port = 5432
			}
			if endpoint.User != nil {
				request.Username = endpoint.User.Username()
			}
			request.Database = strings.TrimPrefix(endpoint.Path, "/")
			if sslMode := endpoint.Query().Get("sslmode"); sslMode != "" {
				request.SSLMode = sslMode
			}
		}
		request.DataSourceName = ""
	}
	return request
}

func sanitizeConnectionError(err error, request app.ConnectionRequest) error {
	message := err.Error()
	if request.Password != "" {
		message = strings.ReplaceAll(message, request.Password, "[redacted]")
	}
	if source := strings.TrimSpace(request.DataSourceName); source != "" {
		if endpoint, parseErr := url.Parse(source); parseErr == nil && endpoint.User != nil {
			if password, ok := endpoint.User.Password(); ok && password != "" {
				message = strings.ReplaceAll(message, password, "[redacted]")
			}
		}
	}
	return errors.New(message)
}

func removeSavedConnection(connections []app.ConnectionRequest, request app.ConnectionRequest) []app.ConnectionRequest {
	key := connectionRequestKey(request)
	updated := make([]app.ConnectionRequest, 0, len(connections))
	for _, candidate := range connections {
		if connectionRequestKey(candidate) != key {
			updated = append(updated, candidate)
		}
	}
	return updated
}

func connectionRequestKey(request app.ConnectionRequest) string {
	engine := strings.ToLower(strings.TrimSpace(request.Engine))
	if engine == "postgresql" {
		engine = "postgres"
	}
	if engine == "sqlite" {
		return engine + "\x00" + strings.TrimSpace(request.DataSourceName)
	}
	return strings.Join([]string{
		engine,
		strings.TrimSpace(request.Username),
		strings.TrimSpace(request.Host),
		strconv.Itoa(request.Port),
		strings.TrimSpace(request.Database),
	}, "\x00")
}
