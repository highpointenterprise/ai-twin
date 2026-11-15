# The upstream community binary/image distribution was retired. Build a fixed source revision.
# MinIO is AGPL-3.0; its complete source remains available at the URL below.
FROM golang:1.24.2-alpine AS build
ARG MINIO_COMMIT=0d7408fc9969caf07de6a8c3a84f9fbb10a6739e
ADD https://github.com/minio/minio/archive/${MINIO_COMMIT}.tar.gz /tmp/minio.tar.gz
RUN mkdir /source && tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /source
WORKDIR /source
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /minio .
FROM alpine:3.21
RUN apk add --no-cache ca-certificates curl
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /source/LICENSE /usr/share/licenses/minio/LICENSE
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
