package service

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/Doout/rowake/internal/app"
)

const (
	tablePageTimeout   = 15 * time.Second
	tablePageByteLimit = 4 << 20
)

type tableCursor struct {
	Offset    int    `json:"offset,omitempty"`
	Values    []any  `json:"values,omitempty"`
	Direction string `json:"direction,omitempty"`
}

func (s *Service) TablePage(ctx context.Context, request app.TablePageRequest) (app.TableSnapshot, error) {
	connection, err := s.connection(request.ConnectionID)
	if err != nil {
		return app.TableSnapshot{}, err
	}
	if connection.database == nil {
		return app.TableSnapshot{}, errors.New("database connection is disconnected")
	}
	request.Schema = strings.TrimSpace(request.Schema)
	request.Table = strings.TrimSpace(request.Table)
	if request.Schema == "" || request.Table == "" {
		return app.TableSnapshot{}, errors.New("schema and table are required")
	}
	if connection.info.Engine == "sqlite" && request.Schema != "main" {
		return app.TableSnapshot{}, errors.New("SQLite table must use the main schema")
	}

	queryCtx, cancel := context.WithTimeout(ctx, boundedTimeout(request.TimeoutSeconds))
	defer cancel()
	started := time.Now()
	if connection.info.Engine == "postgres" {
		if err := verifyPostgresTable(queryCtx, connection.database, request.Schema, request.Table); err != nil {
			return app.TableSnapshot{}, err
		}
	} else if err := verifySQLiteTable(queryCtx, connection.database, request.Table); err != nil {
		return app.TableSnapshot{}, err
	}

	var columns []app.Column
	var primaryKey []string
	var indexes []app.Index
	if connection.info.Engine == "postgres" {
		columns, primaryKey, err = postgresColumns(queryCtx, connection.database, request.Schema, request.Table)
		if err == nil {
			indexes, err = postgresIndexes(queryCtx, connection.database, request.Schema, request.Table)
		}
	} else {
		columns, primaryKey, err = sqliteColumns(queryCtx, connection.database, request.Table)
		if err == nil {
			indexes, err = sqliteIndexes(queryCtx, connection.database, request.Table)
		}
	}
	if err != nil {
		return app.TableSnapshot{}, err
	}

	limit := normalizeLimit(request.Limit)
	cursor, err := decodeTableCursor(request.Cursor)
	if err != nil {
		return app.TableSnapshot{}, err
	}
	statement, arguments, normalizedFilters, normalizedSort, err := buildTablePageStatement(
		connection.info.Engine, request, columns, primaryKey, limit+1, cursor,
	)
	if err != nil {
		return app.TableSnapshot{}, err
	}
	rows, err := connection.database.QueryContext(queryCtx, statement, arguments...)
	if err != nil {
		return app.TableSnapshot{}, fmt.Errorf("read table page: %w", err)
	}
	values, hasExtra, byteLimited, err := readRowsBounded(rows, limit, tablePageByteLimit)
	if err != nil {
		return app.TableSnapshot{}, err
	}
	keyset := len(primaryKey) > 0 && normalizedSort == nil
	hasMore := hasExtra || byteLimited
	nextCursor, previousCursor := "", ""
	if keyset {
		if cursor.Direction == "previous" {
			reverseRows(values)
			hasMore = len(cursor.Values) > 0
		}
		if len(values) > 0 {
			if hasMore {
				nextCursor = encodeKeysetCursor(rowCursorValues(values[len(values)-1], columns, primaryKey), "next")
			}
			if len(cursor.Values) > 0 && (cursor.Direction != "previous" || hasExtra || byteLimited) {
				previousCursor = encodeKeysetCursor(rowCursorValues(values[0], columns, primaryKey), "previous")
			}
			if cursor.Direction == "previous" {
				nextCursor = encodeKeysetCursor(rowCursorValues(values[len(values)-1], columns, primaryKey), "next")
			}
		}
	} else {
		hasMore = hasExtra || byteLimited
		if hasMore && len(values) > 0 {
			nextCursor = encodeTableCursor(cursor.Offset + len(values))
		}
		if cursor.Offset > 0 {
			previousCursor = encodeTableCursor(max(0, cursor.Offset-limit))
		}
	}

	return app.TableSnapshot{
		ConnectionID:   request.ConnectionID,
		Schema:         request.Schema,
		Name:           request.Table,
		Columns:        columns,
		Indexes:        indexes,
		Rows:           values,
		RowCount:       len(values),
		Truncated:      hasMore || cursor.Offset > 0 || len(cursor.Values) > 0,
		HasMore:        hasMore,
		NextCursor:     nextCursor,
		PreviousCursor: previousCursor,
		CapturedAt:     time.Now().UTC(),
		ByteLimited:    byteLimited,
		Filters:        normalizedFilters,
		Sort:           normalizedSort,
		DurationMS:     durationMilliseconds(time.Since(started)),
		PrimaryKey:     primaryKey,
		Capabilities:   app.Capability{CanQuery: true, CanExplain: true, CanWrite: false, CanEdit: false},
	}, nil
}

