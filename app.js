const THEME_STORAGE_KEY = "print-market-tracker-theme";

const state = {
  items: [],
  sales: [],
  cart: [],
  loading: true,
  searchTerm: "",
  theme: loadTheme(),
};

const root = document.documentElement;
const statsGrid = document.querySelector("#statsGrid");
const inventoryGrid = document.querySelector("#inventoryGrid");
const emptyState = document.querySelector("#emptyState");
const salesList = document.querySelector("#salesList");
const cartList = document.querySelector("#cartList");
const cartCount = document.querySelector("#cartCount");
const cartTotal = document.querySelector("#cartTotal");
const itemForm = document.querySelector("#itemForm");
const formTitle = document.querySelector("#formTitle");
const itemIdInput = document.querySelector("#itemId");
const itemNameInput = document.querySelector("#itemName");
const itemPriceInput = document.querySelector("#itemPrice");
const itemQuantityInput = document.querySelector("#itemQuantity");
const itemImageInput = document.querySelector("#itemImage");
const removeImageInput = document.querySelector("#removeImage");
const imageHelpText = document.querySelector("#imageHelpText");
const pasteZone = document.querySelector("#pasteZone");
const pasteHelpText = document.querySelector("#pasteHelpText");
const imagePreview = document.querySelector("#imagePreview");
const imagePreviewImg = document.querySelector("#imagePreviewImg");
const clearImageButton = document.querySelector("#clearImageButton");
const searchInput = document.querySelector("#searchInput");
const cancelEditButton = document.querySelector("#cancelEditButton");
const undoSaleButton = document.querySelector("#undoSaleButton");
const exportSalesButton = document.querySelector("#exportSalesButton");
const clearCartButton = document.querySelector("#clearCartButton");
const checkoutButton = document.querySelector("#checkoutButton");
const themeToggleButton = document.querySelector("#themeToggleButton");
const priceDialog = document.querySelector("#priceDialog");
const priceDialogLabel = document.querySelector("#priceDialogLabel");
const priceForm = document.querySelector("#priceForm");
const customSalePriceInput = document.querySelector("#customSalePrice");
const closePriceDialogButton = document.querySelector("#closePriceDialogButton");
const itemCardTemplate = document.querySelector("#itemCardTemplate");
const cartItemTemplate = document.querySelector("#cartItemTemplate");
const statusMessage = document.querySelector("#statusMessage");

let customSaleItemId = null;
let pendingImageFile = null;
let pendingImageUrl = null;

applyTheme(state.theme);
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

  const formData = new FormData();
  formData.append("name", name);
  formData.append("price", String(price));
  formData.append("quantity", String(quantity));

  const selectedImage = itemImageInput.files[0];
  const imageToSubmit = selectedImage || pendingImageFile;
  if (imageToSubmit) {
    formData.append("image", imageToSubmit);
  }

  if (itemIdInput.value && removeImageInput.checked) {
    formData.append("remove_image", "true");
  }

  const method = itemIdInput.value ? "PUT" : "POST";
  const endpoint = itemIdInput.value ? `/api/items/${itemIdInput.value}` : "/api/items";
  const completed = await syncWithServer(endpoint, { method, body: formData });

  if (completed) {
    resetForm();
  }
});

cancelEditButton.addEventListener("click", resetForm);

itemImageInput.addEventListener("change", () => {
  const selectedImage = itemImageInput.files[0] || null;
  if (!selectedImage) {
    clearPendingImagePreview();
    return;
  }

  setPendingImage(selectedImage, `Selected file: ${selectedImage.name}`);
});

pasteZone.addEventListener("paste", (event) => {
  const clipboardItems = Array.from(event.clipboardData?.items || []);
  const imageItem = clipboardItems.find((item) => item.type.startsWith("image/"));
  if (!imageItem) {
    showStatus("Clipboard does not contain an image.");
    return;
  }

  const file = imageItem.getAsFile();
  if (!file) {
    showStatus("Could not read the pasted image.");
    return;
  }

  const extension = file.type.split("/")[1] || "png";
  const pastedFile = new File([file], `pasted-image.${extension}`, { type: file.type });
  setPendingImage(pastedFile, "Pasted image ready to save.");
  clearStatus();
  event.preventDefault();
});

clearImageButton.addEventListener("click", () => {
  clearPendingImagePreview();
});

