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
    payload_dir="$1"
    archive_path="$2"
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

# 空白を含む配布先でも、同じarchiveのHTMLとscriptを一度に更新できる。
install_dir="$test_dir/installed copy"
payload_dir="$test_dir/payload"
mkdir -p "$install_dir" "$payload_dir"
cp "$repo_dir/konata.sh" "$install_dir/konata.sh"
printf '%s\n' '<!doctype html><title>old</title>' > "$install_dir/index.html"
printf '%s\n' '<!doctype html><title>updated</title>' > "$payload_dir/index.html"
printf '%s\n' '#!/usr/bin/env bash' '# updated launcher' 'exit 0' > "$payload_dir/konata.sh"
archive_path="$test_dir/konata-latest.zip"
make_update_archive "$payload_dir" "$archive_path"
update_output="$(KONATA_UPDATE_URL="$(archive_url "$archive_path")" \
    "$install_dir/konata.sh" --update)"
if [ "$update_output" != "Downloading the latest Konata development build...
Konata was updated to the latest development build." ]; then
    echo "Unexpected updater output: $update_output" >&2
    exit 1
fi
cmp "$payload_dir/index.html" "$install_dir/index.html"
cmp "$payload_dir/konata.sh" "$install_dir/konata.sh"
test -x "$install_dir/konata.sh"

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

echo "Konata launcher update test passed."
