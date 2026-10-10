#!/usr/bin/env bash

set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
cleanup_test() {
    rm -rf -- "$test_dir"
}
trap cleanup_test EXIT
trap 'exit 1' HUP INT TERM

make_update_archive() {
    local payload_dir="$1"
    local archive_path="$2"
    python3 - "$payload_dir" "$archive_path" <<'PY'
import os
import sys
import zipfile

payload_dir, archive_path = sys.argv[1:]
with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(os.listdir(payload_dir)):
        archive.write(
            os.path.join(payload_dir, name),
            "konata-latest/{}".format(name),
        )
PY
}

archive_url() {
    python3 - "$1" <<'PY'
import pathlib
import sys

print(pathlib.Path(sys.argv[1]).resolve().as_uri())
PY
}

set_build() {
    sed -i "s/^build=0-source-unknown$/build=$2/" "$1"
}

# 空白を含む配布先でも、同じarchiveのHTMLとscriptを一度に更新できる。
install_dir="$test_dir/installed copy"
payload_dir="$test_dir/payload"
mkdir -p "$install_dir" "$payload_dir"
cp "$repo_dir/konata.sh" "$install_dir/konata.sh"
set_build "$install_dir/konata.sh" "100-aaaaaaa-2026-01-01"
printf '%s\n' '# installed launcher marker' >> "$install_dir/konata.sh"
printf '%s\n' '<!doctype html><title>old</title>' > "$install_dir/index.html"
printf '%s\n' '<!doctype html><title>updated</title>' > "$payload_dir/index.html"
cp "$repo_dir/konata.sh" "$payload_dir/konata.sh"
set_build "$payload_dir/konata.sh" "200-bbbbbbb-2026-02-02"
archive_path="$test_dir/konata-latest.zip"
make_update_archive "$payload_dir" "$archive_path"

# 更新を拒否した場合は、差分を表示するだけで既存配布物を変更しない。
cancel_dir="$test_dir/cancelled copy"
mkdir -p "$cancel_dir"
cp "$install_dir/index.html" "$install_dir/konata.sh" "$cancel_dir/"
printf 'n\n' | env KONATA_UPDATE_URL="$(archive_url "$archive_path")" \
    "$cancel_dir/konata.sh" --update > "$test_dir/cancel.out" 2> "$test_dir/cancel.err"
grep -q 'A newer Konata build is available' "$test_dir/cancel.out"
grep -q 'Installed build: aaaaaaa (2026-01-01)' "$test_dir/cancel.out"
grep -q 'Available build: bbbbbbb (2026-02-02)' "$test_dir/cancel.out"
grep -q 'Install this update' "$test_dir/cancel.err"
grep -q 'Update cancelled' "$test_dir/cancel.out"
cmp "$install_dir/index.html" "$cancel_dir/index.html"
cmp "$install_dir/konata.sh" "$cancel_dir/konata.sh"

update_output="$(printf 'y\n' | env KONATA_UPDATE_URL="$(archive_url "$archive_path")" \
    "$install_dir/konata.sh" --update 2> "$test_dir/update.err")"
