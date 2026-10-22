.PHONY: install fmt fmt-check check test build ci
install:
	bun install --frozen-lockfile
fmt:
	bun fmt
fmt-check:
	bun fmt --check
check:
	bun run typecheck
test:
	bun run test
build:
	bun run build
ci: fmt-check check test build

.PHONY: sandbox-image sandbox-smoke video-image vpn-image
sandbox-image:
	docker build -t hibana-sandbox:latest apps/bot/sandbox
sandbox-smoke:
	bun scripts/sandbox-smoke.ts
video-image:
	docker build -t hibana-video:latest apps/bot/sandbox/video
vpn-image:
	docker build -t hibana-vpn:latest apps/bot/sandbox/vpn
