#!/usr/bin/env bash

# Konataの固定Node.js開発・Webテスト環境をDockerで起動するためのランチャー。
# リポジトリを/workspaceへbind mountし、指定されたコマンドをホストと同じUID/GIDで実行する。
# 引数なしでは対話シェルを開き、引数があれば配列のままコンテナへ渡す。
#
# 使用例:
#   ./docker/launch.sh
#   ./docker/launch.sh make init
#   ./docker/launch.sh make check
#   ./docker/launch.sh make serve
#
# Dockerfileまたはentrypoint.shの更新時はイメージを自動再構築する。
# make serveでは127.0.0.1の開発用ポートだけを公開する。
# 次の環境変数で必要な場合だけ既定動作を上書きできる。
#   KONATA_DOCKER_REBUILD=1       イメージを強制的に再構築する。
#   KONATA_DOCKER_IMAGE=<name>    使用するイメージ名を変更する。
#   KONATA_DOCKER_WEB_PORT=<port> make serveのホスト側ポートを変更する。
#   KONATA_DOCKER_PUBLISH_WEB=1   make serve以外のコマンドでもWebポートを公開する。

set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is not installed." >&2
    echo "Install Docker and add the current user to the docker group." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Error: The Docker daemon is unavailable or permission was denied." >&2
    exit 1
fi

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "${script_directory}/.." && pwd -P)"
image_name="${KONATA_DOCKER_IMAGE:-konata-devel:node22}"
host_name="$(hostname | tr -cd '[:alnum:].-')"
build_stamp="${script_directory}/.image-${host_name}.stamp"

# イメージ未作成時とDocker定義更新時だけ再構築し、通常の起動を軽く保つ。
if [[ "${KONATA_DOCKER_REBUILD:-0}" == "1" ]] ||
    ! docker image inspect "${image_name}" >/dev/null 2>&1 ||
    [[ ! -f "${build_stamp}" ]] ||
    [[ "${script_directory}/Dockerfile" -nt "${build_stamp}" ]] ||
    [[ "${script_directory}/entrypoint.sh" -nt "${build_stamp}" ]]; then
    echo "Building Docker image ${image_name}..."
    docker build \
        --file "${script_directory}/Dockerfile" \
        --tag "${image_name}" \
        "${repository_root}"
    touch "${build_stamp}"
fi

docker_arguments=(
    --rm
    --init
    --env "KONATA_HOST_UID=$(id -u)"
    --env "KONATA_HOST_GID=$(id -g)"
    --env HOME=/tmp/konata-user
    --env npm_config_cache=/tmp/konata-npm-cache
    --env XDG_CACHE_HOME=/tmp/konata-cache
    --env XDG_CONFIG_HOME=/tmp/konata-config
    --env XDG_DATA_HOME=/tmp/konata-data
    --volume "${repository_root}:/workspace"
    --workdir /workspace
)

# make serveだけはブラウザから接続できるようにし、公開先をlocalhostへ限定する。
publish_web_port="${KONATA_DOCKER_PUBLISH_WEB:-0}"
for argument in "$@"; do
    if [[ "${argument}" == "serve" ]]; then
        publish_web_port="1"
        break
    fi
done
if [[ "${publish_web_port}" == "1" ]]; then
    docker_arguments+=(--publish "127.0.0.1:${KONATA_DOCKER_WEB_PORT:-8080}:8080")
fi

if [[ "$#" -eq 0 ]]; then
    docker_arguments+=(-it)
    command_arguments=(bash)
else
    command_arguments=("$@")
fi

exec docker run "${docker_arguments[@]}" "${image_name}" "${command_arguments[@]}"
