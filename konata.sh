#!/usr/bin/env bash

# リモートやWSL上のtraceを、SSH port forwarding先のbrowserからKonataで開く。
# PythonでHTMLと指定traceだけを固定URLへ対応付け、元のdirectory全体は公開しない。
# 配布済みdirectoryでは、Pages上の検証済みlatest archiveから自分自身を更新できる。
set -eu

# archive生成時にcommit時刻へ置換し、updateの新旧判定に使う。
build_time=0

usage() {
    echo "Usage:" >&2
    echo "  $0 TRACE1 [TRACE2]" >&2
    echo "  $0 --update" >&2
    exit 2
}

# symlink経由でも配布本体を更新し、起動時にも同じHTMLを参照する。
script_path="$(realpath -- "$0")"
script_dir="$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd)"

if [ "$#" -eq 1 ] && [ "$1" = "--update" ]; then
    index_path="$script_dir/index.html"
    if [ ! -f "$index_path" ]; then
        echo "Konata can update only an extracted distribution with index.html next to konata.sh." >&2
        exit 1
    fi

    update_dir="$(mktemp -d "$script_dir/.konata-update.XXXXXX")"
    trap 'rm -rf -- "$update_dir"' EXIT
    trap 'exit 1' HUP INT TERM

    echo "Downloading the latest Konata development build..."
    update_url="${KONATA_UPDATE_URL:-https://shioyadan.github.io/Konata/konata-latest.zip}"
    archive_path="$update_dir/konata-latest.zip"
    if ! python3 -c \
        'import socket,sys; from urllib.request import urlretrieve; socket.setdefaulttimeout(30); urlretrieve(*sys.argv[1:])' \
        "$update_url" "$archive_path" ||
        ! python3 -m zipfile -e "$archive_path" "$update_dir"; then
        echo "Could not download and unpack the Konata update." >&2
        exit 1
    fi

    payload_dir="$update_dir/konata-latest"
    payload_time="$(sed -n 's/^build_time=//p' "$payload_dir/konata.sh" 2>/dev/null || true)"
    if [[ ! "$payload_time" =~ ^[0-9]+$ ]] ||
        [ "$(head -n 1 "$payload_dir/konata.sh")" != '#!/usr/bin/env bash' ] ||
        ! bash -n "$payload_dir/konata.sh" ||
        ! head -c 64 "$payload_dir/index.html" | grep -qi '^<!doctype html>'; then
        echo "The downloaded Konata update is invalid." >&2
        exit 1
    fi

    if cmp -s "$payload_dir/konata.sh" "$script_path" &&
        cmp -s "$payload_dir/index.html" "$index_path"; then
        echo "Konata is already up to date."
        exit 0
    fi
    if [ "$payload_time" -gt "$build_time" ]; then
        echo "A newer Konata build is available:"
    elif [ "$payload_time" -lt "$build_time" ]; then
        echo "The available Konata build is older than this copy:"
    else
        echo "The available Konata build differs from this copy:"
    fi
    cmp -s "$payload_dir/konata.sh" "$script_path" || echo "  konata.sh"
    cmp -s "$payload_dir/index.html" "$index_path" || echo "  index.html"
    printf 'Install this update? [y/N] ' >&2
    if ! read -r answer; then
        echo >&2
        answer=
    fi
    case "$answer" in
        y|Y|yes|Yes|YES) ;;
        *)
            echo "Update cancelled."
            exit 0
            ;;
    esac

    chmod 755 "$payload_dir/konata.sh"
    chmod 644 "$payload_dir/index.html"

    # scriptを先に置換し、2つ目で中断しても--updateを再実行できるようにする。
    mv -f "$payload_dir/konata.sh" "$script_path"
    mv -f "$payload_dir/index.html" "$index_path"
    echo "Konata was updated to the latest development build."
    exit 0
fi

# traceは比較用を含め2 fileまでに限定する。
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    usage
fi

# releaseでは同梱HTML、source treeではproduction buildを探す。
if [ -f "$script_dir/index.html" ]; then
    index_file="$script_dir/index.html"
elif [ -f "$script_dir/dist-web/index.html" ]; then
    # source treeから試す場合も、production build済みなら同じscriptを使える。
    index_file="$script_dir/dist-web/index.html"
else
    echo "index.html was not found next to konata.sh. Extract or build Konata first." >&2
    exit 1
fi

# 配信する実fileと、tabに出すbasenameを分けて保持する。
display_names=()
trace_paths=()
for trace_file in "$@"; do
    if [ ! -f "$trace_file" ] || [ ! -r "$trace_file" ]; then
        echo "Trace is not a readable file: $trace_file" >&2
        exit 1
    fi
    trace_path="$(realpath -- "$trace_file")"
    trace_name="$(basename -- "$trace_path")"
    if [[ "$trace_name" =~ [[:cntrl:]] ]]; then
        echo "Trace names must not contain control characters: $trace_file" >&2
        exit 1
    fi
    display_names+=("$trace_name")
    trace_paths+=("$trace_path")
done

# 未指定時は短い事前探索で空きportを選ぶ。serverのbindまでに稀な競合はあり得る。
port="${KONATA_PORT:-$(python3 -c '
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
')}"
case "$port" in
    ''|*[!0-9]*)
        echo "KONATA_PORT must be an integer from 1 to 65535." >&2
        exit 1
        ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "KONATA_PORT must be an integer from 1 to 65535." >&2
    exit 1
fi

# basenameはserverへ送られないfragmentに入れ、tab表示にだけ使う。
fragment="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.urlencode([("name", name) for name in sys.argv[1:]]))' "${display_names[@]}")"
url="http://127.0.0.1:$port/#$fragment"

# terminalへ直接表示するときだけ要点を着色する。redirect先へANSI escapeを混ぜず、NO_COLORにも従う。
cyan= green= reset=
if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
    cyan=$'\033[1;36m' green=$'\033[1;32m' reset=$'\033[0m'
fi

printf 'Konata URL: %s%s%s\n' "$cyan" "$url" "$reset"
printf 'SSH tunnel: %sssh -L %s:127.0.0.1:%s <host>%s\n' "$green" "$port" "$port" "$reset"
echo "Press Ctrl+C to stop the server."

# URLを実fileへ直接対応付け、一致しないpathは本文なしの404にする。
python3 -c '
import http.server
import sys
import urllib.parse

index = sys.argv[2]
files = {"/": index, "/index.html": index}
files.update({"/trace{}".format(i): path for i, path in enumerate(sys.argv[3:], 1)})

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, url):
        return files[urllib.parse.urlsplit(url).path]

    def send_head(self):
        if urllib.parse.urlsplit(self.path).path not in files:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return super().send_head()

http.server.test(Handler, port=int(sys.argv[1]), bind="127.0.0.1")
' \
    "$port" "$index_file" "${trace_paths[@]}"
