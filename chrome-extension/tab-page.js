/**
 * Runs inside a tab via chrome.scripting.executeScript.
 *
 * btmcpReadPage stays in the isolated world. btmcpSoftAct runs in the page's
 * main world so the native value setter and execCommand reach React, Vue, and
 * rich editors. Neither function calls the debugger API or changes window focus.
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
