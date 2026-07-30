#!/bin/sh
set -eu

BINARY=${1:-./bin/rowake}
if [ ! -x "$BINARY" ]; then
    echo "Rowake binary is not executable: $BINARY" >&2
    exit 1
fi

output=$($BINARY drivers)
actual=$(printf '%s\n' "$output" | cut -f1 | sort | tr '\n' ' ')
expected="mysql postgres sqlite "

if [ "$actual" != "$expected" ]; then
    echo "compiled drivers: $actual" >&2
    echo "expected drivers: $expected" >&2
    exit 1
fi

printf '%s\n' "$output"