func boundedTimeout(seconds int) time.Duration {
	if seconds <= 0 {
		return tablePageTimeout
	}
	if seconds > int(tablePageTimeout/time.Second) {
		seconds = int(tablePageTimeout / time.Second)
	}
	return time.Duration(seconds) * time.Second
}

func buildTablePageStatement(
	engine string,
	request app.TablePageRequest,
	columns []app.Column,
	primaryKey []string,
	rowLimit int,
	cursor tableCursor,
) (string, []any, []app.TableFilter, *app.TableSort, error) {
	columnByName := make(map[string]app.Column, len(columns))
	for _, column := range columns {
		columnByName[column.Name] = column
	}
	arguments := make([]any, 0, len(request.Filters)+2)
	placeholder := func(value any) string {
		arguments = append(arguments, value)
		if engine == "postgres" {
			return "$" + strconv.Itoa(len(arguments))
		}
		return "?"
	}

	where := make([]string, 0, len(request.Filters))
	normalizedFilters := make([]app.TableFilter, 0, len(request.Filters))
	for _, filter := range request.Filters {
		filter.Column = strings.TrimSpace(filter.Column)
		filter.Operator = strings.ToLower(strings.TrimSpace(filter.Operator))
		column, ok := columnByName[filter.Column]
		if !ok {
			return "", nil, nil, nil, fmt.Errorf("filter column %q was not found", filter.Column)
		}
		identifier := quoteIdentifier(filter.Column)
		switch filter.Operator {
		case "is-null":
			where = append(where, identifier+" IS NULL")
		case "is-not-null":
			where = append(where, identifier+" IS NOT NULL")
		case "contains", "not-contains", "starts-with", "ends-with":
			value := escapeLikeValue(filter.Value)
			if filter.Operator == "contains" || filter.Operator == "not-contains" {
				value = "%" + value + "%"
			} else if filter.Operator == "starts-with" {
				value += "%"
			} else {
				value = "%" + value
			}
			expression := "LOWER(CAST(" + identifier + " AS TEXT)) LIKE LOWER(" + placeholder(value) + ") ESCAPE '\\'"
			if filter.Operator == "not-contains" {
				expression = "NOT (" + expression + ")"
			}
			where = append(where, expression)
		case "equals", "not-equals", "greater", "greater-equal", "less", "less-equal":
			operator := map[string]string{
				"equals": "=", "not-equals": "<>", "greater": ">", "greater-equal": ">=", "less": "<", "less-equal": "<=",
			}[filter.Operator]
			where = append(where, identifier+" "+operator+" "+placeholder(coerceFilterValue(column, filter.Value)))
		default:
			return "", nil, nil, nil, fmt.Errorf("filter operator %q is not supported", filter.Operator)
		}
		normalizedFilters = append(normalizedFilters, filter)
	}

	var normalizedSort *app.TableSort
	order := make([]string, 0, len(primaryKey)+1)
	if request.Sort != nil && strings.TrimSpace(request.Sort.Column) != "" {
		sortValue := *request.Sort
		sortValue.Column = strings.TrimSpace(sortValue.Column)
		sortValue.Direction = strings.ToLower(strings.TrimSpace(sortValue.Direction))
		if _, ok := columnByName[sortValue.Column]; !ok {
			return "", nil, nil, nil, fmt.Errorf("sort column %q was not found", sortValue.Column)
		}
		if sortValue.Direction != "desc" {
			sortValue.Direction = "asc"
		}
		order = append(order, quoteIdentifier(sortValue.Column)+" "+strings.ToUpper(sortValue.Direction))
		normalizedSort = &sortValue
	}
	for _, key := range primaryKey {
		if normalizedSort == nil || key != normalizedSort.Column {
			order = append(order, quoteIdentifier(key)+" ASC")
		}
	}
	keyset := len(primaryKey) > 0 && normalizedSort == nil
	if len(cursor.Values) > 0 {
		if !keyset || len(cursor.Values) != len(primaryKey) || (cursor.Direction != "next" && cursor.Direction != "previous") {
			return "", nil, nil, nil, errors.New("table cursor does not match the requested ordering")
		}
		predicate, predicateErr := buildKeysetPredicate(primaryKey, cursor, placeholder)
		if predicateErr != nil {
			return "", nil, nil, nil, predicateErr
		}
		where = append(where, predicate)
		if cursor.Direction == "previous" {
			for index := range order {
				order[index] = strings.TrimSuffix(order[index], " ASC") + " DESC"
			}
		}
	}
	if len(order) == 0 && len(columns) > 0 {
		order = append(order, quoteIdentifier(columns[0].Name)+" ASC")
	}

	statement := "SELECT * FROM " + qualifiedName(request.Schema, request.Table)
	if len(where) > 0 {
		statement += " WHERE " + strings.Join(where, " AND ")
	}
	if len(order) > 0 {
		statement += " ORDER BY " + strings.Join(order, ", ")
	}
	statement += " LIMIT " + placeholder(rowLimit)
	if !keyset {
		statement += " OFFSET " + placeholder(cursor.Offset)
	}
	return statement, arguments, normalizedFilters, normalizedSort, nil
}

