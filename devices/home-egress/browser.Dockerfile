# Only the browser directory is sent as build context; provisioning secrets
# and runtime data must never become Docker build inputs.
ARG BASE_IMAGE=hibana-sandbox:latest
FROM ${BASE_IMAGE}
COPY cli.cjs /opt/hibana-browser/cli.cjs
