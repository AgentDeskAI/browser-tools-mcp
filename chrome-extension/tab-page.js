/**
 * Runs inside a tab via chrome.scripting.executeScript.
 *
 * btmcpReadPage and btmcpSemanticSnapshot stay in the isolated world.
 * btmcpSoftAct and btmcpActOnRef run in the page's main world so the native
 * value setter and execCommand reach React, Vue, and rich editors.
 * None of them calls the debugger API or focuses the browser window.
 *
 * A semantic snapshot stamps data-btmcp-ref on each mapped element. The same
 * element keeps that ref until the document is replaced. Acting on a ref uses
 * the soft click and type gates, then reports URL, console, and failed-request
 * changes that happened after the action.
 */

function btmcpScrubText(value) {
  var text = String(value == null ? "" : value);
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted]");
  text = text.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, "[redacted]");
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "[redacted]");
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, "[redacted]");
  text = text.replace(/\b(?:bearer\s+)\S+/gi, "bearer [redacted]");
  text = text.replace(/\b\d{13,19}\b/g, "[redacted]");
  return text;
}

function btmcpSkipText(element) {
  var tag = element && element.tagName;
  return tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
}

function btmcpReadPage() {
  var headings = [];
  var nodes = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  var limit = Math.min(nodes.length, 30);
  for (var i = 0; i < limit; i++) {
    var heading = nodes[i];
    var level = Number(heading.tagName.slice(1));
    var text = btmcpScrubText((heading.innerText || heading.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 200);
    if (text) headings.push({ level: level, text: text });
  }

  var excerpt = "";
  var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      var parent = node.parentElement;
      if (!parent || btmcpSkipText(parent) || parent.closest("script, style, textarea, input, select")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  var chunk;
  while ((chunk = walker.nextNode())) {
    var piece = (chunk.textContent || "").replace(/\s+/g, " ").trim();
    if (!piece) continue;
    excerpt = excerpt ? excerpt + " " + piece : piece;
    if (excerpt.length >= 800) break;
  }
  excerpt = btmcpScrubText(excerpt).slice(0, 800);

  var roleByTag = {
    A: "link",
    BUTTON: "button",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    INPUT: "textbox",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    NAV: "navigation",
    MAIN: "main",
    FORM: "form",
    IMG: "img",
  };
  var snapshot = [];

  function nodeName(element) {
    var aria = element.getAttribute && element.getAttribute("aria-label");
    if (aria) return btmcpScrubText(aria).slice(0, 80);
    var tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if ((element.getAttribute("type") || "").toLowerCase() === "password") return "password";
      var placeholder = element.getAttribute("placeholder");
      if (placeholder) return btmcpScrubText(placeholder).slice(0, 80);
      return element.getAttribute("name") || element.id || "";
    }
    var raw = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    return btmcpScrubText(raw).slice(0, 80);
  }

  function walk(element, depth) {
    if (!element || snapshot.length >= 60 || depth > 4) return;
    var tag = element.tagName;
    var role = (element.getAttribute && element.getAttribute("role")) || roleByTag[tag];
    if (role && tag !== "SCRIPT" && tag !== "STYLE") {
      snapshot.push({ depth: depth, role: role, name: nodeName(element) });
    }
    var children = element.children || [];
    for (var c = 0; c < children.length; c++) walk(children[c], depth + 1);
  }

  walk(document.body || document.documentElement, 0);

  return {
    title: btmcpScrubText(document.title || "").slice(0, 200),
    headings: headings,
    excerpt: excerpt,
    snapshot: snapshot,
  };
}

function btmcpGesture(reason, detail) {
  return { outcome: "needs a real gesture", reason: reason, detail: detail, trusted: false };
}

function btmcpWorked(detail) {
  return { outcome: "worked", reason: null, detail: detail, trusted: false };
}

function btmcpLabel(element) {
  var aria = (element.getAttribute && element.getAttribute("aria-label")) || "";
  var text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  return (aria + " " + text).trim();
}

function btmcpSoftAct(command) {
  var op = command && command.op;
  var selector = command && command.selector;
  if (typeof selector !== "string" || !selector) {
    return btmcpGesture("UI that needs the page drawn", "A selector is required.");
  }
  var element;
  try {
    element = document.querySelector(selector);
  } catch (error) {
    return btmcpGesture("UI that needs the page drawn", "The selector is not valid.");
  }
  if (!element) {
    return btmcpGesture("UI that needs the page drawn", "No element matches that selector.");
  }

  var host = (location.hostname || "").toLowerCase();
  if (host === "docs.google.com" || host === "sheets.google.com" || host === "slides.google.com") {
    return btmcpGesture("Google Docs or canvas app", "Google Docs does not accept untrusted input.");
  }
  if (element.tagName === "CANVAS" || (element.closest && element.closest("canvas"))) {
    return btmcpGesture("Google Docs or canvas app", "Canvas content needs the page drawn and a real gesture.");
  }

  var type = ((element.getAttribute && element.getAttribute("type")) || element.type || "").toLowerCase();
  if (type === "file" || (element.closest && element.closest("input[type='file']"))) {
    return btmcpGesture("file picker", "A file picker needs a real gesture.");
  }

  var label = btmcpLabel(element);
  if (/\b(copy|paste|cut)\b/i.test(label) || /clipboard/i.test(String((element.getAttribute && element.getAttribute("onclick")) || ""))) {
    return btmcpGesture("clipboard", "Clipboard access needs a real gesture.");
  }
  if (/\bfull\s*screen\b/i.test(label) || /requestFullscreen/.test(String((element.getAttribute && element.getAttribute("onclick")) || ""))) {
    return btmcpGesture("fullscreen", "Fullscreen needs a real gesture.");
  }
  if (element.tagName === "A" && String(element.getAttribute("target") || "").toLowerCase() === "_blank") {
    return btmcpGesture("popup", "Opening another tab or window needs a real gesture.");
  }

  var bot = element.closest
    ? element.closest(".g-recaptcha, .cf-turnstile, #px-captcha, iframe")
    : null;
  if (bot) {
    var src = (bot.getAttribute && bot.getAttribute("src")) || "";
    var botClass = String(bot.className || "");
    if (
      bot.id === "px-captcha" ||
      botClass.indexOf("g-recaptcha") !== -1 ||
      botClass.indexOf("cf-turnstile") !== -1 ||
      /recaptcha|hcaptcha|challenges\.cloudflare|turnstile/i.test(src)
    ) {
      return btmcpGesture("anti-bot check", "An anti-bot check covers this control.");
    }
  }

  var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return btmcpGesture("UI that needs the page drawn", "The element has no box.");
  }
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var top = document.elementFromPoint ? document.elementFromPoint(x, y) : element;
  if (!top || (top !== element && !element.contains(top) && !(top.contains && top.contains(element)))) {
    return btmcpGesture("UI that needs the page drawn", "Another element covers the target.");
  }

  if (op === "type") return btmcpTypeInto(element, command.text == null ? "" : String(command.text), command.submit === true);
  if (op === "click") return btmcpClick(element);
  return btmcpGesture("UI that needs the page drawn", "Unknown soft action.");
}

