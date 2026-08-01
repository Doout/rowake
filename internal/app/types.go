package app

import (
	"context"
	"time"
)

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
	Host           string `json:"host,omitempty"`
	Port           int    `json:"port,omitempty"`
	Username       string `json:"username,omitempty"`
	Password       string `json:"password,omitempty"`
	PasswordEnv    string `json:"password_env,omitempty"`
	SecretService  string `json:"secret_service,omitempty"`
	SecretAccount  string `json:"secret_account,omitempty"`
	Database       string `json:"database,omitempty"`
	SSLMode        string `json:"ssl_mode,omitempty"`
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
	Indexes    []Index  `json:"indexes,omitempty"`
	PrimaryKey []string `json:"primary_key"`
}

type TopologyRelationship struct {
	ID           string `json:"id"`
	ConstraintID string `json:"constraint_id,omitempty"`
	FromSchema   string `json:"from_schema,omitempty"`
	FromTable    string `json:"from_table"`
	FromColumn   string `json:"from_column"`
	ToSchema     string `json:"to_schema,omitempty"`
	ToTable      string `json:"to_table"`
	ToColumn     string `json:"to_column"`
	OnUpdate     string `json:"on_update,omitempty"`
	OnDelete     string `json:"on_delete,omitempty"`
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
	CanQuery   bool `json:"can_query"`
	CanWrite   bool `json:"can_write"`
	CanEdit    bool `json:"can_edit"`
	CanExplain bool `json:"can_explain"`
}

type TableFilter struct {
	Column   string `json:"column"`
	Operator string `json:"operator"`
	Value    string `json:"value,omitempty"`
}

type TableSort struct {
	Column    string `json:"column"`
	Direction string `json:"direction"`
}

type TablePageRequest struct {
	ConnectionID   string        `json:"connection_id"`
	Schema         string        `json:"schema"`
	Table          string        `json:"table"`
	Limit          int           `json:"limit"`
	TimeoutSeconds int           `json:"timeout_seconds,omitempty"`
	Cursor         string        `json:"cursor,omitempty"`
	Filters        []TableFilter `json:"filters,omitempty"`
	Sort           *TableSort    `json:"sort,omitempty"`
}

type TableSnapshot struct {
	ConnectionID   string        `json:"connection_id"`
	Schema         string        `json:"schema"`
	Name           string        `json:"name"`
	Columns        []Column      `json:"columns"`
	Indexes        []Index       `json:"indexes"`
	Rows           [][]any       `json:"rows"`
	RowCount       int           `json:"row_count"`
	TotalRows      *int64        `json:"total_rows,omitempty"`
	Truncated      bool          `json:"truncated"`
	HasMore        bool          `json:"has_more"`
	NextCursor     string        `json:"next_cursor,omitempty"`
	PreviousCursor string        `json:"previous_cursor,omitempty"`
	CapturedAt     time.Time     `json:"captured_at"`
	ByteLimited    bool          `json:"byte_limited,omitempty"`
	Filters        []TableFilter `json:"filters,omitempty"`
	Sort           *TableSort    `json:"sort,omitempty"`
	DurationMS     int           `json:"duration_ms"`
	PrimaryKey     []string      `json:"primary_key"`
	Capabilities   Capability    `json:"capabilities"`
}

type QueryRequest struct {
	ConnectionID   string `json:"connection_id"`
	SQL            string `json:"sql"`
	Limit          int    `json:"limit"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}

type QueryResult struct {
	Columns    []Column  `json:"columns"`
	Rows       [][]any   `json:"rows"`
	RowCount   int       `json:"row_count"`
	DurationMS int       `json:"duration_ms"`
	Truncated  bool      `json:"truncated"`
	Statement  string    `json:"statement"`
	CapturedAt time.Time `json:"captured_at"`
}

type ExplainNode struct {
	ID            string        `json:"id"`
	ParentID      string        `json:"parent_id,omitempty"`
	Operation     string        `json:"operation"`
	Relation      string        `json:"relation,omitempty"`
	Detail        string        `json:"detail,omitempty"`
	Warning       string        `json:"warning,omitempty"`
	EstimatedRows float64       `json:"estimated_rows,omitempty"`
	TotalCost     float64       `json:"total_cost,omitempty"`
	Children      []ExplainNode `json:"children,omitempty"`
}

type ExplainResult struct {
	Engine     string        `json:"engine"`
	Statement  string        `json:"statement"`
	CapturedAt time.Time     `json:"captured_at"`
	Nodes      []ExplainNode `json:"nodes"`
}

type SchemaSnapshot struct {
	Version      int              `json:"version"`
	ConnectionID string           `json:"connection_id"`
	Engine       string           `json:"engine"`
	Database     string           `json:"database"`
	CapturedAt   time.Time        `json:"captured_at"`
	Topology     DatabaseTopology `json:"topology"`
}

type Service interface {
	Meta(context.Context) (Meta, error)
	Connections(context.Context) ([]Connection, error)
	Databases(context.Context, ConnectionRequest) ([]string, error)
	AddConnection(context.Context, ConnectionRequest) (Connection, error)
	UpdateConnection(context.Context, string, ConnectionRequest) (Connection, error)
	ConnectionProfile(context.Context, string) (ConnectionRequest, error)
	TestConnection(context.Context, ConnectionRequest) error
	DisconnectConnection(context.Context, string) (Connection, error)
	ReconnectConnection(context.Context, string, string) (Connection, error)
	RemoveConnection(context.Context, string) error
	Catalog(context.Context, string) (Catalog, error)
	Topology(context.Context, string) (DatabaseTopology, error)
	Table(context.Context, string, string, string, int) (TableSnapshot, error)
	TablePage(context.Context, TablePageRequest) (TableSnapshot, error)
	Query(context.Context, QueryRequest) (QueryResult, error)
	Explain(context.Context, QueryRequest) (ExplainResult, error)
	SchemaSnapshot(context.Context, string) (SchemaSnapshot, error)
}
