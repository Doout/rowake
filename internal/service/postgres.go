package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

const postgresStatementTimeout = 15 * time.Second

func (s *Service) Databases(ctx context.Context, request app.ConnectionRequest) ([]string, error) {
	engine := strings.ToLower(strings.TrimSpace(request.Engine))
	if engine != "postgres" && engine != "postgresql" {
		return nil, errors.New("database discovery is available for PostgreSQL")
	}
	config, err := postgresConfig(request, discoveryDatabase(request))
	if err != nil {
		return nil, err
	}
	database, cleanup, err := openPostgres(ctx, config)
	if err != nil {
		return nil, err
	}
	defer cleanup()

	queryCtx, cancel := context.WithTimeout(ctx, postgresStatementTimeout)
	defer cancel()
	rows, err := database.QueryContext(queryCtx, `
		SELECT datname
		FROM pg_catalog.pg_database
		WHERE datallowconn
		  AND NOT datistemplate
		  AND pg_catalog.has_database_privilege(datname, 'CONNECT')
		ORDER BY datname`)
	if err != nil {
		return nil, fmt.Errorf("list PostgreSQL databases: %w", err)
	}
	defer rows.Close()

	databases := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan PostgreSQL database: %w", err)
		}
		databases = append(databases, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list PostgreSQL databases: %w", err)
	}
	return databases, nil
}

func (s *Service) addPostgresConnection(ctx context.Context, request app.ConnectionRequest, save bool) (app.Connection, error) {
	if strings.TrimSpace(request.DataSourceName) == "" && strings.TrimSpace(request.Database) == "" {
		return app.Connection{}, errors.New("PostgreSQL database is required")
	}
	config, err := postgresConfig(request, "")
	if err != nil {
		return app.Connection{}, err
	}
	if strings.TrimSpace(config.Database) == "" {
		return app.Connection{}, errors.New("PostgreSQL database is required")
	}
	identity := postgresIdentity(config)

	s.mu.RLock()
	for _, state := range s.connections {
		if state.info.Engine == "postgres" && state.identity == identity {
			s.mu.RUnlock()
			return app.Connection{}, errors.New("this PostgreSQL database is already connected")
		}
	}
	s.mu.RUnlock()

	database, cleanup, err := openPostgres(ctx, config)
	if err != nil {
		return app.Connection{}, sanitizeConnectionError(err, request)
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		name = config.Database
	}
	address := postgresAddress(config)

	s.mu.Lock()
	defer s.mu.Unlock()
	for _, state := range s.connections {
		if state.info.Engine == "postgres" && state.identity == identity {
			cleanup()
			return app.Connection{}, errors.New("this PostgreSQL database is already connected")
		}
	}
	s.nextID++
	connection := app.Connection{
		ID:       fmt.Sprintf("postgres-%d", s.nextID),
		Name:     name,
		Engine:   "postgres",
		Address:  address,
		Database: config.Database,
		Status:   "connected",
		ReadOnly: true,
	}
	profile := postgresProfileFromConfig(request, name, config)
	if save && s.storePath != "" {
		saved := upsertSavedConnection(s.saved, persistentConnectionRequest(profile))
		if err := writeConnectionStore(s.storePath, saved); err != nil {
			cleanup()
			return app.Connection{}, fmt.Errorf("save connection profile: %w", err)
		}
		s.saved = saved
	}
	s.connections[connection.ID] = &connectionState{
		info:     connection,
		request:  profile,
		database: database,
		identity: identity,
		cleanup:  cleanup,
	}
	s.order = append(s.order, connection.ID)
	return connection, nil
}