function btmcpFire(element, type, x, y) {
  var pointer = type.indexOf("pointer") === 0;
  var Ctor = pointer && typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  element.dispatchEvent(
    new Ctor(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      view: window,
    })
  );
}

function btmcpClick(element) {
  var rect = element.getBoundingClientRect();
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var form = element.closest ? element.closest("form") : null;
  var inputType = ((element.getAttribute && element.getAttribute("type")) || element.type || "").toLowerCase();
  var isSubmit =
    Boolean(form) &&
    (inputType === "submit" ||
      (element.tagName === "BUTTON" && inputType !== "button" && inputType !== "reset"));

  if (element.tagName === "A" && element.href) {
    return btmcpGesture("the site checks isTrusted", "An untrusted click does not follow a link.");
  }
  if (inputType === "checkbox" || inputType === "radio") {
    return btmcpGesture("the site checks isTrusted", "An untrusted click does not toggle this control.");
  }

  var saw = false;
  function mark() {
    saw = true;
  }
  element.addEventListener("click", mark);
  btmcpFire(element, "pointerdown", x, y);
  btmcpFire(element, "mousedown", x, y);
  btmcpFire(element, "pointerup", x, y);
  btmcpFire(element, "mouseup", x, y);
  btmcpFire(element, "click", x, y);
  element.removeEventListener("click", mark);

  if (isSubmit) {
    var submitted = false;
    function onSubmit() {
      submitted = true;
    }
    form.addEventListener("submit", onSubmit);
    try {
      form.requestSubmit(element);
    } catch (error) {
      form.removeEventListener("submit", onSubmit);
      return btmcpGesture("the site checks isTrusted", "requestSubmit did not run.");
    }
    form.removeEventListener("submit", onSubmit);
    if (submitted) return btmcpWorked("Form submitted with requestSubmit.");
    return btmcpGesture("the site checks isTrusted", "requestSubmit did not fire submit.");
  }

  if (saw) return btmcpWorked("Untrusted click was delivered to the element.");
  return btmcpGesture("the site checks isTrusted", "The element did not receive the click.");
}

