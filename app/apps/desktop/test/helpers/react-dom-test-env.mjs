/**
 * Minimal DOM shim for `node --test` mounting of React client components.
 *
 * The desktop test suite runs under `node --test` with no jsdom/happy-dom in
 * the dependency graph, so `react-dom/client` is driven against this small
 * element/document/window surface. It implements only what React's client
 * renderer touches while mounting simple DOM trees (divs, sections, spans,
 * buttons, text nodes) and running effects; it is not a general DOM.
 */
const noop = () => {};

function makeNode(type) {
  return {
    nodeType: type,
    nodeName:
      type === 1 ? "" : type === 3 ? "#text" : type === 8 ? "#comment" : "#document-fragment",
    childNodes: [],
    parentNode: null,
    ownerDocument: null,
    attributes: {},
    style: { setProperty: noop, removeProperty: noop },
    _text: "",
    _listeners: {},
    get firstChild() {
      return this.childNodes[0] ?? null;
    },
    get lastChild() {
      return this.childNodes[this.childNodes.length - 1] ?? null;
    },
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this._text;
      return this.childNodes.map((child) => child.textContent ?? "").join("");
    },
    set textContent(value) {
      this._text = String(value);
      this.childNodes = [];
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const index = ref ? this.childNodes.indexOf(ref) : -1;
      if (index === -1) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index !== -1) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name) {
      return name in this.attributes;
    },
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index !== -1) list.splice(index, 1);
    },
    contains(node) {
      return this === node || this.childNodes.some((child) => child.contains(node));
    },
    focus: noop,
    blur: noop,
    get className() {
      return this.attributes.class ?? "";
    },
    set className(value) {
      this.attributes.class = String(value);
    },
    get id() {
      return this.attributes.id ?? "";
    },
    set id(value) {
      this.attributes.id = String(value);
    },
  };
}

export function installMinimalDom() {
  const document = {
    nodeType: 9,
    documentElement: null,
    createElement(tag) {
      const el = makeNode(1);
      el.nodeName = String(tag).toUpperCase();
      el.tagName = String(tag).toUpperCase();
      el.localName = String(tag).toLowerCase();
      el.ownerDocument = document;
      return el;
    },
    createTextNode(text) {
      const node = makeNode(3);
      node._text = String(text);
      node.ownerDocument = document;
      return node;
    },
    createComment(data) {
      const node = makeNode(8);
      node._text = String(data);
      node.ownerDocument = document;
      return node;
    },
    createDocumentFragment() {
      const fragment = makeNode(11);
      fragment.ownerDocument = document;
      return fragment;
    },
    addEventListener: noop,
    removeEventListener: noop,
  };
  document.documentElement = document.createElement("html");
  document.head = document.createElement("head");
  document.body = document.createElement("body");
  document.documentElement.appendChild(document.head);
  document.documentElement.appendChild(document.body);
  document.activeElement = null;
  document.defaultView = null;

  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(callback) {
      return setTimeout(() => callback(Date.now()), 0);
    },
    cancelAnimationFrame(id) {
      clearTimeout(id);
    },
    devicePixelRatio: 1,
    location: { href: "http://localhost/" },
    navigator: { userAgent: "node" },
    getComputedStyle() {
      return { display: "block", getPropertyValue: () => "" };
    },
    matchMedia() {
      return {
        matches: false,
        addListener: noop,
        removeListener: noop,
        addEventListener: noop,
        removeEventListener: noop,
      };
    },
  };
  // React DOM's client renderer performs `element instanceof <Constructor>`
  // checks (e.g. `getActiveElementDeep`); each constructor needs a class or
  // `instanceof` throws on the undefined right-hand side.
  const elementConstructors = [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLIFrameElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
    "HTMLAnchorElement",
    "HTMLDivElement",
    "HTMLSpanElement",
  ];
  for (const name of elementConstructors) window[name] = class {};
  document.defaultView = window;

  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Node = window.Node;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1 };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return previous;
}

export function restoreGlobals(previous) {
  globalThis.window = previous.window;
  globalThis.document = previous.document;
}
