const state = {
  items: [],
  sales: [],
  loading: true,
};

const statsGrid = document.querySelector("#statsGrid");
const inventoryGrid = document.querySelector("#inventoryGrid");
const emptyState = document.querySelector("#emptyState");
const salesList = document.querySelector("#salesList");
const itemForm = document.querySelector("#itemForm");
const formTitle = document.querySelector("#formTitle");
const itemIdInput = document.querySelector("#itemId");
const itemNameInput = document.querySelector("#itemName");
const itemPriceInput = document.querySelector("#itemPrice");
const itemQuantityInput = document.querySelector("#itemQuantity");
const cancelEditButton = document.querySelector("#cancelEditButton");
const undoSaleButton = document.querySelector("#undoSaleButton");
const exportSalesButton = document.querySelector("#exportSalesButton");
const priceDialog = document.querySelector("#priceDialog");
const priceDialogLabel = document.querySelector("#priceDialogLabel");
const priceForm = document.querySelector("#priceForm");
const customSalePriceInput = document.querySelector("#customSalePrice");
const closePriceDialogButton = document.querySelector("#closePriceDialogButton");
const itemCardTemplate = document.querySelector("#itemCardTemplate");
const statusMessage = document.querySelector("#statusMessage");

let customSaleItemId = null;

render();
loadData();

itemForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = itemNameInput.value.trim();
  const price = Number(itemPriceInput.value);
  const quantity = Number(itemQuantityInput.value);

  if (!name || Number.isNaN(price) || Number.isNaN(quantity) || quantity < 0 || price < 0) {
    return;
  }

  const method = itemIdInput.value ? "PUT" : "POST";
  const endpoint = itemIdInput.value ? `/api/items/${itemIdInput.value}` : "/api/items";

  await syncWithServer(endpoint, {
    method,
    body: JSON.stringify({ name, price, quantity }),
  });

  resetForm();
});

cancelEditButton.addEventListener("click", () => {
  resetForm();
});

undoSaleButton.addEventListener("click", async () => {
  await syncWithServer("/api/sales/undo", { method: "POST" });
});

exportSalesButton.addEventListener("click", () => {
  window.location.href = "/api/sales/export.csv";
});

priceForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!customSaleItemId) {
    return;
  }

  const price = Number(customSalePriceInput.value);
  if (Number.isNaN(price) || price < 0) {
    return;
  }

  const completed = await syncWithServer(`/api/items/${customSaleItemId}/sell`, {
    method: "POST",
    body: JSON.stringify({ price }),
  });

  if (completed) {
    closePriceDialog();
  }
});

closePriceDialogButton.addEventListener("click", closePriceDialog);

if (typeof priceDialog.addEventListener === "function") {
  priceDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closePriceDialog();
  });
}

async function loadData() {
  state.loading = true;
  render();
  await syncWithServer("/api/bootstrap", { method: "GET" });
}

async function syncWithServer(url, options) {
  clearStatus();

  try {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      ...options,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || "Request failed");
    }

    state.items = payload.items;
    state.sales = payload.sales;
    state.loading = false;
    render();
    return true;
  } catch (error) {
    state.loading = false;
    render();
    showStatus(error.message || "Something went wrong while talking to the server.");
    return false;
  }
}

function openCustomPriceDialog(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);

  if (!item || item.quantity <= 0) {
    return;
  }

  customSaleItemId = itemId;
  priceDialogLabel.textContent = `Record a sale for ${item.name}.`;
  customSalePriceInput.value = item.price.toFixed(2);

  if (typeof priceDialog.showModal === "function") {
    priceDialog.showModal();
  }
}

function closePriceDialog() {
  customSaleItemId = null;
  priceForm.reset();
  if (priceDialog.open) {
    priceDialog.close();
  }
}

function startEdit(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);

  if (!item) {
    return;
  }

  itemIdInput.value = item.id;
  itemNameInput.value = item.name;
  itemPriceInput.value = item.price.toFixed(2);
  itemQuantityInput.value = item.quantity;
  formTitle.textContent = `Edit ${item.name}`;
  cancelEditButton.classList.remove("hidden");
  itemNameInput.focus();
}

function resetForm() {
  itemForm.reset();
  itemIdInput.value = "";
  formTitle.textContent = "Add New Print";
  cancelEditButton.classList.add("hidden");
}

async function deleteItem(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const confirmed = window.confirm(`Delete ${item.name}? Existing sales history will stay in the log.`);
  if (!confirmed) {
    return;
  }

  if (itemIdInput.value === itemId) {
    resetForm();
  }

  await syncWithServer(`/api/items/${itemId}`, { method: "DELETE" });
}

