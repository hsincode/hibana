# Separate CPU worker: ordinary sandbox tools keep their existing footprint.
FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-ipafont-gothic fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir 'pillow>=10,<12' 'faster-whisper==1.2.1'
ENV OMP_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false HF_HUB_DISABLE_TELEMETRY=1
WORKDIR /workspace
CMD ["python3", "/skills/video-edit/scripts/render.py", "timeline.json"]
