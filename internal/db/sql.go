package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

type OpenOptions struct {
	Driver          string
	DataSourceName  string
	MaxOpen         int
	MaxIdle         int
	ConnectionTTL   time.Duration
	ConnectionProbe time.Duration
}

func Open(ctx context.Context, options OpenOptions) (*sql.DB, error) {
	if strings.TrimSpace(options.Driver) == "" {
		return nil, errors.New("database driver is required")
	}
	if strings.TrimSpace(options.DataSourceName) == "" {
		return nil, errors.New("database data source is required")
	}
	database, err := sql.Open(options.Driver, options.DataSourceName)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if options.MaxOpen > 0 {
		database.SetMaxOpenConns(options.MaxOpen)
	}
	if options.MaxIdle >= 0 {
		database.SetMaxIdleConns(options.MaxIdle)
	}
	if options.ConnectionTTL > 0 {
		database.SetConnMaxLifetime(options.ConnectionTTL)
	}
	probeTimeout := options.ConnectionProbe
	if probeTimeout <= 0 {
		probeTimeout = 5 * time.Second
	}
	probeCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	if err := database.PingContext(probeCtx); err != nil {
		database.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return database, nil
}

func IsReadOnlyStatement(statement string) bool {
	trimmed := strings.TrimSpace(strings.TrimSuffix(statement, ";"))
	if trimmed == "" || strings.Contains(trimmed, ";") {
		return false
	}
	fields := strings.Fields(strings.ToLower(trimmed))
	if len(fields) == 0 {
		return false
	}
	switch fields[0] {
	case "select", "with", "show", "describe", "desc", "explain", "pragma":
		return true
	default:
		return false
	}
}
