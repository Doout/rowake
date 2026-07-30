#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GO=${GO:-go}
VERSION=${1:-}
if [ -z "$VERSION" ] || [ "$VERSION" = dev ]; then
    echo "usage: $0 <version>" >&2
    exit 2
fi
VERSION=${VERSION#v}
case "$VERSION" in
    *[!0-9A-Za-z.-]*|.*|-*|*.)
        echo "invalid version: $VERSION" >&2
        exit 2
        ;;
esac

DIST="$ROOT/dist"
STAGE="$DIST/.stage"
COMMIT=${COMMIT:-${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf unknown)}}
BUILD_DATE=${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT -X main.buildDate=$BUILD_DATE"
GO_VERSION=$($GO env GOVERSION)

rm -rf "$DIST"
mkdir -p "$DIST" "$STAGE"

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
    name="rowake-$VERSION-$GOOS-$GOARCH"
    package="$STAGE/$name"
    mkdir -p "$package/docs"

    suffix=
    if [ "$GOOS" = windows ]; then
        suffix=.exe
    fi

    printf 'building %s/%s with SQLite, PostgreSQL, and MySQL/MariaDB\n' "$GOOS" "$GOARCH"
    (
        cd "$ROOT"
        CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
            "$GO" build -trimpath -buildvcs=false -ldflags "$LDFLAGS" \
            -o "$package/rowake$suffix" ./cmd/rowake
    )

    cp "$ROOT/README.md" "$package/README.md"
    cp "$ROOT/THIRD_PARTY_NOTICES.md" "$package/THIRD_PARTY_NOTICES.md"
    cp "$ROOT/docs/DRIVERS.md" "$package/docs/DRIVERS.md"

    if [ "$GOOS" = windows ]; then
        (
            cd "$STAGE"
            zip -q -r "$DIST/$name.zip" "$name"
        )
    else
        tar -C "$STAGE" -czf "$DIST/$name.tar.gz" "$name"
    fi
    rm -rf "$package"
done

cat > "$DIST/BUILD-MANIFEST.txt" <<MANIFEST
Rowake $VERSION
commit=$COMMIT
built_at=$BUILD_DATE
go=$GO_VERSION
drivers=SQLite,PostgreSQL,MySQL/MariaDB
driver_modules=github.com/ncruces/go-sqlite3@v0.35.2,github.com/jackc/pgx/v5@v5.10.0,github.com/go-sql-driver/mysql@v1.10.0
targets=linux/amd64,linux/arm64,darwin/amd64,darwin/arm64,windows/amd64,windows/arm64
cgo=disabled
MANIFEST

(
    cd "$DIST"
    sha256sum rowake-* > SHA256SUMS
)
rm -rf "$STAGE"
printf 'release assets written to %s\n' "$DIST"
