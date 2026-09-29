FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client libatomic1 libgomp1 libnuma1 libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 1000 --create-home worker
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /worker
COPY worker.py workflow.json /worker/
ENTRYPOINT ["python", "/worker/worker.py"]
