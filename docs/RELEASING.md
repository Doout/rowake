# Releasing Rowake from GitHub

## Normal development pushes

Pushes to `main` and pull requests run `.github/workflows/ci.yml`. The workflow runs source checks, race tests, smoke tests, live PostgreSQL/MySQL driver tests, all six cross-builds, and a container build.

## Public release

Create and push a semantic-version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow then:

1. Runs source checks, exercises SQLite, and connects to live PostgreSQL and MySQL service containers.
2. Builds Linux, macOS, and Windows archives for `amd64` and `arm64`.
3. Verifies archive checksums and the universal-driver build manifest.
4. Creates or updates the matching GitHub Release.
5. Publishes one multi-platform Linux image to `ghcr.io/<owner>/<repository>`.

Every platform archive includes SQLite, PostgreSQL, and MySQL/MariaDB. The GHCR manifest selects the correct Linux architecture automatically.

## Manual packaging test

Run the Release workflow with **Run workflow** and supply a version such as `0.1.0-dev.1`. This produces private workflow artifacts containing the archives, checksums, and manifest, but does not create a GitHub Release or push a container image.

## Local packaging

```sh
make check
make race
make smoke
make release VERSION=0.1.0
(cd dist && sha256sum -c SHA256SUMS)
```

The `dist/` directory is disposable and ignored by Git.
