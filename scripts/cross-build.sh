#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/dist/cross-build"
GO=${GO:-go}
VERSION=${VERSION:-dev}
COMMIT=${COMMIT:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}
BUILD_DATE=${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.buildDate=$BUILD_DATE"

rm -rf "$OUT"
mkdir -p "$OUT"

for target in \
    linux/amd64 \
    linux/arm64 \
    darwin/amd64 \
    darwin/arm64 \
    windows/amd64 \
    windows/arm64
do
    GOOS=${target%/*}
    GOARCH=${target#*/}
    suffix=
    if [ "$GOOS" = windows ]; then
        suffix=.exe
    fi
    output="$OUT/rowake-$GOOS-$GOARCH$suffix"
    printf 'building %s/%s\n' "$GOOS" "$GOARCH"
    (
        cd "$ROOT"
        CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
            "$GO" build -trimpath -buildvcs=false -ldflags "$LDFLAGS" \
            -o "$output" ./cmd/rowake
    )
done

printf 'built 6 universal binaries in %s\n' "$OUT"
