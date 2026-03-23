FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV TRACKER_DB_PATH=/data/tracker.db

WORKDIR /app

COPY pyproject.toml uv.lock ./

RUN pip install --no-cache-dir uv \
    && uv export --frozen --no-dev --format requirements-txt -o requirements.txt \
    && pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /data

EXPOSE 4173

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "4173"]
