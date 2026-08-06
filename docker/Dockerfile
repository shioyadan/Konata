FROM node:22.18.0-bookworm

ENV DEBIAN_FRONTEND=noninteractive

# ElectronのGUI起動をXvfb上で検証するため、Chromiumの実行ライブラリも固定環境へ入れる。
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
        make \
        passwd \
        util-linux \
        xauth \
        xvfb \
        zip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY docker/entrypoint.sh /usr/local/bin/konata-entrypoint
RUN chmod +x /usr/local/bin/konata-entrypoint

ENTRYPOINT ["/usr/local/bin/konata-entrypoint"]
CMD ["bash"]