func postgresConfig(request app.ConnectionRequest, databaseOverride string) (*pgx.ConnConfig, error) {
	var (
		config *pgx.ConnConfig
		err    error
	)
	if source := strings.TrimSpace(request.DataSourceName); source != "" {
		config, err = pgx.ParseConfig(source)
		if err != nil {
			return nil, fmt.Errorf("parse PostgreSQL connection: %w", err)
		}
		if request.Password != "" || request.PasswordEnv != "" || request.SecretService != "" || request.SecretAccount != "" {
			password, passwordErr := resolvePostgresPassword(request)
			if passwordErr != nil {
				return nil, passwordErr
			}
			config.Password = password
		}
	} else {
		host := strings.TrimSpace(request.Host)
		if host == "" {
			return nil, errors.New("PostgreSQL host is required")
		}
		username := strings.TrimSpace(request.Username)
		if username == "" {
			return nil, errors.New("PostgreSQL username is required")
		}
		port := request.Port
		if port == 0 {
			port = 5432
		}
		if port < 1 || port > 65535 {
			return nil, errors.New("PostgreSQL port must be between 1 and 65535")
		}
		sslMode := strings.ToLower(strings.TrimSpace(request.SSLMode))
		if sslMode == "" {
			sslMode = "prefer"
		}
		if !validPostgresSSLMode(sslMode) {
			return nil, errors.New("PostgreSQL SSL mode is invalid")
		}
		databaseName := strings.TrimSpace(request.Database)
		if strings.TrimSpace(databaseOverride) != "" {
			databaseName = strings.TrimSpace(databaseOverride)
		}
		password, passwordErr := resolvePostgresPassword(request)
		if passwordErr != nil {
			return nil, passwordErr
		}
		endpoint := &url.URL{
			Scheme: "postgres",
			User:   url.UserPassword(username, password),
			Host:   net.JoinHostPort(host, strconv.Itoa(port)),
			Path:   "/" + databaseName,
		}
		query := endpoint.Query()
		query.Set("sslmode", sslMode)
		endpoint.RawQuery = query.Encode()
		config, err = pgx.ParseConfig(endpoint.String())
		if err != nil {
			return nil, fmt.Errorf("configure PostgreSQL connection: %w", err)
		}
	}
	if override := strings.TrimSpace(databaseOverride); override != "" {
		config.Database = override
	}
	if config.RuntimeParams == nil {
		config.RuntimeParams = make(map[string]string)
	}
	config.RuntimeParams["application_name"] = "rowake"
	config.RuntimeParams["default_transaction_read_only"] = "on"
	config.RuntimeParams["statement_timeout"] = strconv.FormatInt(postgresStatementTimeout.Milliseconds(), 10)
	config.ConnectTimeout = 5 * time.Second
	return config, nil
}

func postgresProfileFromConfig(request app.ConnectionRequest, name string, config *pgx.ConnConfig) app.ConnectionRequest {
	sslMode := strings.ToLower(strings.TrimSpace(request.SSLMode))
	if sslMode == "" {
		sslMode = "prefer"
	}
	return app.ConnectionRequest{
		Name:          name,
		Engine:        "postgres",
		Host:          config.Host,
		Port:          int(config.Port),
		Username:      config.User,
		Password:      config.Password,
		PasswordEnv:   strings.TrimSpace(request.PasswordEnv),
		SecretService: strings.TrimSpace(request.SecretService),
		SecretAccount: strings.TrimSpace(request.SecretAccount),
		Database:      config.Database,
		SSLMode:       sslMode,
	}
}

func resolvePostgresPassword(request app.ConnectionRequest) (string, error) {
	if request.Password != "" {
		return request.Password, nil
	}
	if name := strings.TrimSpace(request.PasswordEnv); name != "" {
		password, ok := os.LookupEnv(name)
		if !ok {
			return "", fmt.Errorf("password environment variable %s is not set", name)
		}
		return password, nil
	}
	serviceName := strings.TrimSpace(request.SecretService)
	account := strings.TrimSpace(request.SecretAccount)
	if serviceName == "" && account == "" {
		return "", nil
	}
	if serviceName == "" || account == "" {
		return "", errors.New("OS secret service and account are both required")
	}
	secretCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.CommandContext(secretCtx, "security", "find-generic-password", "-s", serviceName, "-a", account, "-w")
	case "linux":
		command = exec.CommandContext(secretCtx, "secret-tool", "lookup", "service", serviceName, "account", account)
	default:
		return "", fmt.Errorf("OS secret references are not supported on %s", runtime.GOOS)
	}
	output, err := command.Output()
	if err != nil {
		return "", errors.New("read password from the OS secret store")
	}
	password := strings.TrimSpace(string(output))
	if password == "" {
		return "", errors.New("OS secret store returned an empty password")
	}
	return password, nil
}

