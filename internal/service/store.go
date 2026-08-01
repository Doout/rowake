package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/Doout/rowake/internal/app"
)

const connectionStoreVersion = 2

type connectionStore struct {
	Version     int                     `json:"version"`
	Connections []app.ConnectionRequest `json:"connections"`
}

func (s *Service) EnablePersistence(ctx context.Context, path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("connection store path is required")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve connection store: %w", err)
	}

	s.mu.Lock()
	s.storePath = absolute
	s.mu.Unlock()

	file, err := os.Open(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open connection store: %w", err)
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 1<<20))
	decoder.DisallowUnknownFields()
	var stored connectionStore
	if err := decoder.Decode(&stored); err != nil {
		return fmt.Errorf("read connection store: %w", err)
	}
	if stored.Version != 1 && stored.Version != connectionStoreVersion {
		return fmt.Errorf("connection store version %d is not supported", stored.Version)
	}

	var restoreError error
	persisted := make([]app.ConnectionRequest, 0, len(stored.Connections))
	for _, request := range stored.Connections {
		engine := strings.ToLower(strings.TrimSpace(request.Engine))
		if engine != "sqlite" && engine != "postgres" && engine != "postgresql" {
			restoreError = errors.Join(restoreError, fmt.Errorf("%s: database engine is not supported", request.Name))
			continue
		}
		persisted = append(persisted, persistentConnectionRequest(request))
	}
	s.mu.Lock()
	s.saved = append([]app.ConnectionRequest(nil), persisted...)
	s.mu.Unlock()
	if stored.Version != connectionStoreVersion || storeContainsSecrets(stored.Connections) {
		if err := writeConnectionStore(absolute, persisted); err != nil {
			return fmt.Errorf("migrate connection store: %w", err)
		}
	}

	for _, request := range persisted {
		if strings.EqualFold(request.Engine, "sqlite") {
			if _, err := s.addConnection(ctx, request, false); err != nil {
				restoreError = errors.Join(restoreError, fmt.Errorf("%s: %w", request.Name, err))
			}
			continue
		}
		s.restorePostgresProfile(request)
	}
	return restoreError
}

func storeContainsSecrets(connections []app.ConnectionRequest) bool {
	for _, request := range connections {
		if request.Password != "" {
			return true
		}
		if endpoint, err := url.Parse(strings.TrimSpace(request.DataSourceName)); err == nil && endpoint.User != nil {
			if password, ok := endpoint.User.Password(); ok && password != "" {
				return true
			}
		}
	}
	return false
}

func writeConnectionStore(path string, connections []app.ConnectionRequest) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create configuration directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".connections-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary store: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect temporary store: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(connectionStore{
		Version:     connectionStoreVersion,
		Connections: connections,
	}); err != nil {
		temporary.Close()
		return fmt.Errorf("encode connection store: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync connection store: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close connection store: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace connection store: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("protect connection store: %w", err)
	}
	return nil
}

func upsertSavedConnection(connections []app.ConnectionRequest, request app.ConnectionRequest) []app.ConnectionRequest {
	updated := append([]app.ConnectionRequest(nil), connections...)
	for index := range updated {
		if connectionRequestKey(updated[index]) == connectionRequestKey(request) {
			updated[index] = request
			return updated
		}
	}
	return append(updated, request)
}

func (s *Service) restorePostgresProfile(request app.ConnectionRequest) {
	request = persistentConnectionRequest(request)
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = strings.TrimSpace(request.Database)
	}
	port := request.Port
	if port == 0 {
		port = 5432
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	connection := app.Connection{
		ID:       fmt.Sprintf("postgres-%d", s.nextID),
		Name:     name,
		Engine:   "postgres",
		Address:  net.JoinHostPort(strings.TrimSpace(request.Host), strconv.Itoa(port)),
		Database: strings.TrimSpace(request.Database),
		Status:   "disconnected",
		ReadOnly: true,
	}
	s.connections[connection.ID] = &connectionState{
		info:     connection,
		request:  request,
		identity: strings.Join([]string{request.Username, connection.Address, request.Database}, "\x00"),
	}
	s.order = append(s.order, connection.ID)
}
