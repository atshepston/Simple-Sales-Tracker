import csv
import io
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).parent
DB_PATH = Path(os.getenv("TRACKER_DB_PATH", BASE_DIR / "tracker.db"))
ALLOWED_FILES = {
    "app.js": BASE_DIR / "app.js",
    "styles.css": BASE_DIR / "styles.css",
}
DEMO_ITEMS = [
    {"name": "Dragon Egg", "price": 15.0, "quantity": 8},
    {"name": "Flexi Axolotl", "price": 12.0, "quantity": 10},
    {"name": "Mini Planter", "price": 18.0, "quantity": 5},
]

app = FastAPI(title="3D Print Market Tracker")


class ItemPayload(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    price: float = Field(ge=0)
    quantity: int = Field(ge=0)


class SalePayload(BaseModel):
    price: float | None = Field(default=None, ge=0)


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with closing(get_connection()) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                price REAL NOT NULL CHECK (price >= 0),
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                starting_quantity INTEGER NOT NULL CHECK (starting_quantity >= 0)
            );

            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id TEXT NOT NULL,
                item_name TEXT NOT NULL,
                price REAL NOT NULL CHECK (price >= 0),
                sold_at TEXT NOT NULL
            );
            """
        )
        connection.commit()

    seed_demo_data_if_empty()


def seed_demo_data_if_empty() -> None:
    with closing(get_connection()) as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM items").fetchone()
        if row["count"] > 0:
            return

        for item in DEMO_ITEMS:
            connection.execute(
                """
                INSERT INTO items (id, name, price, quantity, starting_quantity)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(uuid4()), item["name"], item["price"], item["quantity"], item["quantity"]),
            )
        connection.commit()


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(BASE_DIR / "index.html")


@app.get("/{filename}")
async def asset(filename: str) -> FileResponse:
    file_path = ALLOWED_FILES.get(filename)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Not found")

    return FileResponse(file_path)


@app.get("/api/bootstrap")
def bootstrap() -> dict[str, Any]:
    return load_snapshot()


