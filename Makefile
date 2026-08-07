.DEFAULT_GOAL := all

ELECTRON_VERSION := 43.2.0
ELECTRON := ./node_modules/.bin/electron
ELECTRON_PACKAGER := ./node_modules/.bin/electron-packager
LICENSE_CHECKER := ./node_modules/.bin/license-checker
WEBPACK := ./node_modules/.bin/webpack
TSC := ./node_modules/.bin/tsc
TSX := ./node_modules/.bin/tsx
BENCHMARK_OPS ?= 100000

.PHONY: all production check versions run init test typecheck serve web-render-smoke \
	web-smoke production-smoke electron-smoke electron-package-smoke benchmark-op-store \
	build pack clean distclean

# Web版とElectron版を分離し、移行中もmake runで現行版を起動できるようにする。
all:
	$(WEBPACK) --mode development

production:
	$(WEBPACK) --mode production

# 型・Parser・単一HTML・Web描画・Electron参照版を順番に検証する正式な確認入口。
check:
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) production-smoke
	$(MAKE) electron-smoke

# Electron実行ファイルを起動せず、開発環境と依存パッケージの固定値を確認する。
versions:
	node --version
	npm --version
	node -p '"Electron " + require("electron/package.json").version'

run:
	$(ELECTRON) .

# bind mountに残る実行ファイルを、現在の環境に合うElectronへ確実に更新する。
init:
	npm install
	npm rebuild electron

# 個々のテスト失敗の詳細をTAPへ出すため、ファイル単位で直接実行する。
test:
	@set -e; \
	for test_file in test/*.test.js; do \
		node "$$test_file"; \
	done; \
	$(TSX) --test test/*.test.ts

# DISPLAYのないCIでも、Electronの初期画面とRiotのmountまでをXvfb上で確認する。
electron-smoke:
	KONATA_ELECTRON_SMOKE_TEST=1 ELECTRON_ENABLE_LOGGING=1 \
		dbus-run-session -- xvfb-run -a timeout 30s \
		$(ELECTRON) . --no-sandbox --disable-gpu

# 配布用の全OSビルドより軽いLinux限定パッケージで、Packagerとの互換性を確認する。
electron-package-smoke:
	@set -e; \
	package_dir=$$(mktemp -d /tmp/konata-package.XXXXXX); \
	trap 'rm -rf "$$package_dir"' EXIT; \
	$(ELECTRON_PACKAGER) . konata \
		--out="$$package_dir" \
		--platform=linux \
		--arch=x64 \
		--electron-version=$(ELECTRON_VERSION) \
		--ignore='^/work($$|/)' \
		--ignore='^/packaging-work($$|/)' \
		--ignore='^/.vscode($$|/)' \
		--asar \
		--prune=true; \
	test -x "$$package_dir/konata-linux-x64/konata"

typecheck:
	$(TSC) --project tsconfig.json --noEmit

# 通常checkから分離し、store方式を同じ入力・同じ指標で比較するためにだけ実行する。
benchmark-op-store:
	node --expose-gc --import tsx tools/benchmark_op_store.ts --ops $(BENCHMARK_OPS)

serve:
	$(WEBPACK) serve --mode development

# ビルド方式に依存しないRenderer検証を共通化し、developmentとproductionの両方で使う。
web-render-smoke:
	ELECTRON_ENABLE_LOGGING=1 \
		dbus-run-session -- xvfb-run -a timeout 30s \
		$(ELECTRON) test/web_app_smoke.js --no-sandbox --disable-gpu

# Web版をNode integrationなしで読み込み、ReactのmountとCSS適用までを検証する。
web-smoke: all
	$(MAKE) web-render-smoke

production-smoke: production
	node test/single_html_smoke.js
	$(MAKE) web-render-smoke

build: clean
	$(LICENSE_CHECKER) --production --relativeLicensePath > THIRD-PARTY-LICENSES.md
	$(ELECTRON_PACKAGER) . konata \
		--out=packaging-work \
		--platform=darwin,win32,linux \
		--arch=x64  \
		--electron-version=$(ELECTRON_VERSION) \
		--ignore work \
		--ignore packaging-work \
		--ignore .vscode \
		--asar \
		--prune=true	# Exclude devDependencies

DOCUMENTS = README.md LICENSE.md THIRD-PARTY-LICENSES.md
pack: build
	cp $(DOCUMENTS) -t ./packaging-work/
	cd packaging-work/; zip -r konata-win32-x64.zip konata-win32-x64 $(DOCUMENTS)
	cd packaging-work/; tar -cvzf konata-linux-x64.tar.gz konata-linux-x64 $(DOCUMENTS)
	cd packaging-work/; tar -cvzf konata-darwin-x64.tar.gz konata-darwin-x64 $(DOCUMENTS)

clean:
	rm packaging-work dist-web -r -f

distclean: clean
	rm node_modules -r -f