func buildKeysetPredicate(columns []string, cursor tableCursor, placeholder func(any) string) (string, error) {
	comparison := ">"
	if cursor.Direction == "previous" {
		comparison = "<"
	}
	branches := make([]string, 0, len(columns))
	for index, column := range columns {
		if cursor.Values[index] == nil {
			return "", errors.New("table cursor contains a null primary-key value")
		}
		parts := make([]string, 0, index+1)
		for prior := 0; prior < index; prior++ {
			parts = append(parts, quoteIdentifier(columns[prior])+" = "+placeholder(cursor.Values[prior]))
		}
		parts = append(parts, quoteIdentifier(column)+" "+comparison+" "+placeholder(cursor.Values[index]))
		branches = append(branches, "("+strings.Join(parts, " AND ")+")")
	}
	return "(" + strings.Join(branches, " OR ") + ")", nil
}

func rowCursorValues(row []any, columns []app.Column, keys []string) []any {
	values := make([]any, 0, len(keys))
	for _, key := range keys {
		for index, column := range columns {
			if column.Name == key {
				values = append(values, row[index])
				break
			}
		}
	}
	return values
}

func reverseRows(rows [][]any) {
	for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
		rows[left], rows[right] = rows[right], rows[left]
	}
}

func coerceFilterValue(column app.Column, value string) any {
	typeName := strings.ToLower(column.DataType)
	if strings.Contains(typeName, "bool") {
		if parsed, err := strconv.ParseBool(value); err == nil {
			return parsed
		}
	}
	if strings.Contains(typeName, "int") || strings.Contains(typeName, "serial") {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return parsed
		}
	}
	if strings.Contains(typeName, "numeric") || strings.Contains(typeName, "decimal") ||
		strings.Contains(typeName, "real") || strings.Contains(typeName, "double") || strings.Contains(typeName, "float") {
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
	}
	return value
}

func escapeLikeValue(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func encodeTableCursor(offset int) string {
	encoded, _ := json.Marshal(tableCursor{Offset: offset})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func encodeKeysetCursor(values []any, direction string) string {
	encoded, _ := json.Marshal(tableCursor{Values: values, Direction: direction})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeTableCursor(value string) (tableCursor, error) {
	if strings.TrimSpace(value) == "" {
		return tableCursor{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return tableCursor{}, errors.New("table cursor is invalid")
	}
	var cursor tableCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.Offset < 0 || cursor.Offset > 1_000_000_000 || len(cursor.Values) > 16 {
		return tableCursor{}, errors.New("table cursor is invalid")
	}
	return cursor, nil
}

func readRowsBounded(rows *sql.Rows, limit int, byteLimit int) ([][]any, bool, bool, error) {
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, false, false, fmt.Errorf("read result columns: %w", err)
	}
	values := make([][]any, 0, limit)
	bytesRead := 0
	hasExtra := false
	byteLimited := false
	for rows.Next() {
		row := make([]any, len(names))
		destinations := make([]any, len(names))
		for index := range row {
			destinations[index] = &row[index]
		}
		if err := rows.Scan(destinations...); err != nil {
			return nil, false, false, fmt.Errorf("scan result row: %w", err)
		}
		rowBytes := 0
		for index, value := range row {
			if raw, ok := value.([]byte); ok {
				row[index] = string(raw)
				rowBytes += len(raw)
			} else {
				rowBytes += len(fmt.Sprint(value))
			}
		}
		if len(values) >= limit {
			hasExtra = true
			break
		}
		if byteLimit > 0 && bytesRead+rowBytes > byteLimit {
			byteLimited = true
			break
		}
		bytesRead += rowBytes
		values = append(values, row)
	}
	if err := rows.Err(); err != nil {
		return nil, false, false, fmt.Errorf("read result rows: %w", err)
	}
	return values, hasExtra, byteLimited, nil
}
