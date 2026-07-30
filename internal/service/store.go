package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/Doout/rowake/internal/app"
)

const connectionStoreVersion = 1

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
	if stored.Version != connectionStoreVersion {
		return fmt.Errorf("connection store version %d is not supported", stored.Version)
	}

	var restoreError error
	persisted := make([]app.ConnectionRequest, 0, len(stored.Connections))
	for _, request := range stored.Connections {
		if !strings.EqualFold(strings.TrimSpace(request.Engine), "sqlite") {
			restoreError = errors.Join(restoreError,
				fmt.Errorf("%s: only SQLite connections can be restored; server credentials are session-only", request.Name))
			continue
		}
		persisted = append(persisted, request)
	}
	s.mu.Lock()
	s.saved = append([]app.ConnectionRequest(nil), persisted...)
	s.mu.Unlock()

	for _, request := range persisted {
		if _, err := s.addConnection(ctx, request, false); err != nil {
			restoreError = errors.Join(restoreError, fmt.Errorf("%s: %w", request.Name, err))
		}
	}
	return restoreError
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
		if updated[index].Engine == request.Engine && updated[index].DataSourceName == request.DataSourceName {
			updated[index] = request
			return updated
		}
	}
	return append(updated, request)
}
