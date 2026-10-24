// DOM helpers for the UI layer. Dynamic strings only ever go through textContent (`h(tag, props, "text")`); the only
// markup set as HTML is the developer-authored SVG in `icon()`.
import { ICONS } from "./icons.js";

/** Build an element: h("button", { class, text, on: { click }, aria: { label }, data: { x } }, ...children). */
export function h(tag, props = null, ...children) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = String(v);
      else if (k === "text") e.textContent = String(v);
      else if (k === "style") e.setAttribute("style", String(v));
      else if (k === "aria") for (const [a, av] of Object.entries(v)) e.setAttribute(`aria-${a}`, av);
      else if (k === "data") for (const [a, av] of Object.entries(v)) e.dataset[a] = av;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === "hidden") e.hidden = !!v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/** A trusted, inline SVG icon. */
export function icon(name, cls = "") {
  const s = document.createElement("span");
  s.innerHTML = ICONS[name] ?? ICONS.spark;
  const svg = s.firstElementChild;
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.classList.add(...cls.split(" "));
  return svg;
}

/** Number the children of a container so their entrance animations run in order. */
export function stagger(el, baseMs = 0) {
  el.classList.remove("stagger");
  void el.offsetWidth;
  el.classList.add("stagger");
  if (baseMs) el.style.setProperty("--base", `${baseMs}ms`);
  [...el.children].forEach((c, i) => c.style.setProperty("--i", String(i)));
  return el;
}

/** A field of drifting embers (pure CSS); colours cycle through `colors`. Seeded, so it looks the same each load. */
export function embers(count, colors) {
  const box = h("div", { class: "embers", aria: { hidden: "true" } });
  let s = 11;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < count; i++) {
    const e = h("i");
    e.style.cssText = `left:${(rnd() * 100).toFixed(1)}%;--s:${(2 + rnd() * 3).toFixed(1)}px;--d:${(7 + rnd() * 9).toFixed(1)}s;--delay:${(-rnd() * 14).toFixed(1)}s;--dx:${((rnd() - 0.5) * 120).toFixed(0)}px;--c:${colors[i % colors.length]}`;
    box.append(e);
  }
  return box;
}

let toastBox = null;
/** A short notice at the top of the screen. */
export function toast(text, kind = "info") {
  if (!toastBox) { toastBox = h("div", { class: "toasts", aria: { live: "polite" } }); document.body.append(toastBox); }
  const t = h("div", { class: `toast${kind === "err" ? " err" : ""}` }, icon(kind === "err" ? "alert" : "spark"), h("span", { text }));
  toastBox.append(t);
  while (toastBox.children.length > 3) toastBox.firstElementChild.remove();
  setTimeout(() => t.remove(), 3300);
}

/** A modal panel over everything. Returns { close, root }. */
export function modal(title, body, { onClose } = {}) {
  const close = () => {
    scrim.classList.add("closing");
    document.removeEventListener("keydown", onKey, true);
    setTimeout(() => scrim.remove(), 200);
    onClose?.();
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  const closeBtn = h("button", { class: "icon-btn sm close", type: "button", title: "Close", aria: { label: "Close" }, on: { click: close } }, icon("close"));
  const panel = h("div", { class: "modal panel frame", role: "dialog", aria: { modal: "true", label: title } },
    h("div", { class: "panel-head" }, h("h2", { text: title }), closeBtn),
    h("div", { class: "panel-body" }, body));
  const scrim = h("div", { class: "scrim", on: { pointerdown: (e) => { if (e.target === scrim) close(); } } }, panel);
  document.addEventListener("keydown", onKey, true);
  document.body.append(scrim);
  closeBtn.focus({ preventScroll: true });
  return { close, root: panel };
}

/** Copy text to the clipboard and say how it went. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { toast("Couldn't copy: select the text and copy it", "err"); }
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
