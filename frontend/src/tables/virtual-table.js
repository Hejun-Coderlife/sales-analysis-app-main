import { clearElement, setHtml } from "../dom/safe-dom.js";

export function renderVirtualTable({
  container,
  columns,
  rows,
  rowHeight = 34,
  viewportHeight = 360,
}) {
  if (!container) return;
  const safeRows = Array.isArray(rows) ? rows : [];
  clearElement(container);
  container.style.position = "relative";
  container.style.overflow = "auto";
  container.style.height = `${viewportHeight}px`;

  const spacer = document.createElement("div");
  spacer.style.height = `${safeRows.length * rowHeight}px`;
  spacer.style.position = "relative";
  container.appendChild(spacer);

  const viewport = document.createElement("div");
  viewport.style.position = "absolute";
  viewport.style.left = "0";
  viewport.style.right = "0";
  viewport.style.top = "0";
  spacer.appendChild(viewport);

  const renderWindow = () => {
    const scrollTop = container.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 8);
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + 16;
    const end = Math.min(safeRows.length, start + visibleCount);

    clearElement(viewport);
    viewport.style.transform = `translateY(${start * rowHeight}px)`;

    for (let i = start; i < end; i += 1) {
      const row = safeRows[i];
      const rowEl = document.createElement("div");
      rowEl.style.display = "grid";
      rowEl.style.gridTemplateColumns = `repeat(${columns.length}, minmax(120px, 1fr))`;
      rowEl.style.minHeight = `${rowHeight}px`;
      rowEl.style.alignItems = "center";
      rowEl.style.borderBottom = "1px solid rgba(0,0,0,0.06)";
      rowEl.style.padding = "0 8px";
      for (const key of columns) {
        const cell = document.createElement("div");
        cell.textContent = String(row?.[key] ?? "");
        cell.style.whiteSpace = "nowrap";
        cell.style.overflow = "hidden";
        cell.style.textOverflow = "ellipsis";
        rowEl.appendChild(cell);
      }
      viewport.appendChild(rowEl);
    }
  };

  container.addEventListener("scroll", renderWindow);
  renderWindow();
}
