# hibana sandbox image — tools the model may call via `bash`.
#
# Isolation flags (network bridge/VPN, read-only rootfs, uid 1000) are applied by
# the bot at `docker run` time; this image only supplies binaries + language toolchains.
#
# Build:
#   make sandbox-image
#   # → docker build -f sandbox/Dockerfile -t hibana-sandbox:latest sandbox/
#
# Production evidence (VPS workspaces / logs, 2026-08):
# - CJK text → English captions / pure-CID PDF / host download of Kosugi.ttf
#   because only DejaVu was installed ("no CJK font in sandbox").
# - SVG→PNG reimplemented in Pillow (no rsvg-convert) when user asked for SVG first.
# - xlsx via hand-rolled zip+XML (no openpyxl).
# - Image gen almost always goes through Pillow (expected; keep it strong + fonts).
# - Go: guild workspace wrote msg_audit_go.go after users demanded golang; `go` was
#   MISSING in the image so go run failed (journal bash results ~09:32–09:33 on Aug 7).
# - PHP: agent wrote php_discord_log.php (user taunt); not installed yet — needs
#   separate decision (cli-only value is low; that script also needed network+token).
# - C/gcc: user taunt only; no .c artifacts in workspaces. node/rust/java: no attempts.
# - Bun + outbound network (2026-08): React/static sites via bun install/build → publish_site.
#
# VPS note (default deploy ~1 vCPU / ~1 GiB RAM): packages below fit disk; keep
# plots/PDF HTML / bun installs modest — container default SANDBOX_MEMORY=512m can
# OOM on huge node_modules, giant matrices, or multi-page WeasyPrint.
# Go toolchain ~300MB; Bun binary ~90MB; CGO off so pure-Go works without gcc.

# Pin minors for reproducible builds; bump intentionally when needed.
# ARGs before the first FROM are usable in subsequent FROM lines.
ARG GO_VERSION=1.24.6
ARG BUN_VERSION=1.2.21
ARG DENO_VERSION=2.9.6
ARG NODE_VERSION=22
FROM golang:${GO_VERSION}-bookworm AS go-toolchain
# Bun binary only (COPY /usr/local/bin/bun — not the full oven rootfs).
FROM oven/bun:${BUN_VERSION}-debian AS bun-toolchain
FROM denoland/deno:bin-${DENO_VERSION} AS deno-toolchain
FROM node:${NODE_VERSION}-bookworm-slim AS node-toolchain

FROM python:3.12-slim-bookworm

LABEL org.opencontainers.image.title="hibana-sandbox" \
      org.opencontainers.image.description="Isolated bash/python/go/bun/ffmpeg workspace for hibana Discord bot"

# Headless matplotlib (no X11 in container).
# Go/Bun caches under /tmp: runtime is read-only rootfs + uid 1000; only /tmp is
# writable tmpfs (see docker.rs). CGO off → no gcc dependency.
ENV MPLBACKEND=Agg \
    # Avoid interactive pyplot surprises under non-TTY bash -lc.
    MPLCONFIGDIR=/tmp/matplotlib \
    PATH="/usr/local/go/bin:${PATH}" \
    GOTOOLCHAIN=local \
    CGO_ENABLED=0 \
    GOPATH=/tmp/gopath \
    GOCACHE=/tmp/gocache \
    GOMODCACHE=/tmp/gomodcache \
    GOTMPDIR=/tmp \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
    npm_config_cache=/tmp/npm-cache

# numpy / OpenCV: avoid thread oversubscription under the sandbox CPU limit.
ENV OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1

# Official Go SDK from the multi-stage stage (stdlib + go/gofmt).
COPY --from=go-toolchain /usr/local/go /usr/local/go
# Bun single binary (JS/TS runtime + install + bundler).
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun
# yt-dlp enables Deno by default for YouTube EJS challenges (including subtitles).
COPY --from=deno-toolchain /deno /usr/local/bin/deno
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=node-toolchain /usr/local/lib/node_modules /usr/local/lib/node_modules
ENV DENO_DIR=/tmp/deno

