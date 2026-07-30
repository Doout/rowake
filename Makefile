SHELL := /bin/sh
GO ?= go

VERSION ?= 0.1.0
COMMIT ?= $(shell git rev-parse --short=12 HEAD 2>/dev/null || printf unknown)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.commit=$(COMMIT) -X main.buildDate=$(BUILD_DATE)
WAILS_VERSION ?= v2.13.0
WAILS_BIN ?= $(shell go env GOPATH)/bin/wails

.PHONY: build web-build run desktop desktop-install desktop-build desktop-dev check test race test-db integration fmt clean smoke drivers driver-check release cross-build docker vuln vuln-install

GOVULNCHECK_VERSION ?= v1.6.0
GOVULNCHECK_BIN ?= $(shell go env GOPATH)/bin/govulncheck

build:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -buildvcs=false -ldflags "$(LDFLAGS)" -o bin/rowake ./cmd/rowake

web-build:
	npm ci
	npm run build:web

run:
	$(GO) run ./cmd/rowake open

desktop-install:
	@if [ ! -x "$(WAILS_BIN)" ]; then \
		echo "installing Wails $(WAILS_VERSION)"; \
		$(GO) install github.com/wailsapp/wails/v2/cmd/wails@$(WAILS_VERSION); \
	fi

desktop-build: desktop-install
	cd desktop-wails && "$(WAILS_BIN)" build -m -nosyncgomod -trimpath -ldflags "-s -w -X github.com/Doout/rowake/internal/launch.Version=$(VERSION)"
	./scripts/build-macos-icon.sh "$(VERSION)"

desktop: desktop-build
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		open desktop-wails/build/bin/Rowake.app; \
	else \
		echo "desktop launch is configured for macOS; the application was built successfully"; \
	fi

desktop-dev: desktop-install
	cd desktop-wails && "$(WAILS_BIN)" dev

fmt:
	gofmt -w $$(find . -name '*.go' -type f)

test:
	$(GO) test ./...
	cd desktop-wails && $(GO) test ./...

race:
	$(GO) test -race ./...
	cd desktop-wails && $(GO) test -race ./...

test-db:
	$(GO) run ./cmd/rowake-testdb -out testdata/rowake-test.sqlite

integration:
	$(GO) test ./internal/db -run TestExternalDrivers -count=1 -v

check:
	test -z "$$(gofmt -l $$(find . -name '*.go' -type f))"
	$(GO) mod verify
	cd desktop-wails && $(GO) mod verify
	$(GO) mod tidy -diff
	cd desktop-wails && $(GO) mod tidy -diff
	$(GO) test ./...
	cd desktop-wails && $(GO) test ./...
	$(GO) vet ./...
	cd desktop-wails && $(GO) vet ./...
	node --check webembed/dist/app.js
	sh -n scripts/*.sh

driver-check: build
	./scripts/check-drivers.sh ./bin/rowake

smoke: driver-check test-db
	./scripts/smoke.sh

drivers: build
	./bin/rowake drivers

vuln-install:
	@if [ ! -x "$(GOVULNCHECK_BIN)" ] || ! "$(GOVULNCHECK_BIN)" -version 2>&1 | grep -Fq "Scanner: govulncheck@$(GOVULNCHECK_VERSION)"; then \
		echo "installing govulncheck $(GOVULNCHECK_VERSION)"; \
		$(GO) install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION); \
	fi

vuln: vuln-install
	"$(GOVULNCHECK_BIN)" ./...
	cd desktop-wails && "$(GOVULNCHECK_BIN)" ./...

cross-build:
	./scripts/cross-build.sh

docker:
	docker build -t rowake:$(VERSION) .

release:
	./scripts/release.sh "$(VERSION)"

clean:
	rm -rf bin dist desktop-wails/build/bin desktop-wails/frontend/wailsjs