function btmcpSetNativeValue(element, text) {
  var proto = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor && descriptor.set) descriptor.set.call(element, text);
  else element.value = text;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function btmcpFindEditor(element) {
  if (element.isContentEditable) return element;
  if (element.closest) {
    return element.closest("[contenteditable='true'], .ProseMirror, .lexical-editor, [data-lexical-editor]");
  }
  return null;
}

function btmcpMaybeSubmit(element, submit) {
  if (!submit) return null;
  var form = element.closest ? element.closest("form") : null;
  if (!form || typeof form.requestSubmit !== "function") {
    return btmcpGesture("the site checks isTrusted", "The text was entered but there is no form to submit.");
  }
  var submitted = false;
  function onSubmit() {
    submitted = true;
  }
  form.addEventListener("submit", onSubmit);
  try {
    form.requestSubmit();
  } catch (error) {
    form.removeEventListener("submit", onSubmit);
    return btmcpGesture("the site checks isTrusted", "The text was entered but requestSubmit did not run.");
  }
  form.removeEventListener("submit", onSubmit);
  if (!submitted) {
    return btmcpGesture("the site checks isTrusted", "The text was entered but the form did not submit.");
  }
  return null;
}

function btmcpTypeInto(element, text, submit) {
  var inputType = ((element.getAttribute && element.getAttribute("type")) || element.type || "").toLowerCase();
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
    if (inputType === "password") {
      return btmcpGesture("the site checks isTrusted", "Password fields are not filled by soft input.");
    }
    if (element.disabled || element.readOnly) {
      return btmcpGesture("the site checks isTrusted", "The field is disabled or read-only.");
    }
    btmcpSetNativeValue(element, text);
    if (element.value !== text) {
      return btmcpGesture("the site checks isTrusted", "The value did not stick.");
    }
    var submitResult = btmcpMaybeSubmit(element, submit);
    if (submitResult) return submitResult;
    return btmcpWorked(submit ? "Value set and the form submitted." : "Value set with the native setter.");
  }

  var editor = btmcpFindEditor(element);
  if (!editor) {
    return btmcpGesture("UI that needs the page drawn", "This element does not accept text.");
  }
  if (typeof editor.focus === "function") editor.focus();
  var inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  var after = editor.textContent || "";
  if (!inserted || after.indexOf(text) === -1) {
    return btmcpGesture("the site checks isTrusted", "execCommand did not insert the text.");
  }
  var editorSubmit = btmcpMaybeSubmit(editor, submit);
  if (editorSubmit) return editorSubmit;
  return btmcpWorked(submit ? "Text inserted and the form submitted." : "Inserted text with execCommand.");
}

