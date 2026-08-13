#!/usr/bin/env bash

# リモートやWSL上のtraceを、SSH port forwarding先のbrowserからKonataで開く。
# PythonでHTMLと指定traceだけを固定URLへ対応付け、元のdirectory全体は公開しない。
set -eu

# traceは比較用を含め2 fileまでに限定する。
usage() {
    echo "Usage: $0 TRACE1 [TRACE2]" >&2
    exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    usage
fi

# releaseでは同梱HTML、source treeではproduction buildを探す。
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
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

# localhostの待受portだけを環境変数で変更できる。
port="${KONATA_PORT:-30080}"
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
