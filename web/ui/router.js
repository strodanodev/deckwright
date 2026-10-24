// Screens and the transitions between them (Rapture Chess's router). A screen is a full-viewport layer under #ui;
// go() fades the old one out and the new one in, or (wipe) closes a gilded iris over the view, swaps, and opens it.
import { h, icon, wait } from "./dom.js";

const root = document.getElementById("ui");
const iris = h("div", { class: "iris", aria: { hidden: "true" } }, h("div", { class: "iris-ring" }), h("div", { class: "iris-core" }));
document.body.append(iris);

const screens = new Map();
const listeners = [];
let current = null;
let busy = Promise.resolve();
const stack = [];

/** A screen: { id, el, enter?(from), leave?(), noBack? }. */
export function register(s) {
  screens.set(s.id, s);
  s.el.classList.add("screen");
  s.el.hidden = true;
  root.append(s.el);
}
export const onScreen = (fn) => { listeners.push(fn); };
export const currentScreen = () => current?.id ?? null;

/** Close the iris over everything, run `swap`, open it again. */
export async function wipe(swap) {
  iris.classList.remove("open");
  iris.classList.add("closing");
  await wait(420);
  await swap();
  iris.classList.remove("closing");
  iris.classList.add("open");
  await wait(520);
  iris.classList.remove("open");
}

/** Show a screen. `before` runs while the iris is closed (a wipe) or just before the swap. */
export function go(id, opts = {}) {
  busy = busy.then(async () => {
    const next = screens.get(id);
    if (!next) return;
    if (next === current) { await opts.before?.(); next.enter?.(current.id); return; }
    const prev = current;
    if (opts.push !== false && prev && !prev.noBack) stack.push(prev.id);
    const swap = () => {
      if (prev) { prev.el.hidden = true; prev.el.classList.remove("in", "out"); prev.leave?.(); }
      current = next;
      next.el.hidden = false;
      next.el.classList.remove("out");
      void next.el.offsetWidth;
      next.el.classList.add("in");
      next.enter?.(prev?.id ?? null);
      for (const fn of listeners) fn(next);
    };
    if (opts.wipe) { await wipe(async () => { await opts.before?.(); swap(); }); return; }
    if (prev) { prev.el.classList.add("out"); await wait(180); }
    await opts.before?.();
    swap();
  }).catch((e) => console.error("[router]", e));
  return busy;
}

/** Back to the screen that opened this one (home if none). */
export function back() { return go(stack.pop() ?? "home", { push: false }); }
export function resetStack() { stack.length = 0; }

/** The shared page header for a menu screen: back button, kicker and title, and a slot on the right. */
export function pageHead(title, kicker, right = null, onBack = back) {
  return h("header", { class: "page-head" },
    h("button", { class: "icon-btn back", type: "button", title: "Back", aria: { label: "Back" }, on: { click: () => void onBack() } }, icon("back")),
    h("div", { class: "page-title" }, h("span", { class: "kicker", text: kicker }), h("h1", { class: "display", text: title })),
    h("div", { class: "page-right" }, right));
}
