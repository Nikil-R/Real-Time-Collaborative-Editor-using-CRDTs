# FastAPI relay server. Build context: ./server
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN pip install --no-cache-dir uv

WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

# Run as an unprivileged user.
RUN useradd --system --uid 10001 collab
USER collab

ENV PATH="/srv/.venv/bin:$PATH"
EXPOSE 8000

# Apply migrations, then serve. DATABASE_URL and REDIS_URL come from the environment.
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --ws-max-size 1048576"]