if [ "$update_output" != "Downloading the latest Konata development build...
Installed build: aaaaaaa (2026-01-01)
Available build: bbbbbbb (2026-02-02)
A newer Konata build is available:
  konata.sh
  index.html
Konata was updated to the latest development build." ]; then
    echo "Unexpected updater output: $update_output" >&2
    exit 1
fi

# 新しいcopyに古いarchiveを指定した場合も、downgradeであることを明示して確認を求める。
older_payload="$test_dir/older payload"
mkdir -p "$older_payload"
printf '%s\n' '<!doctype html><title>older</title>' > "$older_payload/index.html"
cp "$repo_dir/konata.sh" "$older_payload/konata.sh"
set_build "$older_payload/konata.sh" "50-ccccccc-2025-12-31"
older_archive="$test_dir/older.zip"
make_update_archive "$older_payload" "$older_archive"
printf 'n\n' | env KONATA_UPDATE_URL="$(archive_url "$older_archive")" \
    "$install_dir/konata.sh" --update > "$test_dir/older.out" 2> "$test_dir/older.err"
grep -q 'available Konata build is older than this copy' "$test_dir/older.out"
grep -q 'Installed build: bbbbbbb (2026-02-02)' "$test_dir/older.out"
grep -q 'Available build: ccccccc (2025-12-31)' "$test_dir/older.out"
grep -q 'Update cancelled' "$test_dir/older.out"
cmp "$payload_dir/index.html" "$install_dir/index.html"
cmp "$payload_dir/konata.sh" "$install_dir/konata.sh"
grep -q 'Install this update' "$test_dir/update.err"
cmp "$payload_dir/index.html" "$install_dir/index.html"
cmp "$payload_dir/konata.sh" "$install_dir/konata.sh"
test -x "$install_dir/konata.sh"

# 同じarchiveを再確認した場合は、確認を求めず最新であることを表示する。
current_output="$(KONATA_UPDATE_URL="$(archive_url "$archive_path")" \
    "$install_dir/konata.sh" --update)"
if [ "$current_output" != "Downloading the latest Konata development build...
Installed build: bbbbbbb (2026-02-02)
Available build: bbbbbbb (2026-02-02)
Konata is already up to date." ]; then
    echo "Unexpected current-version output: $current_output" >&2
    exit 1
fi

# 不完全なarchiveは既存配布物を一切置換しない。
broken_install="$test_dir/broken install"
broken_payload="$test_dir/broken payload"
mkdir -p "$broken_install" "$broken_payload"
cp "$repo_dir/konata.sh" "$broken_install/konata.sh"
printf '%s\n' '<!doctype html><title>original</title>' > "$broken_install/index.html"
cp "$broken_install/index.html" "$test_dir/original-index.html"
cp "$broken_install/konata.sh" "$test_dir/original-konata.sh"
printf '%s\n' '<!doctype html><title>incomplete</title>' > "$broken_payload/index.html"
broken_archive="$test_dir/broken.zip"
make_update_archive "$broken_payload" "$broken_archive"
if KONATA_UPDATE_URL="$(archive_url "$broken_archive")" \
    "$broken_install/konata.sh" --update > "$test_dir/broken.out" 2> "$test_dir/broken.err"; then
    echo "An incomplete update archive was accepted." >&2
    exit 1
fi
grep -q 'Konata update' "$test_dir/broken.err"
cmp "$test_dir/original-index.html" "$broken_install/index.html"
cmp "$test_dir/original-konata.sh" "$broken_install/konata.sh"

# source treeのlauncherは隣に配布HTMLがないため、--updateで生成物を混入させない。
source_install="$test_dir/source tree"
mkdir -p "$source_install"
cp "$repo_dir/konata.sh" "$source_install/konata.sh"
if KONATA_UPDATE_URL="$(archive_url "$archive_path")" \
    "$source_install/konata.sh" --update > "$test_dir/source.out" 2> "$test_dir/source.err"; then
    echo "The updater accepted a directory without index.html." >&2
    exit 1
fi
grep -q 'only an extracted distribution' "$test_dir/source.err"
test ! -e "$source_install/index.html"

# 未指定時は空きportを選び、実際のURLとSSH tunnelへ反映する。
server_dir="$test_dir/server install"
trace_path="$test_dir/parent trace.log"
mkdir -p "$server_dir"
cp "$repo_dir/konata.sh" "$server_dir/konata.sh"
printf '%s\n' '<!doctype html><title>server</title>' > "$server_dir/index.html"
printf '%s\n' 'trace' > "$trace_path"
timeout --preserve-status --signal=INT 1 \
    "$server_dir/konata.sh" "$trace_path" > "$test_dir/server.out"
port="$(sed -n 's|^Konata URL: http://127\.0\.0\.1:\([0-9][0-9]*\)/.*|\1|p' "$test_dir/server.out")"
test -n "$port"
grep -q "^SSH tunnel: ssh -L $port:127.0.0.1:$port <host>$" "$test_dir/server.out"

# 表示名にURLの特殊文字があっても、指定順の固定slotだけを配信する。
trace_paths=()
for i in {1..10}; do
    trace_path="$test_dir/trace $i #+日本語.log"
    printf 'trace %s\n' "$i" > "$trace_path"
    trace_paths+=("$trace_path")
done
python3 - "$server_dir/konata.sh" "${trace_paths[@]}" <<'PY'
import os
import pathlib
import select
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

launcher, *paths = sys.argv[1:]
env = os.environ.copy()
env.pop("KONATA_PORT", None)
for count in (1, 2, 10):
    with subprocess.Popen(
        [launcher, *paths[:count]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=env, start_new_session=True,
    ) as process:
        try:
            assert select.select([process.stdout], [], [], 10)[0], "No launcher URL was printed."
            line = process.stdout.readline().decode().strip()
            assert line.startswith("Konata URL: "), line
            url = urllib.parse.urlsplit(line.removeprefix("Konata URL: "))
            assert url.hostname == "127.0.0.1" and url.port > 0, url
            assert urllib.parse.parse_qs(url.fragment)["name"] == [
                pathlib.Path(p).name for p in paths[:count]
            ]
            origin = urllib.parse.urlunsplit((url.scheme, url.netloc, "/", "", ""))
            deadline = time.monotonic() + 5
            while True:
                try:
                    with urllib.request.urlopen(origin, timeout=1) as response:
                        assert response.read() == pathlib.Path(launcher).with_name("index.html").read_bytes()
                    break
                except urllib.error.URLError:
                    assert process.poll() is None and time.monotonic() < deadline, "The trace server did not start."
                    time.sleep(0.05)
            for slot, path in enumerate(paths[:count], 1):
                with urllib.request.urlopen(origin + f"trace{slot}", timeout=2) as response:
                    assert response.read() == pathlib.Path(path).read_bytes(), f"Incorrect trace{slot}."
            for unknown in (f"trace{count + 1}", "konata.sh", "../parent%20trace.log"):
                try:
                    urllib.request.urlopen(origin + unknown, timeout=2).close()
                    raise AssertionError(f"Unexpectedly served {unknown}.")
                except urllib.error.HTTPError as error:
                    assert error.code == 404, error.code
        finally:
            os.killpg(process.pid, signal.SIGINT)
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

# 上限外はserverを起動せずUsage errorで終了する。
for args in ([], paths + [paths[0]]):
    result = subprocess.run([launcher, *args], capture_output=True, timeout=5, env=env)
    assert result.returncode == 2, result
    assert b"up to 10 files" in result.stderr, result.stderr
    assert b"Konata URL:" not in result.stdout, result.stdout
PY

echo "Konata launcher test passed."
