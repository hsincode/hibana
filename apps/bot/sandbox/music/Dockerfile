# Keep the upstream singing model and complete licenses/resources. Speech-only
# models are not needed by music-create. Build locally before shipping to a VPS.
FROM voicevox/voicevox_engine@sha256:eb8c7f46a7d01217d1ff2b6f018261faedeceded3cc756b4fbbf371791ad6c90 AS upstream
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/voicevox_engine
COPY --from=upstream /opt/voicevox_engine/run /opt/voicevox_engine/*.so /opt/voicevox_engine/*.json /opt/voicevox_engine/README.md ./
COPY --from=upstream /opt/voicevox_engine/engine_internal ./engine_internal
COPY --from=upstream /opt/voicevox_engine/resources ./resources
COPY --from=upstream /opt/voicevox_engine/model/s0.vvm ./model/s0.vvm
ENV HOME=/tmp XDG_DATA_HOME=/tmp/.local/share XDG_CACHE_HOME=/tmp/.cache
USER 1000:1000
ENTRYPOINT ["/opt/voicevox_engine/run"]
CMD ["--host", "0.0.0.0", "--cpu_num_threads", "1", "--disable_mutable_api"]
