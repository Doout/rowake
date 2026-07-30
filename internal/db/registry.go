package db

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

type Driver struct {
	Engine          string `json:"engine"`
	DisplayName     string `json:"display_name"`
	DatabaseSQLName string `json:"database_sql_name"`
}

var registry = struct {
	sync.RWMutex
	drivers map[string]Driver
}{drivers: make(map[string]Driver)}

func Register(driver Driver) {
	driver.Engine = strings.TrimSpace(driver.Engine)
	driver.DisplayName = strings.TrimSpace(driver.DisplayName)
	driver.DatabaseSQLName = strings.TrimSpace(driver.DatabaseSQLName)
	if driver.Engine == "" || driver.DisplayName == "" || driver.DatabaseSQLName == "" {
		panic(fmt.Sprintf("rowake: invalid database driver registration: %#v", driver))
	}

	registry.Lock()
	defer registry.Unlock()
	if _, exists := registry.drivers[driver.Engine]; exists {
		panic(fmt.Sprintf("rowake: database driver %q registered twice", driver.Engine))
	}
	registry.drivers[driver.Engine] = driver
}

func Compiled() []Driver {
	registry.RLock()
	defer registry.RUnlock()
	result := make([]Driver, 0, len(registry.drivers))
	for _, driver := range registry.drivers {
		result = append(result, driver)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Engine < result[j].Engine })
	return result
}
