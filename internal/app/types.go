package app

import "context"

type Meta struct {
	Name     string          `json:"name"`
	Version  string          `json:"version"`
	Features map[string]bool `json:"features"`
}

type Connection struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Engine   string `json:"engine"`
	Address  string `json:"address"`
	Database string `json:"database"`
	Status   string `json:"status"`
	ReadOnly bool   `json:"read_only"`
}

type ConnectionRequest struct {
	Name           string `json:"name"`
	Engine         string `json:"engine"`
	DataSourceName string `json:"data_source_name"`
}

type Catalog struct {
	ConnectionID string   `json:"connection_id"`
	Schemas      []Schema `json:"schemas"`
}

type DatabaseTopology struct {
	ConnectionID  string                 `json:"connection_id"`
	Tables        []TopologyTable        `json:"tables"`
	Relationships []TopologyRelationship `json:"relationships"`
}

type TopologyTable struct {
	ID         string   `json:"id"`
	Schema     string   `json:"schema"`
	Name       string   `json:"name"`
	Kind       string   `json:"kind"`
	Columns    []Column `json:"columns"`
	PrimaryKey []string `json:"primary_key"`
}

type TopologyRelationship struct {
	ID         string `json:"id"`
	FromTable  string `json:"from_table"`
	FromColumn string `json:"from_column"`
	ToTable    string `json:"to_table"`
	ToColumn   string `json:"to_column"`
	OnUpdate   string `json:"on_update,omitempty"`
	OnDelete   string `json:"on_delete,omitempty"`
}

type Schema struct {
	Name   string  `json:"name"`
	Tables []Table `json:"tables"`
}

type Table struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
}

type Column struct {
	Name       string `json:"name"`
	DataType   string `json:"data_type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primary_key,omitempty"`
	Default    string `json:"default,omitempty"`
}

type Index struct {
	Name       string   `json:"name"`
	Columns    []string `json:"columns"`
	Unique     bool     `json:"unique"`
	Definition string   `json:"definition,omitempty"`
}

type Capability struct {
	CanQuery bool `json:"can_query"`
	CanWrite bool `json:"can_write"`
	CanEdit  bool `json:"can_edit"`
}

type TableSnapshot struct {
	ConnectionID string     `json:"connection_id"`
	Schema       string     `json:"schema"`
	Name         string     `json:"name"`
	Columns      []Column   `json:"columns"`
	Indexes      []Index    `json:"indexes"`
	Rows         [][]any    `json:"rows"`
	RowCount     int        `json:"row_count"`
	TotalRows    int64      `json:"total_rows"`
	Truncated    bool       `json:"truncated"`
	DurationMS   int        `json:"duration_ms"`
	PrimaryKey   []string   `json:"primary_key"`
	Capabilities Capability `json:"capabilities"`
}

type QueryRequest struct {
	ConnectionID string `json:"connection_id"`
	SQL          string `json:"sql"`
	Limit        int    `json:"limit"`
}

type QueryResult struct {
	Columns    []Column `json:"columns"`
	Rows       [][]any  `json:"rows"`
	RowCount   int      `json:"row_count"`
	DurationMS int      `json:"duration_ms"`
	Truncated  bool     `json:"truncated"`
	Statement  string   `json:"statement"`
}

type Service interface {
	Meta(context.Context) (Meta, error)
	Connections(context.Context) ([]Connection, error)
	AddConnection(context.Context, ConnectionRequest) (Connection, error)
	Catalog(context.Context, string) (Catalog, error)
	Topology(context.Context, string) (DatabaseTopology, error)
	Table(context.Context, string, string, string, int) (TableSnapshot, error)
	Query(context.Context, QueryRequest) (QueryResult, error)
}