var BTMCP_DELTA_WAIT_MS = 300;
var BTMCP_MAP_LIMIT = 80;
var BTMCP_REF_ATTR = "data-btmcp-ref";
var BTMCP_REF_SEQ = "data-btmcp-ref-seq";
var BTMCP_WATCH_KEY = "__btmcpChangeWatch";

function btmcpValidRef(ref) {
  return typeof ref === "string" && /^e[1-9][0-9]{0,4}$/.test(ref);
}

function btmcpPageUrl() {
  try {
    if (typeof location !== "undefined" && location && typeof location.href === "string") return location.href;
  } catch (error) {
    /* a detached frame can throw on location */
  }
  return "";
}

function btmcpDeltaWaitMs() {
  var value = typeof BTMCP_DELTA_WAIT_MS === "number" ? BTMCP_DELTA_WAIT_MS : 300;
  if (!isFinite(value) || value < 0) return 300;
  if (value > 1000) return 1000;
  return value;
}

function btmcpTag(element) {
  return String(element && element.tagName ? element.tagName : "").toUpperCase();
}

function btmcpFlatText(node) {
  if (!node) return "";
  var raw = "";
  if (typeof node.innerText === "string" && node.innerText) raw = node.innerText;
  else if (typeof node.textContent === "string") raw = node.textContent;
  return btmcpScrubText(raw.replace(/\s+/g, " ").trim());
}

function btmcpInputType(element) {
  return ((element.getAttribute && element.getAttribute("type")) || element.type || "").toLowerCase();
}

function btmcpAccessibleName(element) {
  var tag = btmcpTag(element);
  var type = btmcpInputType(element);
  var labelledby = element.getAttribute && element.getAttribute("aria-labelledby");
  if (labelledby && document.getElementById) {
    var ids = String(labelledby).split(/\s+/);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
      if (!ids[i]) continue;
      var target = document.getElementById(ids[i]);
      var piece = btmcpFlatText(target);
      if (piece) parts.push(piece);
    }
    if (parts.length) return parts.join(" ").slice(0, 120);
  }
  var aria = element.getAttribute && element.getAttribute("aria-label");
  if (aria && String(aria).trim()) return btmcpScrubText(String(aria).replace(/\s+/g, " ").trim()).slice(0, 120);
  if (element.labels && element.labels.length) {
    var fromLabels = btmcpFlatText(element.labels[0]);
    if (fromLabels) return fromLabels.slice(0, 120);
  }
  if (element.id && document.getElementsByTagName) {
    var labels = document.getElementsByTagName("label");
    for (var l = 0; l < labels.length; l++) {
      var label = labels[l];
      var htmlFor = label.htmlFor || (label.getAttribute && label.getAttribute("for"));
      if (htmlFor && htmlFor === element.id) {
        var named = btmcpFlatText(label);
        if (named) return named.slice(0, 120);
      }
    }
  }
  if (element.closest) {
    var wrap = element.closest("label");
    if (wrap && wrap !== element) {
      var wrapped = btmcpFlatText(wrap);
      if (wrapped) return wrapped.slice(0, 120);
    }
  }
  if (tag === "IMG") {
    var alt = element.getAttribute && element.getAttribute("alt");
    if (alt && String(alt).trim()) return btmcpScrubText(String(alt).trim()).slice(0, 120);
  }
  if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
    var text = btmcpFlatText(element);
    if (text) return text.slice(0, 120);
  }
  var title = element.getAttribute && element.getAttribute("title");
  if (title && String(title).trim()) return btmcpScrubText(String(title).trim()).slice(0, 120);
  if (type === "password") return "password";
  if (tag === "INPUT" || tag === "TEXTAREA") {
    var placeholder = element.getAttribute && element.getAttribute("placeholder");
    if (placeholder && String(placeholder).trim()) return btmcpScrubText(String(placeholder).trim()).slice(0, 120);
  }
  return "";
}