async function recordSale(itemId, priceOverride = null) {
  await syncWithServer(`/api/items/${itemId}/sell`, {
    method: "POST",
    body: JSON.stringify(priceOverride === null ? {} : { price: priceOverride }),
  });
}

function render() {
  renderStats();
  renderInventory();
  renderSales();
  undoSaleButton.disabled = state.loading || state.sales.length === 0;
  exportSalesButton.disabled = state.loading;
}

function renderStats() {
  const revenue = state.sales.reduce((sum, sale) => sum + sale.price, 0);
  const unitsSold = state.sales.length;
  const itemsInStock = state.items.reduce((sum, item) => sum + item.quantity, 0);
  const lowStock = state.items.filter((item) => item.quantity > 0 && item.quantity <= 2).length;

  const stats = [
    { label: "Revenue", value: formatCurrency(revenue) },
    { label: "Units Sold", value: String(unitsSold) },
    { label: "Items Left", value: String(itemsInStock) },
    { label: "Low Stock", value: String(lowStock) },
  ];

  statsGrid.innerHTML = "";
  for (const stat of stats) {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `
      <span class="stat-label">${stat.label}</span>
      <strong class="stat-value">${stat.value}</strong>
    `;
    statsGrid.appendChild(card);
  }
}

function renderInventory() {
  inventoryGrid.innerHTML = "";
  emptyState.classList.toggle("hidden", state.items.length > 0 || state.loading);
  emptyState.textContent = state.loading
    ? "Loading inventory..."
    : "Add your first print below to start tracking sales.";

  for (const item of state.items) {
    const fragment = itemCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".item-card");
    const sellButton = fragment.querySelector(".sell-button");
    const customButton = fragment.querySelector(".custom-button");
    const editButton = fragment.querySelector(".edit-button");
    const deleteButton = fragment.querySelector(".delete-button");
    const itemName = fragment.querySelector(".item-name");
    const itemPrice = fragment.querySelector(".item-price");
    const stockPill = fragment.querySelector(".stock-pill");

    const soldOut = item.quantity <= 0;
    const disabled = state.loading || soldOut;

    itemName.textContent = item.name;
    itemPrice.textContent = `${formatCurrency(item.price)} default price`;
    stockPill.textContent = soldOut ? "Sold out" : `${item.quantity} left`;
    sellButton.disabled = disabled;
    customButton.disabled = disabled;
    editButton.disabled = state.loading;
    deleteButton.disabled = state.loading;
    sellButton.innerHTML = `
      <span class="item-name">${item.name}</span>
      <span>${formatCurrency(item.price)}</span>
      <span class="sell-hint">${soldOut ? "Restock to keep selling" : "Tap to record one sale"}</span>
    `;

    sellButton.addEventListener("click", () => {
      recordSale(item.id);
    });

    customButton.addEventListener("click", () => {
      openCustomPriceDialog(item.id);
    });

    editButton.addEventListener("click", () => {
      startEdit(item.id);
    });

    deleteButton.addEventListener("click", () => {
      deleteItem(item.id);
    });

    if (item.quantity <= 2 && !soldOut) {
      card.classList.add("low-stock");
    }

    inventoryGrid.appendChild(fragment);
  }
}

function renderSales() {
  salesList.innerHTML = "";

  if (state.loading) {
    const loadingMessage = document.createElement("div");
    loadingMessage.className = "empty-state";
    loadingMessage.textContent = "Loading recent sales...";
    salesList.appendChild(loadingMessage);
    return;
  }

  if (state.sales.length === 0) {
    const emptyMessage = document.createElement("div");
    emptyMessage.className = "empty-state";
    emptyMessage.textContent = "No sales recorded yet.";
    salesList.appendChild(emptyMessage);
    return;
  }

  for (const sale of state.sales.slice(0, 12)) {
    const entry = document.createElement("article");
    entry.className = "sales-entry";
    entry.innerHTML = `
      <div>
        <strong>${sale.itemName}</strong>
        <time datetime="${sale.soldAt}">${formatDateTime(sale.soldAt)}</time>
      </div>
      <span class="sales-price">${formatCurrency(sale.price)}</span>
    `;
    salesList.appendChild(entry);
  }
}

function showStatus(message) {
  statusMessage.textContent = message;
  statusMessage.classList.remove("hidden");
}

function clearStatus() {
  statusMessage.textContent = "";
  statusMessage.classList.add("hidden");
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}
