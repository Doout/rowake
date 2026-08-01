package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
)

func (s *Service) Catalog(ctx context.Context, connectionID string) (app.Catalog, error) {
	connection, err := s.connection(connectionID)
	if err != nil {
		return app.Catalog{}, err
	}
	if connection.database == nil {
		return app.Catalog{}, errors.New("database connection is disconnected")
	}
	if connection.info.Engine == "postgres" {
		return postgresCatalog(ctx, connection.database, connectionID)
	}
	return sqliteCatalog(ctx, connection.database, connectionID)
}

func sqliteCatalog(ctx context.Context, database *sql.DB, connectionID string) (app.Catalog, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT name, type
		FROM sqlite_schema
		WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
		ORDER BY name`)
	if err != nil {
		return app.Catalog{}, fmt.Errorf("read SQLite catalog: %w", err)
	}
	defer rows.Close()

	tables := make([]app.Table, 0)
	for rows.Next() {
		var table app.Table
		if err := rows.Scan(&table.Name, &table.Kind); err != nil {
			return app.Catalog{}, fmt.Errorf("scan SQLite catalog: %w", err)
		}
		table.Schema = "main"
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		return app.Catalog{}, fmt.Errorf("read SQLite catalog: %w", err)
	}
	return app.Catalog{
		ConnectionID: connectionID,
		Schemas:      []app.Schema{{Name: "main", Tables: tables}},
	}, nil
}

func (s *Service) Topology(ctx context.Context, connectionID string) (app.DatabaseTopology, error) {
	connection, err := s.connection(connectionID)
	if err != nil {
		return app.DatabaseTopology{}, err
	}
	if connection.database == nil {
		return app.DatabaseTopology{}, errors.New("database connection is disconnected")
	}
	if connection.info.Engine == "postgres" {
		return postgresTopology(ctx, connection.database, connectionID)
	}
	catalog, err := s.Catalog(ctx, connectionID)
	if err != nil {
		return app.DatabaseTopology{}, err
	}
	topology := app.DatabaseTopology{
		ConnectionID:  connectionID,
		Tables:        make([]app.TopologyTable, 0),
		Relationships: make([]app.TopologyRelationship, 0),
	}
	for _, schema := range catalog.Schemas {
		for _, table := range schema.Tables {
			columns, primaryKey, err := sqliteColumns(ctx, connection.database, table.Name)
			if err != nil {
				return app.DatabaseTopology{}, err
			}
			indexes, err := sqliteIndexes(ctx, connection.database, table.Name)
			if err != nil {
				return app.DatabaseTopology{}, err
			}
			topology.Tables = append(topology.Tables, app.TopologyTable{
				ID:         fmt.Sprintf("table-%d", len(topology.Tables)),
				Schema:     schema.Name,
				Name:       table.Name,
				Kind:       table.Kind,
				Columns:    columns,
				Indexes:    indexes,
				PrimaryKey: primaryKey,
			})
			relationships, err := sqliteRelationships(ctx, connection.database, table.Name)
			if err != nil {
				return app.DatabaseTopology{}, err
			}
			topology.Relationships = append(topology.Relationships, relationships...)
		}
	}
	return topology, nil
}

func (s *Service) Table(ctx context.Context, connectionID, schema, table string, limit int) (app.TableSnapshot, error) {
	return s.TablePage(ctx, app.TablePageRequest{
		ConnectionID: connectionID,
		Schema:       schema,
		Table:        table,
		Limit:        limit,
	})
}

func (s *Service) Query(ctx context.Context, request app.QueryRequest) (app.QueryResult, error) {
	statement := strings.TrimSpace(request.SQL)
	if !db.IsReadOnlyStatement(statement) {
		return app.QueryResult{}, errors.New("only one read-only SQL statement can be run")
	}
	connection, err := s.connection(request.ConnectionID)
	if err != nil {
		return app.QueryResult{}, err
	}
	if connection.database == nil {
		return app.QueryResult{}, errors.New("database connection is disconnected")
	}
	queryCtx, cancel := context.WithTimeout(ctx, boundedTimeout(request.TimeoutSeconds))
	defer cancel()
	started := time.Now()

	queryer := interface {
		QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	}(connection.database)
	var transaction *sql.Tx
	if connection.info.Engine == "postgres" {
		transaction, err = connection.database.BeginTx(queryCtx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return app.QueryResult{}, fmt.Errorf("start read-only query: %w", err)
		}
		defer transaction.Rollback()
		queryer = transaction
	}
	rows, err := queryer.QueryContext(queryCtx, statement)
	if err != nil {
		return app.QueryResult{}, fmt.Errorf("run query: %w", err)
	}
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		rows.Close()
		return app.QueryResult{}, fmt.Errorf("read query columns: %w", err)
	}
	columns := make([]app.Column, 0, len(columnTypes))
	for _, columnType := range columnTypes {
		columns = append(columns, app.Column{
			Name:     columnType.Name(),
			DataType: columnType.DatabaseTypeName(),
			Nullable: true,
		})
	}
	limit := normalizeLimit(request.Limit)
	values, err := readRows(rows, limit+1)
	if err != nil {
		return app.QueryResult{}, err
	}
	truncated := len(values) > limit
	if truncated {
		values = values[:limit]
	}
	if transaction != nil {
		if err := transaction.Commit(); err != nil {
			return app.QueryResult{}, fmt.Errorf("finish read-only query: %w", err)
		}
	}
	return app.QueryResult{
		Columns:    columns,
		Rows:       values,
		RowCount:   len(values),
		DurationMS: durationMilliseconds(time.Since(started)),
		Truncated:  truncated,
		Statement:  statement,
		CapturedAt: time.Now().UTC(),
	}, nil
}

func verifySQLiteTable(ctx context.Context, database *sql.DB, table string) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("table is required")
	}
	var found string
	err := database.QueryRowContext(ctx, `
		SELECT name FROM sqlite_schema
		WHERE name = ? AND type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`, table).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("table was not found")
	}
	if err != nil {
		return fmt.Errorf("find table: %w", err)
	}
	return nil
}

func sqliteColumns(ctx context.Context, database *sql.DB, table string) ([]app.Column, []string, error) {
	rows, err := database.QueryContext(ctx, "PRAGMA main.table_info("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, nil, fmt.Errorf("read table columns: %w", err)
	}
	defer rows.Close()

	type keyedColumn struct {
		ordinal int
		name    string
	}
	columns := make([]app.Column, 0)
	primary := make([]keyedColumn, 0)
	for rows.Next() {
		var (
			ignoredCID int
			name       string
			dataType   string
			notNull    int
			defaultSQL sql.NullString
			primaryKey int
		)
		if err := rows.Scan(&ignoredCID, &name, &dataType, &notNull, &defaultSQL, &primaryKey); err != nil {
			return nil, nil, fmt.Errorf("scan table columns: %w", err)
		}
		column := app.Column{
			Name:       name,
			DataType:   dataType,
			Nullable:   notNull == 0 && primaryKey == 0,
			PrimaryKey: primaryKey > 0,
		}
		if defaultSQL.Valid {
			column.Default = defaultSQL.String
		}
		columns = append(columns, column)
		if primaryKey > 0 {
			primary = append(primary, keyedColumn{ordinal: primaryKey, name: name})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read table columns: %w", err)
	}
	primaryKey := make([]string, len(primary))
	for index := 1; index <= len(primary); index++ {
		for _, column := range primary {
			if column.ordinal == index {
				primaryKey[index-1] = column.name
			}
		}
	}
	return columns, primaryKey, nil
}

func sqliteIndexes(ctx context.Context, database *sql.DB, table string) ([]app.Index, error) {
	rows, err := database.QueryContext(ctx, "PRAGMA main.index_list("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, fmt.Errorf("read table indexes: %w", err)
	}

	type indexMetadata struct {
		name   string
		unique bool
	}
	metadata := make([]indexMetadata, 0)
	for rows.Next() {
		var (
			sequence int
			name     string
			unique   int
			origin   string
			partial  int
		)
		if err := rows.Scan(&sequence, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan table index: %w", err)
		}
		metadata = append(metadata, indexMetadata{name: name, unique: unique == 1})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("read table indexes: %w", err)
	}
	rows.Close()

	indexes := make([]app.Index, 0, len(metadata))
	for _, value := range metadata {
		index := app.Index{Name: value.name, Unique: value.unique}
		columnRows, err := database.QueryContext(ctx, "PRAGMA main.index_info("+quoteIdentifier(value.name)+")")
		if err != nil {
			return nil, fmt.Errorf("read index columns: %w", err)
		}
		for columnRows.Next() {
			var sequenceNumber, columnID int
			var columnName sql.NullString
			if err := columnRows.Scan(&sequenceNumber, &columnID, &columnName); err != nil {
				columnRows.Close()
				return nil, fmt.Errorf("scan index columns: %w", err)
			}
			if columnName.Valid {
				index.Columns = append(index.Columns, columnName.String)
			}
		}
		if err := columnRows.Err(); err != nil {
			columnRows.Close()
			return nil, fmt.Errorf("read index columns: %w", err)
		}
		columnRows.Close()
		_ = database.QueryRowContext(ctx,
			"SELECT COALESCE(sql, '') FROM sqlite_schema WHERE type = 'index' AND name = ?", value.name,
		).Scan(&index.Definition)
		indexes = append(indexes, index)
	}
	return indexes, nil
}

func sqliteRelationships(ctx context.Context, database *sql.DB, table string) ([]app.TopologyRelationship, error) {
	rows, err := database.QueryContext(ctx, "PRAGMA main.foreign_key_list("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, fmt.Errorf("read table relationships: %w", err)
	}
	defer rows.Close()

	relationships := make([]app.TopologyRelationship, 0)
	for rows.Next() {
		var (
			foreignKeyID int
			sequence     int
			targetTable  string
			fromColumn   sql.NullString
			toColumn     sql.NullString
			onUpdate     string
			onDelete     string
			match        string
		)
		if err := rows.Scan(
			&foreignKeyID,
			&sequence,
			&targetTable,
			&fromColumn,
			&toColumn,
			&onUpdate,
			&onDelete,
			&match,
		); err != nil {
			return nil, fmt.Errorf("scan table relationship: %w", err)
		}
		relationships = append(relationships, app.TopologyRelationship{
			ID:           fmt.Sprintf("%s-fk-%d-%d", table, foreignKeyID, sequence),
			ConstraintID: fmt.Sprintf("%s-fk-%d", table, foreignKeyID),
			FromSchema:   "main",
			FromTable:    table,
			FromColumn:   fromColumn.String,
			ToSchema:     "main",
			ToTable:      targetTable,
			ToColumn:     toColumn.String,
			OnUpdate:     onUpdate,
			OnDelete:     onDelete,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read table relationships: %w", err)
	}
	return relationships, nil
}

func readRows(rows *sql.Rows, limit int) ([][]any, error) {
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, fmt.Errorf("read result columns: %w", err)
	}
	values := make([][]any, 0)
	for rows.Next() && len(values) < limit {
		row := make([]any, len(names))
		destinations := make([]any, len(names))
		for index := range row {
			destinations[index] = &row[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, fmt.Errorf("scan result row: %w", err)
		}
		for index, value := range row {
			if bytes, ok := value.([]byte); ok {
				row[index] = string(bytes)
			}
		}
		values = append(values, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read result rows: %w", err)
	}
	return values, nil
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func qualifiedName(schema, table string) string {
	return quoteIdentifier(schema) + "." + quoteIdentifier(table)
}

func normalizeLimit(limit int) int {
	if limit < 1 {
		return 100
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}