func discoveryDatabase(request app.ConnectionRequest) string {
	if strings.TrimSpace(request.DataSourceName) != "" {
		return ""
	}
	if database := strings.TrimSpace(request.Database); database != "" {
		return database
	}
	return "postgres"
}

func validPostgresSSLMode(value string) bool {
	switch value {
	case "disable", "allow", "prefer", "require", "verify-ca", "verify-full":
		return true
	default:
		return false
	}
}

func postgresAddress(config *pgx.ConnConfig) string {
	if config.Port == 0 {
		return config.Host
	}
	return net.JoinHostPort(config.Host, strconv.Itoa(int(config.Port)))
}

func postgresIdentity(config *pgx.ConnConfig) string {
	return strings.Join([]string{
		config.User,
		postgresAddress(config),
		config.Database,
	}, "\x00")
}

func openPostgres(ctx context.Context, config *pgx.ConnConfig) (*sql.DB, func(), error) {
	registered := stdlib.RegisterConnConfig(config)
	database, err := db.Open(ctx, db.OpenOptions{
		Driver:          "pgx",
		DataSourceName:  registered,
		MaxOpen:         4,
		MaxIdle:         1,
		ConnectionTTL:   30 * time.Minute,
		ConnectionProbe: 5 * time.Second,
	})
	if err != nil {
		stdlib.UnregisterConnConfig(registered)
		return nil, nil, err
	}
	cleanup := func() {
		_ = database.Close()
		stdlib.UnregisterConnConfig(registered)
	}
	var readOnly string
	if err := database.QueryRowContext(ctx, "SHOW default_transaction_read_only").Scan(&readOnly); err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("verify PostgreSQL read-only session: %w", err)
	}
	if readOnly != "on" {
		cleanup()
		return nil, nil, errors.New("PostgreSQL connection did not enter read-only mode")
	}
	return database, cleanup, nil
}

func postgresCatalog(ctx context.Context, database *sql.DB, connectionID string) (app.Catalog, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT namespace.nspname,
		       relation.relname,
		       CASE relation.relkind
		         WHEN 'v' THEN 'view'
		         WHEN 'm' THEN 'view'
		         ELSE 'table'
		       END
		FROM pg_catalog.pg_class AS relation
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
		  AND namespace.nspname <> 'information_schema'
		  AND namespace.nspname NOT LIKE 'pg\_%' ESCAPE '\'
		ORDER BY namespace.nspname, relation.relname`)
	if err != nil {
		return app.Catalog{}, fmt.Errorf("read PostgreSQL catalog: %w", err)
	}
	defer rows.Close()

	schemas := make([]app.Schema, 0)
	schemaIndex := make(map[string]int)
	for rows.Next() {
		var schemaName string
		var table app.Table
		if err := rows.Scan(&schemaName, &table.Name, &table.Kind); err != nil {
			return app.Catalog{}, fmt.Errorf("scan PostgreSQL catalog: %w", err)
		}
		table.Schema = schemaName
		index, ok := schemaIndex[schemaName]
		if !ok {
			index = len(schemas)
			schemaIndex[schemaName] = index
			schemas = append(schemas, app.Schema{Name: schemaName, Tables: make([]app.Table, 0)})
		}
		schemas[index].Tables = append(schemas[index].Tables, table)
	}
	if err := rows.Err(); err != nil {
		return app.Catalog{}, fmt.Errorf("read PostgreSQL catalog: %w", err)
	}
	return app.Catalog{ConnectionID: connectionID, Schemas: schemas}, nil
}

func postgresTopology(ctx context.Context, database *sql.DB, connectionID string) (app.DatabaseTopology, error) {
	catalog, err := postgresCatalog(ctx, database, connectionID)
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
			columns, primaryKey, err := postgresColumns(ctx, database, schema.Name, table.Name)
			if err != nil {
				return app.DatabaseTopology{}, err
			}
			indexes, err := postgresIndexes(ctx, database, schema.Name, table.Name)
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
			relationships, err := postgresRelationships(ctx, database, schema.Name, table.Name)
			if err != nil {
				return app.DatabaseTopology{}, err
			}
			topology.Relationships = append(topology.Relationships, relationships...)
		}
	}
	return topology, nil
}

func verifyPostgresTable(ctx context.Context, database *sql.DB, schema, table string) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("table is required")
	}
	var found string
	err := database.QueryRowContext(ctx, `
		SELECT relation.relname
		FROM pg_catalog.pg_class AS relation
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = $1
		  AND relation.relname = $2
		  AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')`,
		schema, table,
	).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("table was not found")
	}
	if err != nil {
		return fmt.Errorf("find PostgreSQL table: %w", err)
	}
	return nil
}