function btmcpElementText(element) {
  var tag = btmcpTag(element);
  var type = btmcpInputType(element);
  if (type === "password" || type === "file" || type === "hidden") return "";
  if (tag === "INPUT" || tag === "TEXTAREA") {
    var value = element.value == null ? "" : String(element.value);
    return btmcpScrubText(value.replace(/\s+/g, " ").trim()).slice(0, 160);
  }
  if (tag === "SELECT" && element.options && element.selectedIndex >= 0) {
    return btmcpFlatText(element.options[element.selectedIndex]).slice(0, 160);
  }
  return btmcpFlatText(element).slice(0, 160);
}

function btmcpAttrFlag(element, name) {
  var value = element.getAttribute && element.getAttribute(name);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "mixed") return "mixed";
  return null;
}

function btmcpElementState(element, role) {
  var state = {};
  if (element.disabled === true || btmcpAttrFlag(element, "aria-disabled") === true) state.disabled = true;
  var checkable =
    role === "checkbox" ||
    role === "radio" ||
    role === "switch" ||
    role === "menuitemcheckbox" ||
    role === "menuitemradio" ||
    (element.getAttribute && element.getAttribute("aria-checked") != null);
  if (checkable) {
    var checked = btmcpAttrFlag(element, "aria-checked");
    if (checked === null && typeof element.checked === "boolean") checked = element.checked;
    if (checked !== null) state.checked = checked;
  }
  var expanded = btmcpAttrFlag(element, "aria-expanded");
  if (expanded === true || expanded === false) state.expanded = expanded;
  var pressed = btmcpAttrFlag(element, "aria-pressed");
  if (pressed !== null) state.pressed = pressed;
  var selected = btmcpAttrFlag(element, "aria-selected");
  if (selected === null && role === "option" && element.selected === true) selected = true;
  if (selected === true || selected === false) state.selected = selected;
  if (element.required === true || btmcpAttrFlag(element, "aria-required") === true) state.required = true;
  if (btmcpAttrFlag(element, "aria-invalid") === true) state.invalid = true;
  if (element.readOnly === true || btmcpAttrFlag(element, "aria-readonly") === true) state.readonly = true;
  return state;
}

function btmcpImplicitRole(element) {
  var explicit = element.getAttribute && element.getAttribute("role");
  if (explicit && String(explicit).trim()) return String(explicit).trim().toLowerCase().split(/\s+/)[0];
  var tag = btmcpTag(element);
  if (tag === "A") return element.hasAttribute && element.hasAttribute("href") ? "link" : "";
  if (tag === "BUTTON") return "button";
  if (tag === "SUMMARY") return "button";
  if (tag === "SELECT") return element.multiple ? "listbox" : "combobox";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "OPTION") return "option";
  if (tag === "INPUT") {
    var type = btmcpInputType(element) || "text";
    if (type === "hidden") return "";
    if (type === "button" || type === "submit" || type === "reset" || type === "image" || type === "file") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  if (tag === "IMG") return "img";
  if (tag === "NAV") return "navigation";
  if (tag === "MAIN") return "main";
  if (tag === "FORM") return "form";
  if (tag === "HEADER") return "banner";
  if (tag === "FOOTER") return "contentinfo";
  if (tag === "ASIDE") return "complementary";
  if (tag === "DIALOG") return "dialog";
  if (tag === "UL" || tag === "OL") return "list";
  if (tag === "LI") return "listitem";
  if (tag === "TABLE") return "table";
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (element.isContentEditable) return "textbox";
  return "";
}

