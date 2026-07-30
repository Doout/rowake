package launch_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/launch"
)

func TestStartAndShutdown(t *testing.T) {
	running, err := launch.Start(context.Background(), launch.Config{
		Listen: "127.0.0.1:0",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}

	response, err := http.Get(running.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status = %d", response.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := running.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestStartRestoresSavedConnections(t *testing.T) {
	storePath := filepath.Join(t.TempDir(), "connections.json")
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	config := launch.Config{
		Listen:          "127.0.0.1:0",
		Logger:          logger,
		ConnectionStore: storePath,
	}

	first, err := launch.Start(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	requestBody, err := json.Marshal(app.ConnectionRequest{
		Name:           "Saved fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(first.URL+"/api/v1/connections", "application/json", bytes.NewReader(requestBody))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("add connection status = %d", response.StatusCode)
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	if err := first.Shutdown(shutdownCtx); err != nil {
		cancel()
		t.Fatal(err)
	}
	cancel()

	second, err := launch.Start(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_ = second.Shutdown(ctx)
	})
	response, err = http.Get(second.URL + "/api/v1/connections")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"name":"Saved fixture"`) {
		t.Fatalf("restored connections response = %d %s", response.StatusCode, body)
	}
}

func fixturePath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "testdata", "rowake-test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}
