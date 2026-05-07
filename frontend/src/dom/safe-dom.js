/** Safe DOM helpers: no-op when the node is missing (e.g. permission-hidden tab panels). */

export function resolveElement(idOrElement) {
  if (idOrElement == null) return null;
  if (typeof idOrElement === "string") return document.getElementById(idOrElement);
  if (typeof Element !== "undefined" && idOrElement instanceof Element) return idOrElement;
  return null;
}

export function setHtml(idOrElement, html) {
  const el = resolveElement(idOrElement);
  if (!el) return;
  el.innerHTML = html == null ? "" : String(html);
}

export function setText(idOrElement, text) {
  const el = resolveElement(idOrElement);
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

export function clearElement(idOrElement) {
  const el = resolveElement(idOrElement);
  if (!el) return;
  el.innerHTML = "";
}