function btmcpSkipSubtree(element) {
  var tag = btmcpTag(element);
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD") return true;
  if (element.hidden === true) return true;
  if (element.hasAttribute && element.hasAttribute("hidden")) return true;
  if (element.getAttribute && element.getAttribute("aria-hidden") === "true") return true;
  var style = null;
  try {
    style = window.getComputedStyle ? window.getComputedStyle(element) : null;
  } catch (error) {
    style = null;
  }
  if (style && style.display === "none") return true;
  return false;
}

function btmcpElementVisible(element) {
  var style = null;
  try {
    style = window.getComputedStyle ? window.getComputedStyle(element) : null;
  } catch (error) {
    style = null;
  }
  if (style && (style.visibility === "hidden" || style.visibility === "collapse" || String(style.opacity) === "0")) {
    return false;
  }
  var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return true;
}

function btmcpRefOwner(ref) {
  if (!document.querySelector || !btmcpValidRef(ref)) return null;
  try {
    return document.querySelector("[" + BTMCP_REF_ATTR + '="' + ref + '"]');
  } catch (error) {
    return null;
  }
}

function btmcpAssignRef(element) {
  var existing = element.getAttribute && element.getAttribute(BTMCP_REF_ATTR);
  if (btmcpValidRef(existing) && btmcpRefOwner(existing) === element) return existing;
  var root = document.documentElement || document.body;
  var seq = 0;
  if (root && root.getAttribute) {
    seq = Number(root.getAttribute(BTMCP_REF_SEQ) || "0");
    if (!isFinite(seq) || seq < 0) seq = 0;
  }
  var ref = "";
  var guard = 0;
  do {
    seq += 1;
    if (seq > 99999) seq = 1;
    ref = "e" + seq;
    guard += 1;
  } while (btmcpRefOwner(ref) && guard < 5);
  if (root && root.setAttribute) root.setAttribute(BTMCP_REF_SEQ, String(seq));
  if (element.setAttribute) element.setAttribute(BTMCP_REF_ATTR, ref);
  return ref;
}

function btmcpSemanticSnapshot() {
  var nodes = [];
  var truncated = false;
  function consider(element, depth) {
    if (!element || !element.tagName || truncated) return;
    if (btmcpSkipSubtree(element)) return;
    var role = btmcpImplicitRole(element);
    if (role && role !== "presentation" && role !== "none") {
      if (nodes.length >= BTMCP_MAP_LIMIT) {
        truncated = true;
        return;
      }
      nodes.push({
        ref: btmcpAssignRef(element),
        role: role,
        name: btmcpAccessibleName(element),
        text: btmcpElementText(element),
        state: btmcpElementState(element, role),
        visible: btmcpElementVisible(element),
        depth: depth,
      });
    }
    var children = element.children || [];
    for (var i = 0; i < children.length; i++) consider(children[i], depth + 1);
  }
  var root = document.body || document.documentElement;
  if (root) consider(root, 0);
  return {
    title: btmcpScrubText(document.title || "").slice(0, 200),
    nodes: nodes,
    truncated: truncated,
  };
}

function btmcpPushCapped(list, item, cap) {
  if (list.length >= cap) return;
  list.push(item);
}

function btmcpNoteUrl(url) {
  var raw = String(url || "");
  try {
    if (raw && typeof location !== "undefined" && location && location.href) raw = new URL(raw, location.href).href;
  } catch (error) {
    /* keep the raw string */
  }
  return btmcpScrubText(raw).slice(0, 300);
}