func postgresColumns(
	ctx context.Context,
	database *sql.DB,
	schema, table string,
) ([]app.Column, []string, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT attribute.attname,
		       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
		       NOT attribute.attnotnull,
		       COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid), '')
		FROM pg_catalog.pg_attribute AS attribute
		JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		LEFT JOIN pg_catalog.pg_attrdef AS default_value
		  ON default_value.adrelid = attribute.attrelid
		 AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = $1
		  AND relation.relname = $2
		  AND attribute.attnum > 0
		  AND NOT attribute.attisdropped
		ORDER BY attribute.attnum`,
		schema, table,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("read PostgreSQL table columns: %w", err)
	}
	defer rows.Close()

	columns := make([]app.Column, 0)
	for rows.Next() {
		var column app.Column
		if err := rows.Scan(&column.Name, &column.DataType, &column.Nullable, &column.Default); err != nil {
			return nil, nil, fmt.Errorf("scan PostgreSQL table column: %w", err)
		}
		columns = append(columns, column)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read PostgreSQL table columns: %w", err)
	}

	primaryRows, err := database.QueryContext(ctx, `
		SELECT attribute.attname
		FROM pg_catalog.pg_index AS index_metadata
		JOIN pg_catalog.pg_class AS relation ON relation.oid = index_metadata.indrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN LATERAL unnest(index_metadata.indkey) WITH ORDINALITY AS key(attnum, ordinal) ON true
		JOIN pg_catalog.pg_attribute AS attribute
		  ON attribute.attrelid = index_metadata.indrelid
		 AND attribute.attnum = key.attnum
		WHERE namespace.nspname = $1
		  AND relation.relname = $2
		  AND index_metadata.indisprimary
		ORDER BY key.ordinal`,
		schema, table,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("read PostgreSQL primary key: %w", err)
	}
	defer primaryRows.Close()
	primaryKey := make([]string, 0)
	for primaryRows.Next() {
		var name string
		if err := primaryRows.Scan(&name); err != nil {
			return nil, nil, fmt.Errorf("scan PostgreSQL primary key: %w", err)
		}
		primaryKey = append(primaryKey, name)
	}
	if err := primaryRows.Err(); err != nil {
		return nil, nil, fmt.Errorf("read PostgreSQL primary key: %w", err)
	}
	primarySet := make(map[string]bool, len(primaryKey))
	for _, name := range primaryKey {
		primarySet[name] = true
	}
	for index := range columns {
		columns[index].PrimaryKey = primarySet[columns[index].Name]
	}
	return columns, primaryKey, nil
}

func postgresIndexes(ctx context.Context, database *sql.DB, schema, table string) ([]app.Index, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT index_relation.relname,
		       index_metadata.indisunique,
		       pg_catalog.pg_get_indexdef(index_metadata.indexrelid),
		       COALESCE((
		         SELECT json_agg(
		           pg_catalog.pg_get_indexdef(index_metadata.indexrelid, ordinal, true)
		           ORDER BY ordinal
		         )::text
		         FROM generate_series(1, index_metadata.indnkeyatts) AS ordinal
		       ), '[]')
		FROM pg_catalog.pg_index AS index_metadata
		JOIN pg_catalog.pg_class AS relation ON relation.oid = index_metadata.indrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
		WHERE namespace.nspname = $1
		  AND relation.relname = $2
		ORDER BY index_relation.relname`,
		schema, table,
	)
	if err != nil {
		return nil, fmt.Errorf("read PostgreSQL indexes: %w", err)
	}
	defer rows.Close()
	indexes := make([]app.Index, 0)
	for rows.Next() {
		var (
			index       app.Index
			columnsJSON string
		)
		if err := rows.Scan(&index.Name, &index.Unique, &index.Definition, &columnsJSON); err != nil {
			return nil, fmt.Errorf("scan PostgreSQL index: %w", err)
		}
		if err := json.Unmarshal([]byte(columnsJSON), &index.Columns); err != nil {
			return nil, fmt.Errorf("decode PostgreSQL index columns: %w", err)
		}
		indexes = append(indexes, index)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read PostgreSQL indexes: %w", err)
	}
	return indexes, nil
}