searchInput.addEventListener("input", (event) => {
  state.searchTerm = event.target.value.trim().toLowerCase();
  renderInventory();
});

undoSaleButton.addEventListener("click", async () => {
  await syncWithServer("/api/sales/undo", { method: "POST" });
});

exportSalesButton.addEventListener("click", () => {
  window.location.href = "/api/sales/export.csv";
});

clearCartButton.addEventListener("click", () => {
  state.cart = [];
  render();
});

checkoutButton.addEventListener("click", async () => {
  if (state.cart.length === 0) {
    return;
  }

  const completed = await syncWithServer("/api/checkout", {
    method: "POST",
    body: JSON.stringify({
      items: state.cart.map((entry) => ({
        itemId: entry.itemId,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice,
      })),
    }),
  });

  if (completed) {
    state.cart = [];
    render();
  }
});

themeToggleButton.addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme(state.theme);
  localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  render();
});

priceForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!customSaleItemId) {
    return;
  }

  const price = Number(customSalePriceInput.value);
  if (Number.isNaN(price) || price < 0) {
    return;
  }

  addToCart(customSaleItemId, price);
  closePriceDialog();
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
    const requestOptions = { ...options };
    if (!(requestOptions.body instanceof FormData)) {
      requestOptions.headers = {
        "Content-Type": "application/json",
        ...(requestOptions.headers || {}),
      };
    }

    const response = await fetch(url, requestOptions);
    const payload = await parseApiResponse(response);

    if (!response.ok) {
      throw new Error(payload.detail || "Request failed");
    }

    state.items = payload.items;
    state.sales = payload.sales;
    state.loading = false;
    pruneCartToStock();
    render();
    return true;
  } catch (error) {
    state.loading = false;
    render();
    showStatus(error.message || "Something went wrong while talking to the server.");
    return false;
  }
}

async function parseApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  const text = await response.text();
  return { detail: text || "Unexpected server response" };
}

function addToCart(itemId, unitPrice = null) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  const price = unitPrice ?? item.price;
  const existingEntry = state.cart.find(
    (entry) => entry.itemId === itemId && Number(entry.unitPrice) === Number(price)
  );
  const cartQuantity = getCartQuantity(itemId);

  if (cartQuantity >= item.quantity) {
    showStatus(`No more ${item.name} are available to add.`);
    return;
  }

  if (existingEntry) {
    existingEntry.quantity += 1;
  } else {
    state.cart.push({
      itemId: item.id,
      itemName: item.name,
      unitPrice: price,
      quantity: 1,
    });
  }

  clearStatus();
  render();
}

function openCustomPriceDialog(itemId) {
  const item = state.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  if (getCartQuantity(itemId) >= item.quantity) {
    showStatus(`No more ${item.name} are available to add.`);
    return;
  }

  customSaleItemId = itemId;
  priceDialogLabel.textContent = `Add ${item.name} to the cart with a custom unit price.`;
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
  removeImageInput.checked = false;
  removeImageInput.disabled = !item.imageUrl;
  clearPendingImagePreview();
  imageHelpText.textContent = item.imageUrl
    ? "Leave the file empty to keep the current image, or upload a new one to replace it."
    : "Optional. Upload a JPG, PNG, WebP, or GIF.";
  formTitle.textContent = `Edit ${item.name}`;
  cancelEditButton.classList.remove("hidden");
  itemNameInput.focus();
}

function resetForm() {
  itemForm.reset();
  itemIdInput.value = "";
  formTitle.textContent = "Add New Print";
  cancelEditButton.classList.add("hidden");
  clearPendingImagePreview();
  removeImageInput.checked = false;
  removeImageInput.disabled = true;
  imageHelpText.textContent = "Optional. Upload a JPG, PNG, WebP, or GIF.";
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

  state.cart = state.cart.filter((entry) => entry.itemId !== itemId);
  await syncWithServer(`/api/items/${itemId}`, { method: "DELETE" });
}

function changeCartQuantity(itemId, unitPrice, delta) {
  const entry = state.cart.find(
    (cartEntry) => cartEntry.itemId === itemId && Number(cartEntry.unitPrice) === Number(unitPrice)
  );
  const item = state.items.find((currentItem) => currentItem.id === itemId);
  if (!entry || !item) {
    return;
  }

  if (delta > 0 && getCartQuantity(itemId) >= item.quantity) {
    showStatus(`No more ${item.name} are available to add.`);
    return;
  }

  entry.quantity += delta;
  if (entry.quantity <= 0) {
    removeFromCart(itemId, unitPrice);
  } else {
    clearStatus();
    render();
  }
}

