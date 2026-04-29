// popup.js
(function () {
  let settings  = {};
  let repoKey   = "";
  let owner     = "";
  let repo      = "";
  let group     = null;   // full gist data object
  let isPrivate = false;
  const cdTimers = {};
  // Keep in sync with background.js
  const VAGUE = /^(lgtm|looks good|looks great|ok|okay|good|nice|👍|✓|✔|ship it|shipit|\+1|great|approved?)\.?\s*$/i;

  // ── Boot ───────────────────────────────────────────────────────────────────
  (async function boot() {
    // Read settings directly from storage — avoids service worker wake-up race
    settings = await new Promise(res =>
      chrome.storage.sync.get(["githubToken","githubLogin","stallHours"], d =>
        res({ githubToken: d.githubToken||"", githubLogin: d.githubLogin||"", stallHours: d.stallHours||24 })
      )
    );

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = tab?.url?.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (m) { owner = m[1]; repo = m[2]; repoKey = `${owner}/${repo}`; }

    Q("#repoPill").textContent      = repoKey || "not on a GitHub repo";
    Q("#setupRepoName").textContent = repoKey;
    Q("#loginVal").textContent      = settings.githubLogin || "—";
    Q("#sGhToken").value            = settings.githubToken || "";
    const stall = settings.stallHours || 24;
    Q("#sStall").value            = stall;
    Q("#sStallVal").textContent   = `${stall}h`;

    setupTabs();
    setupSettings();
    setupGroup();
    setupPRs();
    setupFeedback();

    loadGroup();
  })();

  // ── Tabs ───────────────────────────────────────────────────────────────────
  function setupTabs() {
    QA(".tab").forEach(t => t.addEventListener("click", () => {
      QA(".tab").forEach(x => x.classList.remove("active"));
      QA(".panel").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      Q(`#tab-${t.dataset.tab}`).classList.add("active");
      if (t.dataset.tab === "prs")      renderPRs();
      if (t.dataset.tab === "feedback") loadFeedback();
    }));
  }

  // ── Group tab ──────────────────────────────────────────────────────────────
  function setupGroup() {
    Q("#goSettBtn").addEventListener("click", () => {
      Q('[data-tab="settings"]').click();
    });

    Q("#createBtn").addEventListener("click", async () => {
      if (!repoKey) return;
      setLoading(Q("#createBtn"), true);
      const result = await send("CREATE_GROUP", { repoKey });
      setLoading(Q("#createBtn"), false);
      if (result?.error) { alert(result.error); return; }
      group = result.data;
      showGroupMain();
    });

    Q("#joinBtn").addEventListener("click", joinGroup);
    Q("#joinInput").addEventListener("keydown", e => { if (e.key === "Enter") joinGroup(); });

    async function joinGroup() {
      const code = Q("#joinInput").value.trim();
      if (!code) return;
      Q("#joinErr").textContent = "";
      setLoading(Q("#joinBtn"), true, "Joining…");
      const result = await send("JOIN_GROUP", { gistId: code });
      setLoading(Q("#joinBtn"), false, "Join");
      if (result?.error) { Q("#joinErr").textContent = result.error; return; }
      // Navigate popup context to the joined repo
      repoKey = result.repoKey;
      [owner, repo] = repoKey.split("/");
      Q("#repoPill").textContent      = repoKey;
      Q("#setupRepoName").textContent = repoKey;
      group = await send("GET_GROUP", { repoKey });
      showGroupMain();
    }

    Q("#addBtn").addEventListener("click", addMember);
    Q("#addInput").addEventListener("keydown", e => { if (e.key === "Enter") addMember(); });

    async function addMember() {
      const login = Q("#addInput").value.trim().replace(/^@/, "");
      if (!login || !repoKey) return;
      Q("#addErr").textContent = "";
      setLoading(Q("#addBtn"), true, "…");
      const result = await send("ADD_MEMBER", { repoKey, login });
      setLoading(Q("#addBtn"), false, "Add");
      if (result?.error) { Q("#addErr").textContent = result.error; return; }
      Q("#addInput").value = "";
      group = result;
      renderMembers();
    }
  }

  async function loadGroup() {
    showOnly("g-loading");
    if (!settings.githubToken) { showOnly("g-notoken"); return; }
    if (!repoKey) { showOnly("g-setup"); return; }
    group = await send("GET_GROUP", { repoKey });
    if (group) showGroupMain();
    else showOnly("g-setup");
  }

  function showGroupMain() {
    showOnly("g-main");
    Q("#g-main").style.display = "flex";

    // Join code box
    send("GET_JOIN_CODE", { repoKey }).then(code => {
      if (!code) return;
      Q("#joinCodeBox").textContent = code;
      Q("#joinCodeHint").textContent = "click to copy";
      Q("#joinCodeBox").onclick = () => {
        navigator.clipboard.writeText(code);
        Q("#joinCodeHint").textContent = "✓ copied!";
        setTimeout(() => Q("#joinCodeHint").textContent = "click to copy", 2000);
      };
    });

    renderMembers();
  }

  function renderMembers() {
    const members = group?.members || [];
    Q("#memberCount").textContent = `${members.length} member${members.length !== 1 ? "s" : ""}`;
    const list = Q("#memberList");
    list.innerHTML = "";
    members.forEach(m => {
      const row = document.createElement("div");
      row.className = "member";
      const isYou = m.login === settings.githubLogin;
      row.innerHTML = `
        <img class="avatar" src="${m.avatarUrl || `https://github.com/${m.login}.png`}" alt=""/>
        <span class="member-login">@${m.login}</span>
        ${isYou ? '<span class="you-tag">you</span>' : ""}
        ${!isYou ? `<button class="btn-x" data-login="${m.login}" title="Remove">×</button>` : ""}
      `;
      if (!isYou) {
        row.querySelector(".btn-x").addEventListener("click", async e => {
          const login = e.currentTarget.dataset.login;
          const result = await send("REMOVE_MEMBER", { repoKey, login });
          if (result && !result.error) { group = result; renderMembers(); }
        });
      }
      list.appendChild(row);
    });
  }

  function showOnly(id) {
    ["g-loading","g-notoken","g-setup","g-main"].forEach(x => {
      const el = Q(`#${x}`);
      el.style.display = x === id ? (x === "g-main" ? "flex" : "flex") : "none";
    });
  }

  // ── PRs tab ────────────────────────────────────────────────────────────────
  function setupPRs() {
    Q("#syncBtn").addEventListener("click", async () => {
      if (!repoKey || !group) return;
      setLoading(Q("#syncBtn"), true, "Syncing…");
      const result = await send("SYNC_PRS", { repoKey });
      if (result?.data) { group = result.data; }
      else { group = await send("GET_GROUP", { repoKey }); }
      renderPRs();
      populateFbPrSelect();
      setLoading(Q("#syncBtn"), false, "↻ Sync PRs");
    });
  }

  function renderPRs() {
    Object.values(cdTimers).forEach(clearInterval);
    const list  = Q("#pr-list");
    const empty = Q("#pr-empty");
    list.innerHTML = "";
    const open = (group?.prs || []).filter(p => p.state === "open");
    if (!open.length) { empty.style.display = "block"; return; }
    empty.style.display = "none";
    open.sort((a, b) => new Date(a.reviewDeadline) - new Date(b.reviewDeadline));
    open.forEach(pr => list.appendChild(buildPRCard(pr)));
  }

  function buildPRCard(pr) {
    const overdue = !pr.firstReviewAt && new Date(pr.reviewDeadline) < new Date();
    const card    = document.createElement("div");
    card.className = `pr-card${overdue ? " overdue" : ""}`;
    const prUrl   = `https://github.com/${repoKey}/pull/${pr.number}`;
    const cdId    = `cd-${pr.number}`;

    card.innerHTML = `
      <div class="row">
        <span class="pr-num">#${pr.number}</span>
        <span class="pr-auth">by ${pr.authorLogin}</span>
      </div>
      <a class="pr-title-link" href="${prUrl}" target="_blank">${esc(pr.title)}</a>
      <div class="pr-foot">
        <span class="${pr.firstReviewAt ? "status-ok" : "status-none"}">
          ${pr.firstReviewAt ? "✓ reviewed" : "◌ awaiting review"}
        </span>
        <div class="row">
          <button class="btn-fb" data-pr="${pr.number}">+ feedback</button>
          <span class="countdown" id="${cdId}"></span>
        </div>
      </div>
    `;

    card.querySelector(".btn-fb").addEventListener("click", () => {
      Q('[data-tab="feedback"]').click();
      Q("#fbPr").value = pr.number;
    });

    startCD(cdId, pr.reviewDeadline, pr.firstReviewAt);
    return card;
  }

  function startCD(id, deadlineIso, firstReviewAt) {
    if (cdTimers[id]) clearInterval(cdTimers[id]);
    function tick() {
      const el = document.getElementById(id);
      if (!el) { clearInterval(cdTimers[id]); return; }
      if (firstReviewAt) { el.textContent = "done"; el.className = "countdown cd-done"; return; }
      const ms = new Date(deadlineIso) - Date.now();
      if (ms <= 0) { el.textContent = "OVERDUE"; el.className = "countdown cd-over"; return; }
      const h = Math.floor(ms / 36e5), m = Math.floor((ms % 36e5) / 6e4), s = Math.floor((ms % 6e4) / 1e3);
      el.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
      el.className   = `countdown ${h < 4 ? "cd-warn" : "cd-ok"}`;
    }
    tick();
    cdTimers[id] = setInterval(tick, 1000);
  }

  // ── Feedback tab ───────────────────────────────────────────────────────────
  function setupFeedback() {
    Q("#privToggle").addEventListener("click", () => {
      isPrivate = !isPrivate;
      Q("#privToggle").classList.toggle("on", isPrivate);
      Q("#privLabel").textContent = isPrivate ? "Private (extension only)" : "Post to GitHub";
    });

    Q("#fbSend").addEventListener("click", async () => {
      const body = Q("#fbBody").value.trim();
      if (!body) return;
      if (!group) { Q("#fbErr").textContent = "No group for this repo."; return; }
      if (VAGUE.test(body)) { Q("#fbErr").textContent = "Please add specific feedback (not just “LGTM”, “looks good”, “+1”, etc.)."; return; }
      Q("#fbErr").textContent = "";
      setLoading(Q("#fbSend"), true, "…");
      const prNum = parseInt(Q("#fbPr").value) || null;
      const result = await send("POST_FEEDBACK", { repoKey, prNumber: prNum, body, isPrivate });
      setLoading(Q("#fbSend"), false, "Send");
      if (result?.error) { Q("#fbErr").textContent = result.error; return; }
      Q("#fbBody").value = "";
      await loadFeedback();
    });
  }

  async function loadFeedback() {
    populateFbPrSelect();
    if (!group) return;
    const fresh = await send("REFRESH", { repoKey });
    if (fresh) group = fresh;
    renderFeedback(group?.feedback || []);
  }

  function populateFbPrSelect() {
    const sel = Q("#fbPr");
    const cur = sel.value;
    sel.innerHTML = `<option value="">General — not tied to a PR</option>`;
    (group?.prs || []).filter(p => p.state === "open").forEach(pr => {
      const opt = document.createElement("option");
      opt.value = pr.number;
      opt.textContent = `#${pr.number} — ${pr.title.slice(0, 38)}`;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  }

  function renderFeedback(items) {
    const feed = Q("#fbFeed");
    feed.innerHTML = "";
    if (!items.length) { feed.innerHTML = `<div class="empty">No feedback yet.</div>`; return; }
    items.forEach(item => {
      const div = document.createElement("div");
      div.className = "fb-item";
      div.innerHTML = `
        <div class="fb-meta">
          <span class="fb-author">@${item.authorLogin}</span>
          ${item.prNumber ? `<span class="fb-pr">PR #${item.prNumber}</span>` : ""}
          ${item.isPrivate ? `<span class="fb-priv">private</span>` : ""}
          ${item.githubPosted ? `<span style="font-size:9px;color:var(--gr)">posted to GitHub</span>` : ""}
          <span class="fb-time">${timeAgo(item.postedAt)}</span>
        </div>
        <div class="fb-body">${esc(item.body)}</div>
      `;
      feed.appendChild(div);
    });
  }

  // ── Settings tab ────────────────────────────────────────────────────────────
  function setupSettings() {
    Q("#sStall").addEventListener("input", () => {
      Q("#sStallVal").textContent = `${Q("#sStall").value}h`;
    });
    Q("#saveBtn").addEventListener("click", async () => {
      setLoading(Q("#saveBtn"), true);
      Q("#saveOk").style.opacity = "0";
      Q("#saveErr").textContent  = "";
      const result = await send("SAVE_SETTINGS", {
        githubToken: Q("#sGhToken").value.trim(),
        stallHours:  parseInt(Q("#sStall").value, 10),
      });
      setLoading(Q("#saveBtn"), false, "Save");
      if (!result || result.error) {
        Q("#saveErr").textContent = result?.error || "Save failed — check your token and try again.";
        return;
      }
      // Update settings locally — avoid a second round-trip that can return undefined
      settings.githubToken = Q("#sGhToken").value.trim();
      settings.stallHours  = parseInt(Q("#sStall").value, 10);
      if (result.githubLogin) settings.githubLogin = result.githubLogin;
      Q("#loginVal").textContent = settings.githubLogin || "—";
      Q("#saveOk").style.opacity = "1";
      setTimeout(() => Q("#saveOk").style.opacity = "0", 2500);
      loadGroup();
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function Q(sel) { return document.querySelector(sel); }
  function QA(sel) { return document.querySelectorAll(sel); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
  function send(type, extra) {
    return new Promise(res => {
      try {
        chrome.runtime.sendMessage({ type, ...extra }, response => {
          if (chrome.runtime.lastError) {
            res({ error: chrome.runtime.lastError.message });
          } else {
            // Preserve primitives/null from background. Only default when response is actually undefined.
            res(response === undefined ? null : response);
          }
        });
      } catch (e) {
        res({ error: e.message });
      }
    });
  }
  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso);
    const h  = Math.floor(ms / 36e5);
    if (h < 1) return `${Math.floor(ms / 6e4)}m ago`;
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  function setLoading(btn, on, offLabel) {
    btn.disabled = on;
    if (offLabel && !on) btn.textContent = offLabel;
    if (on) btn.textContent = "…";
  }
})();