@app.post("/api/items")
def create_item(payload: ItemPayload) -> dict[str, Any]:
    with closing(get_connection()) as connection:
        connection.execute(
            """
            INSERT INTO items (id, name, price, quantity, starting_quantity)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(uuid4()), payload.name.strip(), payload.price, payload.quantity, payload.quantity),
        )
        connection.commit()

    return load_snapshot()


@app.put("/api/items/{item_id}")
def update_item(item_id: str, payload: ItemPayload) -> dict[str, Any]:
    with closing(get_connection()) as connection:
        item = connection.execute(
            """
            SELECT
                items.id,
                COALESCE(sales_summary.sold_count, 0) AS sold_count
            FROM items
            LEFT JOIN (
                SELECT item_id, COUNT(*) AS sold_count
                FROM sales
                GROUP BY item_id
            ) AS sales_summary ON sales_summary.item_id = items.id
            WHERE items.id = ?
            """,
            (item_id,),
        ).fetchone()

        if item is None:
            raise HTTPException(status_code=404, detail="Item not found")

        sold_count = int(item["sold_count"])
        starting_quantity = payload.quantity + sold_count
        connection.execute(
            """
            UPDATE items
            SET name = ?, price = ?, quantity = ?, starting_quantity = ?
            WHERE id = ?
            """,
            (payload.name.strip(), payload.price, payload.quantity, starting_quantity, item_id),
        )
        connection.commit()

    return load_snapshot()


@app.delete("/api/items/{item_id}")
def delete_item(item_id: str) -> dict[str, Any]:
    with closing(get_connection()) as connection:
        deleted = connection.execute("DELETE FROM items WHERE id = ?", (item_id,))
        connection.commit()

        if deleted.rowcount == 0:
            raise HTTPException(status_code=404, detail="Item not found")

    return load_snapshot()


@app.post("/api/items/{item_id}/sell")
def sell_item(item_id: str, payload: SalePayload) -> dict[str, Any]:
    with closing(get_connection()) as connection:
        item = connection.execute(
            "SELECT id, name, price, quantity FROM items WHERE id = ?",
            (item_id,),
        ).fetchone()

        if item is None:
            raise HTTPException(status_code=404, detail="Item not found")
        if int(item["quantity"]) <= 0:
            raise HTTPException(status_code=400, detail="Item is sold out")

        sale_price = float(item["price"] if payload.price is None else payload.price)
        sold_at = datetime.now(timezone.utc).isoformat()

        connection.execute(
            "UPDATE items SET quantity = quantity - 1 WHERE id = ?",
            (item_id,),
        )
        connection.execute(
            """
            INSERT INTO sales (item_id, item_name, price, sold_at)
            VALUES (?, ?, ?, ?)
            """,
            (item_id, item["name"], sale_price, sold_at),
        )
        connection.commit()

    return load_snapshot()


@app.post("/api/sales/undo")
def undo_last_sale() -> dict[str, Any]:
    with closing(get_connection()) as connection:
        sale = connection.execute(
            """
            SELECT id, item_id
            FROM sales
            ORDER BY sold_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()

        if sale is None:
            raise HTTPException(status_code=400, detail="No sales to undo")

        connection.execute("DELETE FROM sales WHERE id = ?", (sale["id"],))

        item = connection.execute(
            "SELECT id FROM items WHERE id = ?",
            (sale["item_id"],),
        ).fetchone()
        if item is not None:
            connection.execute(
                "UPDATE items SET quantity = quantity + 1 WHERE id = ?",
                (sale["item_id"],),
            )

        connection.commit()

    return load_snapshot()


@app.get("/api/sales/export.csv")
def export_sales_csv() -> Response:
    with closing(get_connection()) as connection:
        sales_rows = connection.execute(
            """
            SELECT id, item_id, item_name, price, sold_at
            FROM sales
            ORDER BY sold_at ASC, id ASC
            """
        ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["sale_id", "item_id", "item_name", "price", "sold_at"])

    for row in sales_rows:
        writer.writerow(
            [
                row["id"],
                row["item_id"],
                row["item_name"],
                f"{float(row['price']):.2f}",
                row["sold_at"],
            ]
        )

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="sales-history.csv"'},
    )


@app.post("/api/reset-demo")
def reset_demo() -> dict[str, Any]:
    with closing(get_connection()) as connection:
        connection.execute("DELETE FROM sales")
        connection.execute("DELETE FROM items")
        for item in DEMO_ITEMS:
            connection.execute(
                """
                INSERT INTO items (id, name, price, quantity, starting_quantity)
                VALUES (?, ?, ?, ?, ?)
                """,
                (str(uuid4()), item["name"], item["price"], item["quantity"], item["quantity"]),
            )
        connection.commit()

    return load_snapshot()


def load_snapshot() -> dict[str, Any]:
    with closing(get_connection()) as connection:
        item_rows = connection.execute(
            """
            SELECT
                items.id,
                items.name,
                items.price,
                items.quantity,
                items.starting_quantity,
                COALESCE(sales_summary.sold_count, 0) AS sold_count
            FROM items
            LEFT JOIN (
                SELECT item_id, COUNT(*) AS sold_count
                FROM sales
                GROUP BY item_id
            ) AS sales_summary ON sales_summary.item_id = items.id
            ORDER BY items.name COLLATE NOCASE ASC
            """
        ).fetchall()

        sales_rows = connection.execute(
            """
            SELECT id, item_id, item_name, price, sold_at
            FROM sales
            ORDER BY sold_at DESC, id DESC
            LIMIT 25
            """
        ).fetchall()

    items = [
        {
            "id": row["id"],
            "name": row["name"],
            "price": float(row["price"]),
            "quantity": int(row["quantity"]),
            "startingQuantity": int(row["starting_quantity"]),
            "soldCount": int(row["sold_count"]),
        }
        for row in item_rows
    ]

    sales = [
        {
            "id": row["id"],
            "itemId": row["item_id"],
            "itemName": row["item_name"],
            "price": float(row["price"]),
            "soldAt": row["sold_at"],
        }
        for row in sales_rows
    ]

    return {"items": items, "sales": sales}
