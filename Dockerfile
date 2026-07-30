# syntax=docker/dockerfile:1.7

ARG GO_VERSION=1.26.5
FROM golang:${GO_VERSION}-alpine AS build
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY go.* ./
RUN go mod download
COPY . .
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
RUN GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
    go build -trimpath -buildvcs=false \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.buildDate=${BUILD_DATE}" \
    -o /out/rowake ./cmd/rowake \
    && mkdir -p /out/data /out/tmp \
    && touch /out/data/.keep \
    && chown -R 65532:65532 /out/data \
    && chmod 1777 /out/tmp

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=build /out/rowake /rowake
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=build /out/tmp /tmp
ENV HOME=/data TMPDIR=/tmp
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/rowake", "serve", "--listen", "0.0.0.0:8080"]
