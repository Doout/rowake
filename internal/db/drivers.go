package db

import (
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/ncruces/go-sqlite3/driver"
)

func init() {
	Register(Driver{
		Engine:          "mysql",
		DisplayName:     "MySQL / MariaDB",
		DatabaseSQLName: "mysql",
	})
	Register(Driver{
		Engine:          "postgres",
		DisplayName:     "PostgreSQL",
		DatabaseSQLName: "pgx",
	})
	Register(Driver{
		Engine:          "sqlite",
		DisplayName:     "SQLite",
		DatabaseSQLName: "sqlite3",
	})
}
