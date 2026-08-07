.DEFAULT_GOAL := all

ELECTRON_VERSION := 43.2.0
ELECTRON := ./node_modules/.bin/electron
ELECTRON_PACKAGER := ./node_modules/.bin/electron-packager
LICENSE_CHECKER := ./node_modules/.bin/license-checker
WEBPACK := ./node_modules/.bin/webpack
TSC := ./node_modules/.bin/tsc

DOCKER_IMAGE := konata-devel:node22
DOCKER_ARGS := --rm --init \
	--env KONATA_HOST_UID=$(shell id -u) \
	--env KONATA_HOST_GID=$(shell id -g) \
	--env npm_config_cache=/tmp/konata-npm-cache \
	--env XDG_CACHE_HOME=/tmp/konata-cache \
	--env XDG_CONFIG_HOME=/tmp/konata-config \
	--env XDG_DATA_HOME=/tmp/konata-data \
	--volume $(CURDIR):/workspace \
	--workdir /workspace
DOCKER_RUN := docker run $(DOCKER_ARGS) $(DOCKER_IMAGE)
DOCKER_RUN_WEB := docker run $(DOCKER_ARGS) --publish 127.0.0.1:8080:8080 $(DOCKER_IMAGE)

.PHONY: all versions run init test typecheck serve web-smoke electron-smoke electron-package-smoke \
	build pack clean distclean docker-build docker-init docker-all docker-test \
	docker-typecheck docker-serve docker-web-smoke docker-electron-smoke docker-electron-package-smoke \
	docker-versions docker-shell

# Web版とElectron版を分離し、移行中もmake runで現行版を起動できるようにする。
all:
	$(WEBPACK) --mode development

# Electron実行ファイルを起動せず、開発環境と依存パッケージの固定値を確認する。
versions:
	node --version
	npm --version
	node -p '"Electron " + require("electron/package.json").version'

run:
	$(ELECTRON) .

init:
	npm install

# Node 18でも個々のテスト失敗の詳細をTAPへ出すため、ファイル単位で直接実行する。
test:
	@set -e; \
	for test_file in test/*.test.js; do \
		node "$$test_file"; \
	done

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

serve:
	$(WEBPACK) serve --mode development

# Web版をNode integrationなしで読み込み、ReactのmountとCSS適用までを検証する。
web-smoke: all
	ELECTRON_ENABLE_LOGGING=1 \
		dbus-run-session -- xvfb-run -a timeout 30s \
		$(ELECTRON) test/web_app_smoke.js --no-sandbox --disable-gpu

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

# ホストのNode.jsやnpmを更新せず、固定したNode.js 22環境を利用する。
docker-build:
	docker build --file docker/Dockerfile --tag $(DOCKER_IMAGE) .

docker-init:
	$(DOCKER_RUN) npm install
	$(DOCKER_RUN) npm rebuild electron

docker-all:
	$(DOCKER_RUN) make all

docker-test:
	$(DOCKER_RUN) make test

docker-typecheck:
	$(DOCKER_RUN) make typecheck

# コンテナ内では外部接続を受け、Dockerの公開設定でホストのlocalhostだけへ限定する。
docker-serve:
	$(DOCKER_RUN_WEB) make serve

docker-web-smoke:
	$(DOCKER_RUN) make web-smoke

docker-electron-smoke:
	$(DOCKER_RUN) make electron-smoke

docker-electron-package-smoke:
	$(DOCKER_RUN) make electron-package-smoke

docker-versions:
	$(DOCKER_RUN) make versions

docker-shell:
	docker run $(DOCKER_ARGS) -it $(DOCKER_IMAGE)
