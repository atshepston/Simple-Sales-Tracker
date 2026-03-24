import csv
import io
import os
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).parent
DB_PATH = Path(os.getenv("TRACKER_DB_PATH", BASE_DIR / "tracker.db"))
DATA_DIR = DB_PATH.parent
UPLOADS_DIR = DATA_DIR / "uploads"
ALLOWED_FILES = {
    "app.js": BASE_DIR / "app.js",
    "styles.css": BASE_DIR / "styles.css",
}
DEMO_ITEMS = [
    {"name": "Dragon Egg", "price": 15.0, "quantity": 8},
    {"name": "Flexi Axolotl", "price": 12.0, "quantity": 10},
    {"name": "Mini Planter", "price": 18.0, "quantity": 5},
]
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

app = FastAPI(title="3D Print Market Tracker")


class SalePayload(BaseModel):
    price: float | None = Field(default=None, ge=0)


class CheckoutLineItem(BaseModel):
    itemId: str = Field(min_length=1)
    quantity: int = Field(ge=1)
    unitPrice: float = Field(ge=0)


class CheckoutPayload(BaseModel):
    items: list[CheckoutLineItem] = Field(min_length=1)


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
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
        ensure_item_column(connection, "image_path", "TEXT")
        ensure_item_column(connection, "source_url", "TEXT")
        connection.commit()

    seed_demo_data_if_empty()


def ensure_item_column(connection: sqlite3.Connection, column_name: str, column_sql: str) -> None:
    columns = connection.execute("PRAGMA table_info(items)").fetchall()
    column_names = {row["name"] for row in columns}
    if column_name not in column_names:
        connection.execute(f"ALTER TABLE items ADD COLUMN {column_name} {column_sql}")


def seed_demo_data_if_empty() -> None:
    with closing(get_connection()) as connection:
        row = connection.execute("SELECT COUNT(*) AS count FROM items").fetchone()
        if row["count"] > 0:
            return

        for item in DEMO_ITEMS:
            connection.execute(
                """
                INSERT INTO items (id, name, price, quantity, starting_quantity, image_path, source_url)
                VALUES (?, ?, ?, ?, ?, NULL, NULL)
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


@app.get("/uploads/{filename:path}")
async def uploaded_file(filename: str) -> FileResponse:
    file_path = UPLOADS_DIR / filename
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(file_path)


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
async def create_item(
    name: str = Form(...),
    price: float = Form(...),
    quantity: int = Form(...),
    image: UploadFile | None = File(default=None),
) -> dict[str, Any]:
    clean_name = validate_name(name)
    validate_numeric_fields(price, quantity)
    image_path = await maybe_store_image(image)

    with closing(get_connection()) as connection:
        connection.execute(
            """
            INSERT INTO items (id, name, price, quantity, starting_quantity, image_path, source_url)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (str(uuid4()), clean_name, price, quantity, quantity, image_path, None),
        )
        connection.commit()

    return load_snapshot()


@app.put("/api/items/{item_id}")
async def update_item(
    item_id: str,
    name: str = Form(...),
    price: float = Form(...),
    quantity: int = Form(...),
    remove_image: bool = Form(default=False),
    image: UploadFile | None = File(default=None),
) -> dict[str, Any]:
    clean_name = validate_name(name)
    validate_numeric_fields(price, quantity)

    with closing(get_connection()) as connection:
        item = connection.execute(
            """
            SELECT
                items.id,
                items.image_path,
                items.source_url,
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

        next_image_path = item["image_path"]
        old_image_path = item["image_path"]

        if remove_image:
            next_image_path = None

        if image is not None and image.filename:
            next_image_path = await maybe_store_image(image)

        sold_count = int(item["sold_count"])
        starting_quantity = quantity + sold_count
        connection.execute(
            """
            UPDATE items
            SET name = ?, price = ?, quantity = ?, starting_quantity = ?, image_path = ?, source_url = ?
            WHERE id = ?
            """,
            (clean_name, price, quantity, starting_quantity, next_image_path, item["source_url"], item_id),
        )
        connection.commit()

    if next_image_path != old_image_path:
        delete_image(old_image_path)

    return load_snapshot()


@app.delete("/api/items/{item_id}")
def delete_item(item_id: str) -> dict[str, Any]:
    with closing(get_connection()) as connection:
        item = connection.execute("SELECT image_path FROM items WHERE id = ?", (item_id,)).fetchone()
        if item is None:
            raise HTTPException(status_code=404, detail="Item not found")

        connection.execute("DELETE FROM items WHERE id = ?", (item_id,))
        connection.commit()

    delete_image(item["image_path"])
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


@app.post("/api/checkout")
def checkout(payload: CheckoutPayload) -> dict[str, Any]:
    sold_at = datetime.now(timezone.utc).isoformat()

    with closing(get_connection()) as connection:
        requested_ids = [line.itemId for line in payload.items]
        placeholders = ",".join("?" for _ in requested_ids)
        item_rows = connection.execute(
            f"SELECT id, name, quantity FROM items WHERE id IN ({placeholders})",
            requested_ids,
        ).fetchall()
        items_by_id = {row["id"]: row for row in item_rows}

        aggregated_quantities: dict[str, int] = {}
        item_names: dict[str, str] = {}

        for line in payload.items:
            item = items_by_id.get(line.itemId)
            if item is None:
                raise HTTPException(status_code=404, detail="One or more items no longer exist")
            aggregated_quantities[line.itemId] = aggregated_quantities.get(line.itemId, 0) + line.quantity
            item_names[line.itemId] = item["name"]

        for item_id, requested_quantity in aggregated_quantities.items():
            if requested_quantity > int(items_by_id[item_id]["quantity"]):
                raise HTTPException(status_code=400, detail=f"Not enough stock for {item_names[item_id]}")

        for item_id, requested_quantity in aggregated_quantities.items():
            connection.execute(
                "UPDATE items SET quantity = quantity - ? WHERE id = ?",
                (requested_quantity, item_id),
            )

        for line in payload.items:
            for _ in range(line.quantity):
                connection.execute(
                    """
                    INSERT INTO sales (item_id, item_name, price, sold_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (line.itemId, item_names[line.itemId], line.unitPrice, sold_at),
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
                items.image_path,
                items.source_url,
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
            "imageUrl": build_image_url(row["image_path"]),
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


def build_image_url(image_path: str | None) -> str | None:
    if not image_path:
        return None
    return f"/uploads/{image_path}"


def validate_name(name: str) -> str:
    clean_name = name.strip()
    if not clean_name or len(clean_name) > 60:
        raise HTTPException(status_code=422, detail="Name must be between 1 and 60 characters")
    return clean_name


def validate_numeric_fields(price: float, quantity: int) -> None:
    if price < 0:
        raise HTTPException(status_code=422, detail="Price must be 0 or more")
    if quantity < 0:
        raise HTTPException(status_code=422, detail="Quantity must be 0 or more")


async def maybe_store_image(image: UploadFile | None) -> str | None:
    if image is None or not image.filename:
        return None

    suffix = ALLOWED_IMAGE_TYPES.get(image.content_type or "")
    if suffix is None:
        raise HTTPException(status_code=400, detail="Image must be JPG, PNG, WebP, or GIF")

    filename = f"{uuid4()}{suffix}"
    destination = UPLOADS_DIR / filename

    with destination.open("wb") as target:
        shutil.copyfileobj(image.file, target)

    return filename


def delete_image(image_path: str | None) -> None:
    if not image_path:
        return

    file_path = UPLOADS_DIR / image_path
    if file_path.exists():
        file_path.unlink()
