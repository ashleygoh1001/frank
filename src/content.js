// content.js
// Injects a countdown badge on PR pages.
// Also triggers a background review check so firstReviewAt stays current.

(function () {
  "use strict";

  // Keep in sync with background.js
  const VAGUE = /^(lgtm|looks good|ok|okay|good|nice|👍|✓|✔|ship it|shipit|\+1|great|approved?)\.?\s*$/i;

  let currentPath = location.pathname;

  init();

  async function init() {
    installVagueCommentGuard();
    installNetworkPostGuard();
    runPage();
    watchNavigation();
  }

  function watchNavigation() {
    const push = history.pushState.bind(history);
    history.pushState = (...a) => { push(...a); onNav(); };
    window.addEventListener("popstate", onNav);
    new MutationObserver(debounce(() => {
      if (location.pathname !== currentPath) onNav();
    }, 300)).observe(document.body, { childList: true, subtree: true });
  }

  function onNav() {
    currentPath = location.pathname;
    document.querySelectorAll(".mf-badge-wrap").forEach(e => e.remove());
    document.querySelectorAll(".mf-vague-warning").forEach(e => e.remove());
    setTimeout(runPage, 900);
  }

  async function runPage() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return;
    const [, owner, repo, numStr] = m;
    const repoKey  = `${owner}/${repo}`;
    const prNumber = parseInt(numStr, 10);

    // Get group data
    const group = await send("GET_GROUP", { repoKey });
    if (!group) return;

    const pr = (group.prs || []).find(p => p.number === prNumber && p.state === "open");
    if (!pr) return;

    injectBadge(pr.reviewDeadline, pr.firstReviewAt);

    // Background: check if a review has been submitted since last sync
    if (!pr.firstReviewAt) {
      send("CHECK_REVIEWS", { repoKey, prNumber });
    }
  }

  function injectBadge(deadlineIso, firstReviewAt) {
    if (document.querySelector(".mf-badge-wrap")) return;

    const wrap  = document.createElement("div");
    wrap.className = "mf-badge-wrap";

    const label = document.createElement("span");
    label.className   = "mf-badge-label";
    label.textContent = "review deadline";

    const timer = document.createElement("span");
    timer.className = "mf-badge-timer";

    wrap.appendChild(label);
    wrap.appendChild(timer);

    const target =
      document.querySelector(".gh-header-meta") ||
      document.querySelector("#partial-discussion-header") ||
      document.querySelector("main");
    if (!target) return;

    target.parentNode?.insertBefore(wrap, target.nextSibling) ?? target.prepend(wrap);
    requestAnimationFrame(() => wrap.classList.add("mf-badge-wrap--visible"));

    if (firstReviewAt) {
      timer.textContent = "✓ reviewed";
      timer.className   = "mf-badge-timer mf-badge--done";
      return;
    }

    let intervalId;
    function tick() {
      const ms = new Date(deadlineIso) - Date.now();
      if (ms <= 0) {
        timer.textContent = "OVERDUE";
        timer.className   = "mf-badge-timer mf-badge--overdue";
        return;
      }
      const h = Math.floor(ms / 36e5);
      const m = Math.floor((ms % 36e5) / 6e4);
      const s = Math.floor((ms % 6e4) / 1e3);
      timer.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
      timer.className   = `mf-badge-timer ${h < 4 ? "mf-badge--urgent" : "mf-badge--ok"}`;
    }
    tick();
    intervalId = setInterval(tick, 1000);

    new MutationObserver(() => {
      if (!document.contains(wrap)) clearInterval(intervalId);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function send(type, extra) {
    return new Promise(res => chrome.runtime.sendMessage({ type, ...extra }, res));
  }

  function installVagueCommentGuard() {
    // Capture submit early so GitHub's handlers can't post first.
    document.addEventListener("submit", (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;

      const textarea = findTextareaForPostAction(form);
      if (!textarea) return;
      if (!blockIfVague(textarea, e)) return;
    }, true);

    // GitHub sometimes posts via button click handlers (not a traditional submit).
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;

      const btn =
        t.closest('button[type="submit"], input[type="submit"], button.js-comment-and-button, button[data-disable-with]');
      if (!(btn instanceof HTMLElement)) return;

      const form = btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement ? (btn.form || btn.closest("form")) : btn.closest("form");
      const textarea = findTextareaForPostAction(form || btn);
      if (!textarea) return;

      blockIfVague(textarea, e);
    }, true);

    // Keyboard shortcut: Ctrl/Cmd + Enter sends in some GitHub editors.
    document.addEventListener("keydown", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLTextAreaElement)) return;
      if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
      blockIfVague(t, e);
    }, true);

    // Some GitHub actions are button-triggered; ensure warning clears as user types.
    document.addEventListener("input", (e) => {
      const t = e.target;
      if (!(t instanceof HTMLTextAreaElement)) return;
      const warn = nearestWarningFor(t);
      if (!warn) return;
      if (!VAGUE.test(t.value.trim())) warn.remove();
    }, true);
  }

  function installNetworkPostGuard() {
    // GitHub often posts comments/reviews via JS (fetch/XHR) without a standard submit.
    // Intercepting at the network layer is the most reliable way to block.

    // --- fetch ---
    const origFetch = window.fetch?.bind(window);
    if (origFetch) {
      window.fetch = async (input, init) => {
        try {
          const details = await describeFetchRequest(input, init);
          if (details && shouldBlockNetworkPost(details)) {
            const textarea = findTextareaForPostAction(document.activeElement instanceof Element ? document.activeElement : document.body);
            if (textarea) blockIfVague(textarea, null);
            throw new Error("Blocked vague approval comment");
          }
        } catch (err) {
          // If our inspection fails, fall back to the original request.
        }
        return origFetch(input, init);
      };
    }

    // --- XHR ---
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const origOpen = OrigXHR.prototype.open;
      const origSend = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url, ...rest) {
        try {
          this.__mf_method = method;
          this.__mf_url = url;
        } catch {}
        return origOpen.call(this, method, url, ...rest);
      };
      OrigXHR.prototype.send = function (body) {
        try {
          const method = String(this.__mf_method || "").toUpperCase();
          const url = String(this.__mf_url || "");
          const bodyText = extractBodyText(body);
          if (shouldBlockNetworkPost({ method, url, bodyText })) {
            const textarea = findTextareaForPostAction(document.activeElement instanceof Element ? document.activeElement : document.body);
            if (textarea) blockIfVague(textarea, null);
            // Abort by not sending; mimic a network error
            try { this.abort(); } catch {}
            return;
          }
        } catch {}
        return origSend.call(this, body);
      };
    }
  }

  async function describeFetchRequest(input, init) {
    // Returns { method, url, bodyText } or null
    let url = "";
    let method = "GET";
    let body = undefined;

    if (input instanceof Request) {
      url = input.url || "";
      method = (init?.method || input.method || "GET").toUpperCase();
      // Prefer init.body if present; otherwise clone request to read body.
      body = init?.body;
      if (body == null && method !== "GET" && method !== "HEAD") {
        try {
          const clone = input.clone();
          // Might fail for streams; ignore.
          body = await clone.text();
        } catch {}
      }
    } else {
      url = String(input || "");
      method = (init?.method || "GET").toUpperCase();
      body = init?.body;
    }

    const bodyText = extractBodyText(body);
    return { method, url, bodyText };
  }

  function shouldBlockNetworkPost({ method, url, bodyText }) {
    if (!method || method === "GET" || method === "HEAD") return false;
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") return false;
    if (!url) return false;

    // Only guard GitHub write endpoints for comments/reviews.
    const u = String(url);
    const looksLikeWrite =
      /\/comments(\?|$)/.test(u) ||
      /\/reviews(\?|$)/.test(u) ||
      /\/pull_request_reviews(\?|$)/.test(u) ||
      /\/issue_comments(\?|$)/.test(u) ||
      /\/preview\/comments(\?|$)/.test(u);
    if (!looksLikeWrite) return false;

    const text = extractBodyFieldFromPayload(bodyText);
    if (!text) return false;
    return VAGUE.test(text.trim());
  }

  function extractBodyText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      // Best-effort: serialize known fields
      const candidates = [];
      for (const [k, v] of body.entries()) {
        if (typeof v === "string") candidates.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
      return candidates.join("&");
    }
    if (body instanceof Blob) return "";
    if (body instanceof ArrayBuffer) return "";
    if (ArrayBuffer.isView(body)) return "";
    // Could be object passed to fetch in some libs; stringify safely
    try { return JSON.stringify(body); } catch { return ""; }
  }

  function extractBodyFieldFromPayload(payload) {
    if (!payload) return "";

    // JSON: {"body":"..."} or nested structures
    const trimmed = payload.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const obj = JSON.parse(trimmed);
        const val = deepFindFirstString(obj, ["body", "comment", "text"]);
        if (val) return val;
      } catch {}
    }

    // Form-encoded: comment[body]=... or body=...
    try {
      const params = new URLSearchParams(payload);
      return (
        params.get("comment[body]") ||
        params.get("pull_request_review[body]") ||
        params.get("body") ||
        ""
      );
    } catch {}

    return "";
  }

  function deepFindFirstString(obj, keys) {
    if (obj == null) return "";
    if (typeof obj === "string") return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = deepFindFirstString(item, keys);
        if (found) return found;
      }
      return "";
    }
    if (typeof obj === "object") {
      for (const k of keys) {
        const v = obj[k];
        const found = deepFindFirstString(v, keys);
        if (found) return found;
      }
      // fall back: scan other fields shallowly
      for (const v of Object.values(obj)) {
        const found = deepFindFirstString(v, keys);
        if (found) return found;
      }
    }
    return "";
  }

  function blockIfVague(textarea, event) {
    const text = textarea.value.trim();
    if (!text) return false;
    if (!VAGUE.test(text)) return false;

    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    event?.stopPropagation?.();

    showVagueWarning(textarea, "That looks like a vague approval (“LGTM”, “looks good”, “+1”, etc.). Please add a specific comment.");
    textarea.focus();
    // Put cursor at end for quick editing
    try { textarea.setSelectionRange(textarea.value.length, textarea.value.length); } catch {}
    return true;
  }

  function findTextareaForPostAction(root) {
    // Prefer the currently-focused textarea if it's visible and editable.
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && !active.disabled && active.offsetParent !== null) return active;

    if (root instanceof HTMLFormElement) {
      const inForm = findLikelyCommentTextarea(root);
      if (inForm) return inForm;
    } else if (root instanceof Element) {
      const form = root.closest("form");
      if (form) {
        const inForm = findLikelyCommentTextarea(form);
        if (inForm) return inForm;
      }
      // Review dialog / inline composer fallbacks
      const dialog = root.closest('dialog, [role="dialog"], .js-comment-form, .js-previewable-comment-form, .timeline-comment');
      if (dialog) {
        const inDialog = dialog.querySelector("textarea");
        if (inDialog instanceof HTMLTextAreaElement && !inDialog.disabled && inDialog.offsetParent !== null) return inDialog;
      }
    }
    return null;
  }

  function findLikelyCommentTextarea(form) {
    // Most GitHub comment/review bodies are in a textarea with one of these names/ids.
    const selectors = [
      'textarea[name="comment[body]"]',
      'textarea[name="issue[body]"]',
      'textarea[name="pull_request[body]"]',
      'textarea[name="pull_request_review[body]"]',
      'textarea#new_comment_field',
      'textarea.js-comment-field',
      'textarea[name="discussion_comment[body]"]',
      'textarea[aria-label*="comment" i]',
      'textarea[aria-label*="review" i]',
    ];
    for (const sel of selectors) {
      const el = form.querySelector(sel);
      if (el instanceof HTMLTextAreaElement) return el;
    }
    // Fallback: first textarea in the form (but ignore hidden/disabled)
    const any = form.querySelector("textarea");
    if (any instanceof HTMLTextAreaElement && !any.disabled && any.offsetParent !== null) return any;
    return null;
  }

  function nearestWarningFor(textarea) {
    const root = textarea.closest(".js-previewable-comment-form") || textarea.closest("form") || textarea.parentElement;
    return root?.querySelector?.(".mf-vague-warning") || null;
  }

  function showVagueWarning(textarea, message) {
    const existing = nearestWarningFor(textarea);
    if (existing) existing.remove();

    const warning = document.createElement("div");
    warning.className = "mf-vague-warning";
    warning.setAttribute("role", "alert");
    warning.textContent = message;

    // Prefer showing above the textarea if possible.
    const container =
      textarea.closest(".comment-form-textarea") ||
      textarea.closest(".js-previewable-comment-form") ||
      textarea.parentElement;

    if (container) container.prepend(warning);
    else textarea.insertAdjacentElement("beforebegin", warning);
  }
})();