function removeFromCart(itemId, unitPrice) {
  state.cart = state.cart.filter(
    (entry) => !(entry.itemId === itemId && Number(entry.unitPrice) === Number(unitPrice))
  );
  render();
}

function render() {
  updateThemeToggle();
  renderStats();
  renderInventory();
  renderCart();
  renderSales();

  const hasCart = state.cart.length > 0;
  undoSaleButton.disabled = state.loading || state.sales.length === 0;
  exportSalesButton.disabled = state.loading;
  searchInput.disabled = state.loading;
  clearCartButton.disabled = state.loading || !hasCart;
  checkoutButton.disabled = state.loading || !hasCart;
}

function renderStats() {
  const revenue = state.sales.reduce((sum, sale) => sum + sale.price, 0);
  const unitsSold = state.sales.length;
  const itemsInStock = state.items.reduce((sum, item) => sum + item.quantity, 0);
  const potentialRevenue = state.items.reduce(
    (sum, item) => sum + item.quantity * item.price,
    0
  );
  const lowStock = state.items.filter((item) => item.quantity > 0 && item.quantity <= 2).length;
  const stats = [
    { label: "Revenue", value: formatCurrency(revenue) },
    { label: "Units Sold", value: String(unitsSold) },
    { label: "Items Left", value: String(itemsInStock) },
    { label: "Potential Revenue", value: formatCurrency(potentialRevenue) },
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

  const visibleItems = state.items.filter((item) =>
    item.name.toLowerCase().includes(state.searchTerm)
  );

  emptyState.classList.toggle("hidden", visibleItems.length > 0 || state.loading);
  if (state.loading) {
    emptyState.textContent = "Loading inventory...";
  } else if (state.searchTerm && visibleItems.length === 0) {
    emptyState.textContent = "No prints match that search.";
  } else {
    emptyState.textContent = "Add your first print below to start tracking sales.";
  }

  for (const item of visibleItems) {
    const fragment = itemCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".item-card");
    const addButton = fragment.querySelector(".sell-button");
    const customButton = fragment.querySelector(".custom-button");
    const editButton = fragment.querySelector(".edit-button");
    const deleteButton = fragment.querySelector(".delete-button");
    const itemName = fragment.querySelector(".item-name");
    const itemPrice = fragment.querySelector(".item-price");
    const stockPill = fragment.querySelector(".stock-pill");
    const itemImage = fragment.querySelector(".item-image");
    const imagePlaceholder = fragment.querySelector(".image-placeholder");
    const reservedQuantity = getCartQuantity(item.id);
    const availableQuantity = Math.max(0, item.quantity - reservedQuantity);
    const soldOut = availableQuantity <= 0;

    itemName.textContent = item.name;
    itemPrice.textContent = `${formatCurrency(item.price)} default price`;
    stockPill.textContent = soldOut ? "In cart / sold out" : `${availableQuantity} left`;
    addButton.disabled = state.loading || soldOut;
    customButton.disabled = state.loading || soldOut;
    editButton.disabled = state.loading;
    deleteButton.disabled = state.loading;
    addButton.innerHTML = `
      <span class="item-name">${item.name}</span>
      <span>${formatCurrency(item.price)}</span>
      <span class="sell-hint">${soldOut ? "No more available for this order" : "Tap to add one to cart"}</span>
    `;

    if (item.imageUrl) {
      itemImage.src = item.imageUrl;
      itemImage.alt = item.name;
      itemImage.classList.remove("hidden");
      imagePlaceholder.classList.add("hidden");
    } else {
      itemImage.classList.add("hidden");
      imagePlaceholder.classList.remove("hidden");
    }

    addButton.addEventListener("click", () => addToCart(item.id));
    customButton.addEventListener("click", () => openCustomPriceDialog(item.id));
    editButton.addEventListener("click", () => startEdit(item.id));
    deleteButton.addEventListener("click", () => deleteItem(item.id));

    if (availableQuantity <= 2 && !soldOut) {
      card.classList.add("low-stock");
    }

    inventoryGrid.appendChild(fragment);
  }
}

