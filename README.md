# 3D Print Market Tracker

A small mobile-friendly web app for tracking 3D prints you sell at events like farmers markets.

The frontend talks to a FastAPI backend, and all inventory plus sales history are stored in a local SQLite database at `tracker.db`.

## Run with uv

1. `uv sync`
2. `uv run uvicorn main:app --host 0.0.0.0 --port 4173 --reload`

Then open `http://127.0.0.1:4173`.

## Run with Docker Compose

1. `docker compose up --build`
2. Open `http://127.0.0.1:4173`

The SQLite database is stored in `./data/tracker.db` via a bind mount, so you can inspect or back it up directly from the host machine.

## What it does

- Tap an item card to record a sale at the default price
- Use custom sale when you need a different sale price
- Track remaining quantity, units sold, and revenue
- Add, edit, delete, and restock inventory
- Keep inventory and sales persisted in SQLite
- Export the full sales history as CSV
