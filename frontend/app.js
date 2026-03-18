// Đổi thành URL backend thực tế sau khi deploy (Ingress External IP hoặc domain)
const API_BASE = window.ENV_API_BASE || "http://localhost:8000";

let todos = [];
let currentFilter = "all";

// ── API helpers ───────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

// ── Data ──────────────────────────────────────────────────────────────────────
async function loadTodos() {
  todos = await apiFetch("/todos");
  render();
}

async function addTodo(title) {
  const todo = await apiFetch("/todos", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  todos.unshift(todo);
  render();
}

async function toggleTodo(id) {
  const todo = todos.find((t) => t.id === id);
  const updated = await apiFetch(`/todos/${id}`, {
    method: "PUT",
    body: JSON.stringify({ done: !todo.done }),
  });
  todos = todos.map((t) => (t.id === id ? updated : t));
  render();
}

async function deleteTodo(id) {
  await apiFetch(`/todos/${id}`, { method: "DELETE" });
  todos = todos.filter((t) => t.id !== id);
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const list = document.getElementById("todo-list");
  const emptyMsg = document.getElementById("empty-msg");

  const filtered = todos.filter((t) => {
    if (currentFilter === "active") return !t.done;
    if (currentFilter === "done") return t.done;
    return true;
  });

  list.innerHTML = "";

  if (filtered.length === 0) {
    emptyMsg.classList.remove("hidden");
    return;
  }

  emptyMsg.classList.add("hidden");

  filtered.forEach((todo) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <input type="checkbox" ${todo.done ? "checked" : ""} data-id="${todo.id}" />
      <span class="todo-title ${todo.done ? "done" : ""}">${escapeHtml(todo.title)}</span>
      <button class="btn-delete" data-id="${todo.id}" title="Xóa">✕</button>
    `;
    list.appendChild(li);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.getElementById("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("todo-input");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  await addTodo(title);
});

document.getElementById("todo-list").addEventListener("change", async (e) => {
  if (e.target.type === "checkbox") {
    await toggleTodo(Number(e.target.dataset.id));
  }
});

document.getElementById("todo-list").addEventListener("click", async (e) => {
  if (e.target.classList.contains("btn-delete")) {
    await deleteTodo(Number(e.target.dataset.id));
  }
});

document.getElementById("filters").addEventListener("click", (e) => {
  if (!e.target.classList.contains("filter-btn")) return;
  document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
  e.target.classList.add("active");
  currentFilter = e.target.dataset.filter;
  render();
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadTodos();
