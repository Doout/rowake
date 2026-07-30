package server_test

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/server"
	"github.com/Doout/rowake/internal/service"
)

func TestInterfaceAndSQLiteAPI(t *testing.T) {
	appService := service.New("dev")
	t.Cleanup(func() { _ = appService.Close() })
	handler, err := server.New(appService, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	response := serve(handler, http.MethodGet, "/", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "<title>Rowake</title>") {
		t.Fatalf("interface response = %d %s", response.Code, response.Body.String())
	}

	response = serve(handler, http.MethodGet, "/api/v1/connections", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"connections":[]`) {
		t.Fatalf("connections response = %d %s", response.Code, response.Body.String())
	}

	body, err := json.Marshal(app.ConnectionRequest{
		Name:           "Fixture",
		Engine:         "sqlite",
		DataSourceName: fixturePath(t),
	})
	if err != nil {
		t.Fatal(err)
	}
	response = serve(handler, http.MethodPost, "/api/v1/connections", bytes.NewReader(body))
	if response.Code != http.StatusCreated {
		t.Fatalf("add connection response = %d %s", response.Code, response.Body.String())
	}
	var added struct {
		Connection app.Connection `json:"connection"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &added); err != nil {
		t.Fatal(err)
	}
	if added.Connection.ID == "" || added.Connection.Name != "Fixture" {
		t.Fatalf("added connection = %#v", added.Connection)
	}

	query := url.Values{"connection_id": []string{added.Connection.ID}}
	response = serve(handler, http.MethodGet, "/api/v1/catalog?"+query.Encode(), nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"name":"users"`) {
		t.Fatalf("catalog response = %d %s", response.Code, response.Body.String())
	}
	response = serve(handler, http.MethodGet, "/api/v1/topology?"+query.Encode(), nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"from_table":"projects"`) {
		t.Fatalf("topology response = %d %s", response.Code, response.Body.String())
	}

	query.Set("schema", "main")
	query.Set("table", "users")
	query.Set("limit", "2")
	response = serve(handler, http.MethodGet, "/api/v1/table?"+query.Encode(), nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "alice@example.test") {
		t.Fatalf("table response = %d %s", response.Code, response.Body.String())
	}

	body, err = json.Marshal(app.QueryRequest{
		ConnectionID: added.Connection.ID,
		SQL:          "SELECT name FROM projects ORDER BY id",
		Limit:        100,
	})
	if err != nil {
		t.Fatal(err)
	}
	response = serve(handler, http.MethodPost, "/api/v1/query", bytes.NewReader(body))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"Atlas"`) {
		t.Fatalf("query response = %d %s", response.Code, response.Body.String())
	}

	body, err = json.Marshal(app.QueryRequest{
		ConnectionID: added.Connection.ID,
		SQL:          "DELETE FROM users",
	})
	if err != nil {
		t.Fatal(err)
	}
	response = serve(handler, http.MethodPost, "/api/v1/query", bytes.NewReader(body))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "read-only") {
		t.Fatalf("write query response = %d %s", response.Code, response.Body.String())
	}
}

func serve(handler http.Handler, method, target string, body io.Reader) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(method, target, body)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	handler.ServeHTTP(response, request)
	return response
}

func fixturePath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "testdata", "rowake-test.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	return path
}
