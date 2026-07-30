package db

import "testing"

func TestIsReadOnlyStatement(t *testing.T) {
	for _, statement := range []string{
		"select * from users",
		"WITH recent AS (SELECT 1) SELECT * FROM recent",
		"explain select * from orders",
		"pragma table_info(users)",
	} {
		if !IsReadOnlyStatement(statement) {
			t.Fatalf("expected read-only statement: %q", statement)
		}
	}
	for _, statement := range []string{
		"delete from users",
		"update users set role = 'admin'",
		"select 1; drop table users",
		"",
	} {
		if IsReadOnlyStatement(statement) {
			t.Fatalf("expected unsafe statement: %q", statement)
		}
	}
}