func postgresRelationships(
	ctx context.Context,
	database *sql.DB,
	schema, table string,
) ([]app.TopologyRelationship, error) {
	rows, err := database.QueryContext(ctx, `
		SELECT foreign_key.oid::text,
		       source_namespace.nspname,
		       source_relation.relname,
		       source_attribute.attname,
		       target_namespace.nspname,
		       target_relation.relname,
		       target_attribute.attname,
		       CASE foreign_key.confupdtype
		         WHEN 'a' THEN 'NO ACTION'
		         WHEN 'r' THEN 'RESTRICT'
		         WHEN 'c' THEN 'CASCADE'
		         WHEN 'n' THEN 'SET NULL'
		         WHEN 'd' THEN 'SET DEFAULT'
		       END,
		       CASE foreign_key.confdeltype
		         WHEN 'a' THEN 'NO ACTION'
		         WHEN 'r' THEN 'RESTRICT'
		         WHEN 'c' THEN 'CASCADE'
		         WHEN 'n' THEN 'SET NULL'
		         WHEN 'd' THEN 'SET DEFAULT'
		       END,
		       source_key.ordinal
		FROM pg_catalog.pg_constraint AS foreign_key
		JOIN pg_catalog.pg_class AS source_relation ON source_relation.oid = foreign_key.conrelid
		JOIN pg_catalog.pg_namespace AS source_namespace ON source_namespace.oid = source_relation.relnamespace
		JOIN pg_catalog.pg_class AS target_relation ON target_relation.oid = foreign_key.confrelid
		JOIN pg_catalog.pg_namespace AS target_namespace ON target_namespace.oid = target_relation.relnamespace
		JOIN LATERAL unnest(foreign_key.conkey) WITH ORDINALITY AS source_key(attnum, ordinal) ON true
		JOIN LATERAL unnest(foreign_key.confkey) WITH ORDINALITY AS target_key(attnum, ordinal)
		  ON target_key.ordinal = source_key.ordinal
		JOIN pg_catalog.pg_attribute AS source_attribute
		  ON source_attribute.attrelid = source_relation.oid
		 AND source_attribute.attnum = source_key.attnum
		JOIN pg_catalog.pg_attribute AS target_attribute
		  ON target_attribute.attrelid = target_relation.oid
		 AND target_attribute.attnum = target_key.attnum
		WHERE foreign_key.contype = 'f'
		  AND source_namespace.nspname = $1
		  AND source_relation.relname = $2
		ORDER BY foreign_key.oid, source_key.ordinal`,
		schema, table,
	)
	if err != nil {
		return nil, fmt.Errorf("read PostgreSQL relationships: %w", err)
	}
	defer rows.Close()
	relationships := make([]app.TopologyRelationship, 0)
	for rows.Next() {
		var (
			constraintID string
			ordinal      int
			relationship app.TopologyRelationship
		)
		if err := rows.Scan(
			&constraintID,
			&relationship.FromSchema,
			&relationship.FromTable,
			&relationship.FromColumn,
			&relationship.ToSchema,
			&relationship.ToTable,
			&relationship.ToColumn,
			&relationship.OnUpdate,
			&relationship.OnDelete,
			&ordinal,
		); err != nil {
			return nil, fmt.Errorf("scan PostgreSQL relationship: %w", err)
		}
		relationship.ID = fmt.Sprintf("%s.%s-fk-%s-%d", schema, table, constraintID, ordinal)
		relationship.ConstraintID = fmt.Sprintf("%s.%s-fk-%s", schema, table, constraintID)
		relationships = append(relationships, relationship)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read PostgreSQL relationships: %w", err)
	}
	return relationships, nil
}
