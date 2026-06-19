# Portable container image for the VIVID FastAPI backend — usable on any
# container host (Render Docker runtime, Fly.io, Railway, Cloud Run, local).
# Render's render.yaml uses the native `python` runtime instead; this Dockerfile
# is the platform-agnostic alternative. Build context is the backend/ directory.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code (.dockerignore keeps .env, .venv, *.db, logs OUT of the image).
COPY . .

EXPOSE 8000

# Hosts inject $PORT; default to 8000 for local `docker run`.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
