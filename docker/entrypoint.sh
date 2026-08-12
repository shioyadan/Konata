#!/bin/sh

set -eu

user_id="${KONATA_HOST_UID:-1000}"
group_id="${KONATA_HOST_GID:-1000}"
user_name="konata"

# bind mountへホストと同じ所有者で書き込めるよう、実行時のUID/GIDをpasswdへ登録する。
if ! getent group "${group_id}" >/dev/null; then
    groupadd --gid "${group_id}" "${user_name}"
fi

if getent passwd "${user_id}" >/dev/null; then
    user_name="$(getent passwd "${user_id}" | cut -d: -f1)"
else
    useradd \
        --uid "${user_id}" \
        --gid "${group_id}" \
        --home-dir /tmp/konata-user \
        --no-create-home \
        "${user_name}"
fi

mkdir -p \
    /tmp/konata-cache \
    /tmp/konata-config \
    /tmp/konata-data \
    /tmp/konata-npm-cache \
    /tmp/konata-user
chown -R "${user_id}:${group_id}" \
    /tmp/konata-cache \
    /tmp/konata-config \
    /tmp/konata-data \
    /tmp/konata-npm-cache \
    /tmp/konata-user

# root権限をコンテナ内の初期化だけに限定し、開発コマンドはホストと同じUID/GIDで動かす。
exec setpriv \
    --reuid="${user_id}" \
    --regid="${group_id}" \
    --init-groups \
    "$@"
