const DEFAULT_BACKEND = "http://localhost:3000";
const STORAGE_KEY = "gpt-backend-url";

const state = {
  backend: localStorage.getItem(STORAGE_KEY) || resolveDefaultBackend(),
  view: "blocks",
};

function resolveDefaultBackend() {
  const meta = document.querySelector('meta[name="backend-url"]');
  if (meta && meta.content && meta.content.trim()) return meta.content.trim();
  if (window.__BACKEND_URL__) return window.__BACKEND_URL__;
  // Try same host on port 3000 as a sane default in compose.
  try {
    const url = new URL(window.location.href);
    url.port = "3000";
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_BACKEND;
  }
}

function $(selector) {
  return document.querySelector(selector);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll("nav button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("hidden", section.id !== `view-${view}`);
  });
  if (view === "blocks") loadBlocks();
  if (view === "ranges") loadRanges();
}

function formGet(form) {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) {
    const trimmed = String(value).trim();
    if (trimmed.length > 0) params.set(key, trimmed);
  }
  return params;
}

function fmtGwei(weiStr) {
  if (weiStr === undefined || weiStr === null) return "—";
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 1_000_000_000n;
    const frac = wei % 1_000_000_000n;
    if (frac === 0n) return `${whole.toString()}`;
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    return `${whole.toString()}.${fracStr}`;
  } catch {
    return String(weiStr);
  }
}

function fmtRatio(usedStr, limitStr) {
  if (!usedStr || !limitStr) return "—";
  try {
    const used = BigInt(usedStr);
    const limit = BigInt(limitStr);
    if (limit === 0n) return `${used.toString()} / 0`;
    const pct = Number((used * 10_000n) / limit) / 100;
    return `${used.toString()} / ${limit.toString()} (${pct.toFixed(2)}%)`;
  } catch {
    return `${usedStr} / ${limitStr}`;
  }
}

function fmtDate(value) {
  if (!value) return "—";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return value;
  }
}

async function fetchJson(path, params) {
  const url = new URL(path, state.backend.endsWith("/") ? state.backend : state.backend + "/");
  if (params) {
    for (const [k, v] of params.entries()) url.searchParams.set(k, v);
  }
  const response = await fetch(url.toString(), { mode: "cors" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

async function loadBlocks() {
  const summary = $("#blocks-summary");
  const tbody = $("#blocks-table tbody");
  summary.textContent = "Loading…";
  summary.classList.remove("error");
  tbody.innerHTML = "";
  try {
    const params = formGet($("#blocks-filter"));
    const body = await fetchJson("blocks", params);
    summary.textContent = `${body.count} blocks${body.truncated ? " (truncated to 10 000)" : ""}`;
    body.blocks
      .slice()
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="num">${row.blockNumber}</td>
          <td>${fmtDate(row.blockDate)}</td>
          <td class="num">${row.transactionCount}</td>
          <td class="num">${fmtGwei(row.baseBlockFeeWei)}</td>
          <td class="num">${fmtGwei(row.averagePriorityFeeWei)}</td>
          <td class="num">${fmtGwei(row.averagePriorityFeeWeightedWei)}</td>
          <td class="num">${fmtGwei(row.averageTransactionFeeWei)}</td>
          <td class="num">${fmtRatio(row.totalGasUsed, row.maxGasInBlock)}</td>
        `;
        tbody.appendChild(tr);
      });
  } catch (error) {
    summary.textContent = `Failed to load blocks: ${error.message}`;
    summary.classList.add("error");
  }
}

async function loadRanges() {
  const summary = $("#ranges-summary");
  const tbody = $("#ranges-table tbody");
  summary.textContent = "Loading…";
  summary.classList.remove("error");
  tbody.innerHTML = "";
  try {
    const params = formGet($("#ranges-filter"));
    const body = await fetchJson("ranges", params);
    summary.textContent = `${body.count} ranges${body.truncated ? " (truncated to 10 000)" : ""}`;
    body.ranges
      .slice()
      .sort((a, b) => b.rangeStart - a.rangeStart)
      .forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="num">${row.rangeSize}</td>
          <td class="num">${row.rangeStart}</td>
          <td class="num">${row.rangeEnd}</td>
          <td>${fmtDate(row.minBlockDate)}</td>
          <td>${fmtDate(row.maxBlockDate)}</td>
          <td class="num">${fmtGwei(row.averageBaseFeeWei)}</td>
          <td class="num">${fmtGwei(row.averagePriorityFeeWei)}</td>
          <td class="num">${fmtGwei(row.averagePriorityFeeWeightedWei)}</td>
          <td class="num">${row.transactionCount}</td>
          <td class="num">${fmtRatio(row.totalGasUsed, row.totalMaxGas)}</td>
        `;
        tbody.appendChild(tr);
      });
  } catch (error) {
    summary.textContent = `Failed to load ranges: ${error.message}`;
    summary.classList.add("error");
  }
}

function wireUp() {
  $("#backend").value = state.backend;
  $("#reload").addEventListener("click", () => {
    const next = $("#backend").value.trim() || DEFAULT_BACKEND;
    state.backend = next.replace(/\/$/, "");
    localStorage.setItem(STORAGE_KEY, state.backend);
    if (state.view === "blocks") loadBlocks();
    else loadRanges();
  });

  document.querySelectorAll("nav button").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  $("#blocks-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    loadBlocks();
  });
  $("#ranges-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    loadRanges();
  });

  setView("blocks");
}

wireUp();
