// Minimal DOM helpers — no framework, as specified.

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || (v === false && !k.startsWith("aria-"))) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "style") el.setAttribute("style", String(v));
    else el.setAttribute(k, v === true && !k.startsWith("aria-") ? "" : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  if (tag === "button" && !el.hasAttribute("aria-label") && el.title) el.setAttribute("aria-label",el.title);
  return el;
}

export function svg(path: string, size = 14, opts: { fill?: string; stroke?: number } = {}): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  if (opts.stroke) {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", String(opts.stroke));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  } else {
    p.setAttribute("fill", opts.fill ?? "currentColor");
  }
  el.append(p);
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Reconcile a card without moving the keyboard or scrolling a background update. */
export function preservePosition(container:HTMLElement,update:()=>void){
  const selector="button,input,select,[tabindex]";
  const identity=(el:HTMLElement)=>el.dataset.focusKey || el.dataset.taskId || el.getAttribute("aria-label") || el.title || el.textContent || "";
  const active=document.activeElement as HTMLElement|null;
  const inside=!!active && container.contains(active);
  const key=inside ? identity(active!):null;
  const oldScroll=[container,...container.querySelectorAll<HTMLElement>(".int-rows,.pills")].map(el=>({className:el.className,scroll:el.scrollTop}));
  update();
  for(const item of oldScroll){const el=[container,...container.querySelectorAll<HTMLElement>(".int-rows,.pills")].find(el=>el.className===item.className);if(el)el.scrollTop=item.scroll;}
  if(key!==null)Array.from(container.querySelectorAll<HTMLElement>(selector)).find(el=>identity(el)===key)?.focus({preventScroll:true});
}

/** Card dot used in every "who" row. */
export function dot(color: string, size = 7): HTMLElement {
  return h("i", {
    class: "dot",
    style: `width:${size}px;height:${size}px;background:${color}`,
  });
}