# Deb packages: image/audio/video + utilities. Keep list intentional — image size
# trades off against "model assumed tool X exists" failures.
#
# fonts-ipafont-*: compact JP Gothic/Mincho for Pillow/reportlab/ImageMagick/WeasyPrint
#   (Noto CJK full set is much larger; IPA covers real chat/logo/PDF use).
# librsvg2-bin: rsvg-convert for SVG→PNG without re-drawing in pure Pillow.
# pandoc: md/html ↔ many formats (~160MB install); no TeX stack (use weasyprint/reportlab for PDF).
# pango/cairo stack: already pulled by rsvg; restate for WeasyPrint clarity.
# curl: bash has outbound network (bun install / go mod / ad-hoc HTTPS).
# git + gh: clone/PR/issue from Discord after device-flow login (host mounts
# GH_CONFIG_DIR; tokens never bake into the image).
#   Official GitHub CLI apt repo (cli.github.com) — pin via apt, not a floating
#   binary URL, so rebuilds stay reproducible within the distro snapshot.
#
# Go/Bun PATH: bot runs `bash -lc`, which reloads /etc/profile and drops Docker ENV PATH.
# Symlink go into /usr/local/bin (always on login PATH). bun is already there.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        ffmpeg \
        file \
        fontconfig \
        fonts-dejavu-core \
        fonts-ipafont-gothic \
        fonts-ipafont-mincho \
        ghostscript \
        git \
        gnupg \
        imagemagick \
        jq \
        libgdk-pixbuf-2.0-0 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        librsvg2-bin \
        pandoc \
        poppler-utils \
        shared-mime-info \
        unzip \
        zip \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
        libasound2 libxshmfence1 \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f \
    && ln -sf /usr/local/go/bin/go /usr/local/bin/go \
    && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && chmod +x /usr/local/bin/bun \
    && go version \
    && bun --version \
    && git --version \
    && gh --version

# Pillow: primary image path (icons / logos / memes / portraits).
# reportlab: PDF when embedding TTF (register IPA fonts under /usr/share/fonts).
# openpyxl: real .xlsx without zip+XML hacks observed in production.
# qrcode[pil]: common Discord deliverable; tiny and Pillow-backed.
# numpy/matplotlib: charts / arrays (Agg backend; keep data small under 512m).
# weasyprint: HTML/CSS → PDF (uses IPA via fontconfig; avoid huge pages).
# yt-dlp: multi-site video/audio download (YouTube, X/Twitter, etc.).
#   Host tool `download_media` runs fixed yt-dlp argv (prefer over free-form bash).
#   ffmpeg above is required for format merge (bestaudio+bestvideo).
#   Install matching EJS through the default extra; keep scripts in the image.
# PyYAML: neko-meme (and other) YAML scripts in /skills.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir \
        'pillow>=10,<12' \
        'reportlab>=4,<5' \
        'openpyxl>=3.1,<4' \
        'qrcode[pil]>=7.4,<9' \
        'numpy>=1.26,<3' \
        'scipy>=1.11,<2' \
        'opencv-python-headless>=4.8,<5' \
        'matplotlib>=3.8,<4' \
        'weasyprint>=62,<67' \
        'yt-dlp[default]==2026.8.19' \
        'pyyaml>=6,<7'

RUN deno --version && yt-dlp --version \
    && python3 -c "import yt_dlp_ejs"

# Playwright CLI and a headless Chromium shell are bundled for browser tools.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NO_UPDATE_NOTIFIER=1
COPY browser/ /opt/hibana-browser/
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install --global --omit=dev @playwright/cli@0.1.19 \
    && PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /usr/local/lib/node_modules/@playwright/cli/node_modules/playwright/cli.js install --only-shell chromium \
    && chmod -R a+rX /ms-playwright

# ImageMagick policy: allow common raster ops; PDF still via ghostscript/poppler.
# Default Debian policy is fine for JPG/PNG; document that PDF→image uses pdftoppm.

# Runtime always overrides user/workdir/network; defaults help local smoke tests.
# Font paths (model / scripts):
#   IPA Gothic: /usr/share/fonts/opentype/ipafont-gothic/ipag.ttf
#   IPA Mincho: /usr/share/fonts/opentype/ipafont-mincho/ipam.ttf
#   DejaVu:     /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
#
# Go: go run main.go  |  go build -o out main.go  |  go mod tidy (network OK)
# Bun: bun install  |  bun run build  |  bun build ./src/app.tsx --outdir=dist
WORKDIR /workspace
CMD ["bash", "-lc", "echo hibana-sandbox ready; go version; bun --version; node --version; playwright-cli --help >/dev/null && echo playwright-cli OK; git --version; gh --version; curl --version | head -1; ffmpeg -version | head -1; convert -version | head -1; rsvg-convert --version 2>&1 | head -1; pandoc -v | head -1; yt-dlp --version; python3 -c \"from PIL import ImageFont; import openpyxl, numpy, matplotlib, weasyprint, reportlab; ImageFont.truetype('/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf', 24); print('numpy', numpy.__version__, 'mpl', matplotlib.__version__, 'weasyprint', weasyprint.__version__, 'IPA OK')\""]

RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