function btmcpEnsureWatch() {
  var existing = window[BTMCP_WATCH_KEY];
  if (existing && existing.installed) return existing;
  var state = { installed: true, consoleErrors: [], failedRequests: [] };

  function noteError(text) {
    var scrubbed = btmcpScrubText(String(text == null ? "" : text)).replace(/\s+/g, " ").trim().slice(0, 240);
    if (!scrubbed) return;
    btmcpPushCapped(state.consoleErrors, scrubbed, 40);
  }

  function noteFailure(url, status) {
    var code = typeof status === "number" && isFinite(status) ? status : null;
    btmcpPushCapped(state.failedRequests, { url: btmcpNoteUrl(url), status: code }, 40);
  }

  if (window.console && typeof window.console.error === "function") {
    var originalError = window.console.error;
    window.console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var value = arguments[i];
          if (value instanceof Error) parts.push(value.message);
          else parts.push(String(value));
        }
        noteError(parts.join(" "));
      } catch (error) {
        /* keep the page console working */
      }
      return originalError.apply(window.console, arguments);
    };
  }

  if (window.addEventListener) {
    window.addEventListener("error", function (event) {
      var message = event && (event.message || (event.error && event.error.message));
      noteError(message || "error");
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason;
      noteError(reason instanceof Error ? reason.message : reason == null ? "unhandled rejection" : String(reason));
    });
  }

  if (typeof window.fetch === "function") {
    var originalFetch = window.fetch;
    window.fetch = function (input) {
      var requestUrl = "";
      try {
        if (typeof input === "string") requestUrl = input;
        else if (input && typeof input.url === "string") requestUrl = input.url;
      } catch (error) {
        requestUrl = "";
      }
      return originalFetch.apply(this, arguments).then(
        function (response) {
          try {
            if (response && typeof response.status === "number" && response.status >= 400) {
              noteFailure((response && response.url) || requestUrl, response.status);
            }
          } catch (error) {
            /* ignore observer failures */
          }
          return response;
        },
        function (error) {
          noteFailure(requestUrl, null);
          throw error;
        }
      );
    };
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var proto = window.XMLHttpRequest.prototype;
    var originalOpen = proto.open;
    var originalSend = proto.send;
    if (typeof originalOpen === "function" && typeof originalSend === "function") {
      proto.open = function (method, url) {
        try {
          this.__btmcpUrl = url;
        } catch (error) {
          /* the request still proceeds */
        }
        return originalOpen.apply(this, arguments);
      };
      proto.send = function () {
        var xhr = this;
        if (xhr.addEventListener) {
          xhr.addEventListener("loadend", function () {
            var status = xhr.status;
            if (status === 0 || status >= 400) noteFailure(xhr.__btmcpUrl || xhr.responseURL || "", status === 0 ? null : status);
          });
        }
        return originalSend.apply(this, arguments);
      };
    }
  }

  try {
    Object.defineProperty(window, BTMCP_WATCH_KEY, { value: state, configurable: true });
  } catch (error) {
    window[BTMCP_WATCH_KEY] = state;
  }
  return state;
}

function btmcpWatchCursor() {
  var watch = btmcpEnsureWatch();
  return {
    url: btmcpPageUrl(),
    consoleAt: watch.consoleErrors.length,
    networkAt: watch.failedRequests.length,
  };
}

function btmcpWatchDelta(cursor) {
  var watch = btmcpEnsureWatch();
  var url = btmcpPageUrl();
  var previous = cursor && typeof cursor.url === "string" ? cursor.url : "";
  return {
    urlChanged: url !== previous,
    previousUrl: previous,
    url: url,
    consoleErrors: watch.consoleErrors.slice(cursor && cursor.consoleAt ? cursor.consoleAt : 0).slice(0, 8),
    failedRequests: watch.failedRequests.slice(cursor && cursor.networkAt ? cursor.networkAt : 0).slice(0, 8),
  };
}

function btmcpActOnRef(command) {
  var ref = command && command.ref;
  var cursor = btmcpWatchCursor();
  function finish(result) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        result.delta = btmcpWatchDelta(cursor);
        resolve(result);
      }, btmcpDeltaWaitMs());
    });
  }
  if (!btmcpValidRef(ref)) {
    return finish(btmcpGesture("UI that needs the page drawn", "The ref is not from snapshotTab."));
  }
  var result = btmcpSoftAct({
    op: command && command.op,
    selector: "[" + BTMCP_REF_ATTR + '="' + ref + '"]',
    text: command && command.text,
    submit: command && command.submit === true,
  });
  return finish(result);
}
