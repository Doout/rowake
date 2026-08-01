package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
	"github.com/Doout/rowake/internal/db"
)

func (s *Service) Explain(ctx context.Context, request app.QueryRequest) (app.ExplainResult, error) {
	statement := strings.TrimSpace(request.SQL)
	if !db.IsReadOnlyStatement(statement) {
		return app.ExplainResult{}, errors.New("only one read-only SQL statement can be explained")
	}
	if strings.HasPrefix(strings.ToLower(statement), "explain") {
		return app.ExplainResult{}, errors.New("enter the statement without EXPLAIN; Rowake adds the safe explain mode")
	}
	connection, err := s.connection(request.ConnectionID)
	if err != nil {
		return app.ExplainResult{}, err
	}
	if connection.database == nil {
		return app.ExplainResult{}, errors.New("database connection is disconnected")
	}
	queryCtx, cancel := context.WithTimeout(ctx, boundedTimeout(request.TimeoutSeconds))
	defer cancel()
	result := app.ExplainResult{
		Engine:     connection.info.Engine,
		Statement:  statement,
		CapturedAt: time.Now().UTC(),
	}
	if connection.info.Engine == "postgres" {
		result.Nodes, err = explainPostgres(queryCtx, connection.database, statement)
	} else {
		result.Nodes, err = explainSQLite(queryCtx, connection.database, statement)
	}
	if err != nil {
		return app.ExplainResult{}, err
	}
	return result, nil
}

func explainSQLite(ctx context.Context, database *sql.DB, statement string) ([]app.ExplainNode, error) {
	rows, err := database.QueryContext(ctx, "EXPLAIN QUERY PLAN "+statement)
	if err != nil {
		return nil, fmt.Errorf("explain SQLite query: %w", err)
	}
	defer rows.Close()
	nodes := make([]app.ExplainNode, 0)
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			return nil, fmt.Errorf("scan SQLite explain plan: %w", err)
		}
		operation, relation := sqlitePlanIdentity(detail)
		node := app.ExplainNode{
			ID:        strconv.Itoa(id),
			Operation: operation,
			Relation:  relation,
			Detail:    detail,
		}
		if operation == "SCAN" {
			node.Warning = "Full scan"
		}
		if parent != id {
			node.ParentID = strconv.Itoa(parent)
		}
		nodes = append(nodes, node)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read SQLite explain plan: %w", err)
	}
	return nodes, nil
}

func sqlitePlanIdentity(detail string) (string, string) {
	fields := strings.Fields(detail)
	if len(fields) == 0 {
		return "PLAN", ""
	}
	operation := fields[0]
	if len(fields) > 1 && (operation == "SCAN" || operation == "SEARCH") {
		return operation, strings.Trim(fields[1], `"`)
	}
	return operation, ""
}

func explainPostgres(ctx context.Context, database *sql.DB, statement string) ([]app.ExplainNode, error) {
	transaction, err := database.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("start read-only explain: %w", err)
	}
	defer transaction.Rollback()
	var raw []byte
	if err := transaction.QueryRowContext(ctx, "EXPLAIN (FORMAT JSON, ANALYZE FALSE, COSTS TRUE, VERBOSE FALSE) "+statement).Scan(&raw); err != nil {
		return nil, fmt.Errorf("explain PostgreSQL query: %w", err)
	}
	var documents []map[string]any
	if err := json.Unmarshal(raw, &documents); err != nil || len(documents) == 0 {
		return nil, errors.New("decode PostgreSQL explain plan")
	}
	plan, ok := documents[0]["Plan"].(map[string]any)
	if !ok {
		return nil, errors.New("PostgreSQL explain plan did not contain a plan")
	}
	counter := 0
	nodes := []app.ExplainNode{postgresExplainNode(plan, &counter)}
	if err := transaction.Commit(); err != nil {
		return nil, fmt.Errorf("finish read-only explain: %w", err)
	}
	return nodes, nil
}

func postgresExplainNode(value map[string]any, counter *int) app.ExplainNode {
	(*counter)++
	node := app.ExplainNode{
		ID:            strconv.Itoa(*counter),
		Operation:     stringValue(value["Node Type"]),
		Relation:      stringValue(value["Relation Name"]),
		EstimatedRows: numberValue(value["Plan Rows"]),
		TotalCost:     numberValue(value["Total Cost"]),
	}
	if strings.Contains(strings.ToLower(node.Operation), "seq scan") {
		node.Warning = "Sequential scan"
	}
	if filter := stringValue(value["Filter"]); filter != "" {
		node.Detail = "Filter: " + filter
	} else if condition := stringValue(value["Index Cond"]); condition != "" {
		node.Detail = "Index condition: " + condition
	} else if condition := stringValue(value["Hash Cond"]); condition != "" {
		node.Detail = "Hash condition: " + condition
	}
	if children, ok := value["Plans"].([]any); ok {
		for _, child := range children {
			if childMap, ok := child.(map[string]any); ok {
				node.Children = append(node.Children, postgresExplainNode(childMap, counter))
			}
		}
	}
	return node
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}

func numberValue(value any) float64 {
	number, _ := value.(float64)
	return number
}

func (s *Service) SchemaSnapshot(ctx context.Context, connectionID string) (app.SchemaSnapshot, error) {
	connection, err := s.connection(connectionID)
	if err != nil {
		return app.SchemaSnapshot{}, err
	}
	if connection.database == nil {
		return app.SchemaSnapshot{}, errors.New("database connection is disconnected")
	}
	snapshotCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	topology, err := s.Topology(snapshotCtx, connectionID)
	if err != nil {
		return app.SchemaSnapshot{}, err
	}
	return app.SchemaSnapshot{
		Version:      1,
		ConnectionID: connectionID,
		Engine:       connection.info.Engine,
		Database:     connection.info.Database,
		CapturedAt:   time.Now().UTC(),
		Topology:     topology,
	}, nil
}