function renderCart() {
  cartList.innerHTML = "";

  if (state.loading) {
    const loadingMessage = document.createElement("div");
    loadingMessage.className = "empty-state";
    loadingMessage.textContent = "Loading cart...";
    cartList.appendChild(loadingMessage);
  } else if (state.cart.length === 0) {
    const emptyMessage = document.createElement("div");
    emptyMessage.className = "empty-state";
    emptyMessage.textContent = "Tap prints to add them to the cart.";
    cartList.appendChild(emptyMessage);
  } else {
    for (const entry of state.cart) {
      const fragment = cartItemTemplate.content.cloneNode(true);
      const name = fragment.querySelector(".cart-item-name");
      const meta = fragment.querySelector(".cart-item-meta");
      const qty = fragment.querySelector(".cart-qty");
      const increment = fragment.querySelector('[data-action="increment"]');
      const decrement = fragment.querySelector('[data-action="decrement"]');
      const priceButton = fragment.querySelector(".cart-price-button");
      const removeButton = fragment.querySelector(".cart-remove-button");

      name.textContent = entry.itemName;
      meta.textContent = `${formatCurrency(entry.unitPrice)} each • ${formatCurrency(entry.unitPrice * entry.quantity)} total`;
      qty.textContent = entry.quantity;

      increment.disabled = state.loading;
      decrement.disabled = state.loading;
      priceButton.disabled = state.loading;
      removeButton.disabled = state.loading;

      increment.addEventListener("click", () => changeCartQuantity(entry.itemId, entry.unitPrice, 1));
      decrement.addEventListener("click", () => changeCartQuantity(entry.itemId, entry.unitPrice, -1));
      priceButton.addEventListener("click", () => openCustomPriceDialog(entry.itemId));
      removeButton.addEventListener("click", () => removeFromCart(entry.itemId, entry.unitPrice));

      cartList.appendChild(fragment);
    }
  }

  cartCount.textContent = String(
    state.cart.reduce((sum, entry) => sum + entry.quantity, 0)
  );
  cartTotal.textContent = formatCurrency(
    state.cart.reduce((sum, entry) => sum + entry.quantity * entry.unitPrice, 0)
  );
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

function getCartQuantity(itemId) {
  return state.cart
    .filter((entry) => entry.itemId === itemId)
    .reduce((sum, entry) => sum + entry.quantity, 0);
}

function pruneCartToStock() {
  const nextCart = [];
  const usedByItem = {};

  for (const entry of state.cart) {
    const item = state.items.find((currentItem) => currentItem.id === entry.itemId);
    if (!item) {
      continue;
    }

    const used = usedByItem[entry.itemId] ?? 0;
    const remaining = Math.max(0, item.quantity - used);
    if (remaining <= 0) {
      continue;
    }

    const nextQuantity = Math.min(entry.quantity, remaining);
    usedByItem[entry.itemId] = used + nextQuantity;
    nextCart.push({ ...entry, itemName: item.name, quantity: nextQuantity });
  }

  state.cart = nextCart;
}

function setPendingImage(file, helpText) {
  clearPendingImagePreview(false);
  pendingImageFile = file;
  pendingImageUrl = URL.createObjectURL(file);
  imagePreviewImg.src = pendingImageUrl;
  imagePreview.classList.remove("hidden");
  pasteHelpText.textContent = helpText;
}

function clearPendingImagePreview(resetInput = true) {
  pendingImageFile = null;
  if (pendingImageUrl) {
    if (pendingImageUrl.startsWith("blob:")) {
      URL.revokeObjectURL(pendingImageUrl);
    }
    pendingImageUrl = null;
  }

  imagePreviewImg.removeAttribute("src");
  imagePreview.classList.add("hidden");
  pasteHelpText.textContent = "Click here and press `Cmd+V` or `Ctrl+V` to paste an image from your clipboard.";

  if (resetInput) {
    itemImageInput.value = "";
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

function loadTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  if (savedTheme === "dark" || savedTheme === "light") {
    return savedTheme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  root.dataset.theme = theme;
}

function updateThemeToggle() {
  const isDark = state.theme === "dark";
  themeToggleButton.setAttribute("aria-pressed", String(isDark));
  themeToggleButton.querySelector(".theme-toggle-label").textContent = isDark ? "Light Mode" : "Dark Mode";
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
