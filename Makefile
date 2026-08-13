.DEFAULT_GOAL := all

# Electronは製品には使わず、production HTMLをChromium上で検証するテスト実行器としてだけ使う。
ELECTRON := ./node_modules/.bin/electron
WEBPACK := ./node_modules/.bin/webpack
TSC := ./node_modules/.bin/tsc
TSX := ./node_modules/.bin/tsx
BENCHMARK_OPS ?= 100000
BENCHMARK_TRACE ?=
PACKAGE_VERSION := $(shell node -p 'require("./package.json").version')
ARCHIVE_NAME := konata-v$(PACKAGE_VERSION)
ARCHIVE_ROOT := dist-release
ARCHIVE_DIR := $(ARCHIVE_ROOT)/$(ARCHIVE_NAME)
ARCHIVE_PATH := $(ARCHIVE_ROOT)/$(ARCHIVE_NAME).zip

.PHONY: all production check versions init test typecheck license-check launcher-check serve web-render-smoke \
	web-smoke production-smoke benchmark-op-store release-version-check archive release-archive \
	latest-archive clean distclean

all:
	$(WEBPACK) --mode development

production: license-check
	$(WEBPACK) --mode production

# 型・Parser・単一HTML・Web描画を順番に検証する正式な確認入口。
check:
	$(MAKE) typecheck
	$(MAKE) test
	$(MAKE) launcher-check
	$(MAKE) production-smoke

# ElectronはWeb smoke testの実行器なので、開発環境の確認値には残す。
versions:
	node --version
	npm --version
	node -p '"Electron test runner " + require("electron/package.json").version'

# bind mountに残るテスト実行器を、現在の環境に合うElectronへ確実に更新する。
init:
	npm install
	npm rebuild electron

# Web実装のTypeScriptテストをNode.js上で実行する。
test:
	$(TSX) --test test/*.test.ts

typecheck:
	$(TSC) --project tsconfig.json --noEmit

# production依存と配布HTMLへ入るloader runtimeが、監査済み一覧と一致することを確認する。
license-check:
	node tools/check_third_party_licenses.js

# 配布するremote起動scriptの構文と実行permissionを、archive生成前にも検査する。
launcher-check:
	bash -n konata.sh
	test -x konata.sh

# 通常checkから分離し、store方式を同じ入力・同じ指標で比較するためにだけ実行する。
benchmark-op-store:
	node --expose-gc --import tsx tools/benchmark_op_store.ts --ops $(BENCHMARK_OPS) $(if $(BENCHMARK_TRACE),--trace $(BENCHMARK_TRACE))

serve:
	$(WEBPACK) serve --mode development

# ビルド方式に依存しないRenderer検証を共通化し、developmentとproductionの両方で使う。
# CIではgzip sampleの解析を含む一連のUI検査に30秒以上かかるため、全体には余裕を持たせる。
web-render-smoke:
	ELECTRON_ENABLE_LOGGING=1 \
		dbus-run-session -- xvfb-run -a timeout 60s \
		$(ELECTRON) test/web_app_smoke.js --no-sandbox --disable-gpu

# Web版をElectronのsandboxed Chromiumで読み込み、ReactのmountとCSS適用までを検証する。
# Electron APIはテスト側だけで使い、src/やproduction成果物には含めない。
web-smoke: all
	$(MAKE) web-render-smoke

production-smoke: production
	node test/single_html_smoke.js
	$(MAKE) web-render-smoke

# package.jsonをバージョンの基準とし、lockfileとの不一致を配布前に検出する。
release-version-check:
	node -e 'const packageJSON = require("./package.json"); const lock = require("./package-lock.json"); if (packageJSON.version !== lock.version || packageJSON.version !== lock.packages[""].version) { throw new Error("package.json and package-lock.json versions do not match."); }'

# 検証済みの単一HTML、remote起動script、利用・ライセンス文書をZIPへまとめる。
archive:
	rm -rf "$(ARCHIVE_DIR)" "$(ARCHIVE_PATH)"
	mkdir -p "$(ARCHIVE_DIR)"
	cp dist-web/index.html konata.sh README.md LICENSE.md THIRD_PARTY_LICENSES.md "$(ARCHIVE_DIR)/"
	cd "$(ARCHIVE_ROOT)" && zip -q -r "$(ARCHIVE_NAME).zip" "$(ARCHIVE_NAME)"
	zip -T "$(ARCHIVE_PATH)"
	@echo "Archive created: $(ARCHIVE_PATH)"

# releaseはpackage.jsonのversion名、Pagesはmasterを示す固定latest名で同じ内容を配布する。
release-archive: release-version-check check
	$(MAKE) archive ARCHIVE_NAME="$(ARCHIVE_NAME)"

latest-archive: check
	$(MAKE) archive ARCHIVE_NAME=konata-latest

clean:
	rm dist-web dist-release -r -f

distclean: clean
	rm node_modules -r -f
