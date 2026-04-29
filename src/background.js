// background.js
const GH    = "https://api.github.com";
const VAGUE = /^(lgtm|looks good|ok|okay|good|nice|👍|✓|✔|ship it|shipit|\+1|great|approved?)\.?\s*$/i;

function getSettings() {
  return new Promise(res =>
    chrome.storage.sync.get(["githubToken", "githubLogin", "stallHours"], d => res({
      githubToken: d.githubToken || "",
      githubLogin: d.githubLogin || "",
      stallHours:  d.stallHours  || 24,
    }))
  );
}

function getGistMap() {
  return new Promise(res =>
    chrome.storage.local.get("gistMap", d => res(d.gistMap || {}))
  );
}
function setGistMap(map) {
  return new Promise(res => chrome.storage.local.set({ gistMap: map }, res));
}

function resolveGistId(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") return entry.gistId || entry.id || null;
  return null;
}

// ── GitHub fetch — token always explicit ──────────────────────────────────────
async function gh(method, path, body, token) {
  if (!token) throw new Error("No GitHub token set.");
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      Accept:         "application/vnd.github+json",
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${path}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Gist helpers ──────────────────────────────────────────────────────────────
async function readGist(gistId, token) {
  const gist = await gh("GET", `/gists/${gistId}`, null, token);
  const raw  = gist?.files?.["mf-data.json"]?.content;
  if (!raw) throw new Error("mf-data.json not found in gist");
  return JSON.parse(raw);
}

async function writeGist(gistId, data, token) {
  await gh("PATCH", `/gists/${gistId}`, {
    files: { "mf-data.json": { content: JSON.stringify(data, null, 2) } },
  }, token);
}

async function mutateGist(gistId, fn, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data    = await readGist(gistId, token);
      const updated = fn(data);
      await writeGist(gistId, updated, token);
      await chrome.storage.local.set({ [`cache_${gistId}`]: { data: updated, ts: Date.now() } });
      return updated;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function getGroupData(gistId, token, forceRefresh) {
  if (!forceRefresh) {
    const c = await new Promise(res => chrome.storage.local.get(`cache_${gistId}`, d => res(d[`cache_${gistId}`] || null)));
    if (c && Date.now() - c.ts < 2 * 60 * 1000) return c.data;
  }
  const data = await readGist(gistId, token);
  await chrome.storage.local.set({ [`cache_${gistId}`]: { data, ts: Date.now() } });
  return data;
}

function emptyGroup(repoKey, creatorLogin, stallHours) {
  return {
    repoKey,
    name:      repoKey,
    stallHours,
    createdBy: creatorLogin,
    createdAt: new Date().toISOString(),
    members:   [{ login: creatorLogin, avatarUrl: `https://github.com/${creatorLogin}.png`, addedAt: new Date().toISOString() }],
    prs:       [],
    feedback:  [],
  };
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg).then(respond).catch(e => respond({ error: e.message }));
  return true;
});

async function handle(msg) {
  const s = await getSettings();

  switch (msg.type) {

    case "GET_SETTINGS": return s;

    case "SAVE_SETTINGS": {
      // Support both legacy `{ payload: {...} }` and current `{ githubToken, stallHours }` message shapes.
      const incoming = msg.payload ?? msg;
      const token = incoming.githubToken;
      let login = "";
      if (token) {
        try {
          const me = await gh("GET", "/user", null, token);
          login = me.login;
        } catch (e) {
          return { error: `Token error: ${e.message}` };
        }
      }
      const toStore = { ...incoming };
      if (login) toStore.githubLogin = login;
      await new Promise(res => chrome.storage.sync.set(toStore, res));
      return { ok: true, githubLogin: login };
    }

    case "GET_GROUP": {
      const { repoKey } = msg;
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) return null;
      try { return await getGroupData(gistId, s.githubToken, false); }
      catch { return null; }
    }

    case "CREATE_GROUP": {
      const { repoKey } = msg;
      if (!s.githubToken) throw new Error("No GitHub token set.");
      if (!s.githubLogin) throw new Error("GitHub login not found — re-save your token.");
      const data = emptyGroup(repoKey, s.githubLogin, s.stallHours);
      const gist = await gh("POST", "/gists", {
        description: `Meaningful Feedback — ${repoKey}`,
        public:      false,
        files:       { "mf-data.json": { content: JSON.stringify(data, null, 2) } },
      }, s.githubToken);
      const gistId = gist.id;
      const map    = await getGistMap();
      map[repoKey] = gistId;
      await setGistMap(map);
      await chrome.storage.local.set({ [`cache_${gistId}`]: { data, ts: Date.now() } });
      return { gistId, data };
    }

    case "JOIN_GROUP": {
      const { gistId } = msg;
      if (!s.githubToken) throw new Error("No GitHub token set.");
      if (!s.githubLogin) throw new Error("GitHub login not found — re-save your token.");
      const data = await readGist(gistId, s.githubToken);
      const alreadyMember = data.members.some(m => m.login === s.githubLogin);
      if (!alreadyMember) {
        await mutateGist(gistId, d => {
          d.members.push({ login: s.githubLogin, avatarUrl: `https://github.com/${s.githubLogin}.png`, addedAt: new Date().toISOString() });
          return d;
        }, s.githubToken);
      }
      const map = await getGistMap();
      map[data.repoKey] = gistId;
      await setGistMap(map);
      return { ok: true, repoKey: data.repoKey };
    }

    case "ADD_MEMBER": {
      const { repoKey, login } = msg;
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) throw new Error("No group for this repo.");
      let avatarUrl = `https://github.com/${login}.png`;
      try {
        const user = await gh("GET", `/users/${login}`, null, s.githubToken);
        avatarUrl  = user.avatar_url;
      } catch { throw new Error(`GitHub user "${login}" not found.`); }
      const updated = await mutateGist(gistId, d => {
        if (!d.members.some(m => m.login === login))
          d.members.push({ login, avatarUrl, addedAt: new Date().toISOString() });
        return d;
      }, s.githubToken);
      return updated;
    }

    case "REMOVE_MEMBER": {
      const { repoKey, login } = msg;
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) throw new Error("No group for this repo.");
      return await mutateGist(gistId, d => {
        d.members = d.members.filter(m => m.login !== login);
        return d;
      }, s.githubToken);
    }

    case "SYNC_PRS": {
      const { repoKey } = msg;
      const [owner, repo] = repoKey.split("/");
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) throw new Error("No group for this repo.");
      const openPRs = await gh("GET", `/repos/${owner}/${repo}/pulls?state=open&per_page=50`, null, s.githubToken);
      const stallMs = s.stallHours * 36e5;
      const updated = await mutateGist(gistId, d => {
        const openNums = openPRs.map(p => p.number);
        for (const pr of openPRs) {
          const existing = d.prs.find(p => p.number === pr.number);
          const openedAt = new Date(pr.created_at);
          const deadline = new Date(openedAt.getTime() + stallMs);
          if (existing) {
            existing.title = pr.title; existing.state = pr.state;
            existing.draft = pr.draft; existing.syncedAt = new Date().toISOString();
          } else {
            d.prs.push({
              number: pr.number, title: pr.title, authorLogin: pr.user.login,
              state: pr.state, draft: pr.draft,
              openedAt: openedAt.toISOString(),
              reviewDeadline: deadline.toISOString(),
              firstReviewAt: null, syncedAt: new Date().toISOString(),
            });
          }
        }
        for (const p of d.prs) {
          if (p.state === "open" && !openNums.includes(p.number)) p.state = "closed";
        }
        d.stallHours = s.stallHours;
        return d;
      }, s.githubToken);
      return { ok: true, count: openPRs.length, data: updated };
    }

    case "CHECK_REVIEWS": {
      const { repoKey, prNumber } = msg;
      const [owner, repo] = repoKey.split("/");
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) return null;
      const reviews = await gh("GET", `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, null, s.githubToken);
      const firstSub = reviews
        .filter(r => ["APPROVED","CHANGES_REQUESTED","COMMENTED"].includes(r.state) && !VAGUE.test((r.body||"").trim()))
        .sort((a,b) => new Date(a.submitted_at) - new Date(b.submitted_at))[0];
      if (firstSub) {
        await mutateGist(gistId, d => {
          const pr = d.prs.find(p => p.number === prNumber);
          if (pr && !pr.firstReviewAt) pr.firstReviewAt = firstSub.submitted_at;
          return d;
        }, s.githubToken);
      }
      return { hasSubstantive: !!firstSub, firstReviewAt: firstSub?.submitted_at || null };
    }

    case "POST_FEEDBACK": {
      const { repoKey, prNumber, body, isPrivate } = msg;
      const [owner, repo] = repoKey.split("/");
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) throw new Error("No group for this repo.");
      const item = {
        id: crypto.randomUUID(), prNumber: prNumber || null,
        authorLogin: s.githubLogin, body, isPrivate,
        githubPosted: false, postedAt: new Date().toISOString(),
      };
      if (!isPrivate && prNumber && s.githubToken) {
        await gh("POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`,
          { body: `**[Team Feedback]** ${body}\n\n*— ${s.githubLogin}*` }, s.githubToken);
        item.githubPosted = true;
      }
      await mutateGist(gistId, d => {
        d.feedback.unshift(item);
        if (d.feedback.length > 100) d.feedback = d.feedback.slice(0, 100);
        return d;
      }, s.githubToken);
      return { ok: true };
    }

    case "REFRESH": {
      const { repoKey } = msg;
      const map    = await getGistMap();
      const gistId = resolveGistId(map[repoKey]);
      if (!gistId) return null;
      return await getGroupData(gistId, s.githubToken, true);
    }

    case "GET_JOIN_CODE": {
      const { repoKey } = msg;
      const map = await getGistMap();
      return resolveGistId(map[repoKey]);
    }
  }
}

// ── Alarm: background sync + deadline notifications ───────────────────────────
chrome.alarms.create("sync", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener(async () => {
  const s   = await getSettings();
  if (!s.githubToken) return;
  const map = await getGistMap();
  for (const [repoKey, gistId] of Object.entries(map)) {
    try {
      const data = await getGroupData(gistId, s.githubToken, true);
      const now  = new Date();
      for (const pr of data.prs || []) {
        if (pr.state !== "open" || pr.draft || pr.firstReviewAt) continue;
        if (new Date(pr.reviewDeadline) > now) continue;
        const key     = `notified_${gistId}_${pr.number}`;
        const already = await new Promise(res => chrome.storage.local.get(key, d => res(d[key])));
        if (already) continue;
        chrome.notifications.create({
          type: "basic", iconUrl: "../icons/icon48.png",
          title: "Review overdue",
          message: `${repoKey} — PR #${pr.number} "${pr.title}" has no review yet`,
        });
        await new Promise(res => chrome.storage.local.set({ [key]: true }, res));
      }
    } catch { /* skip failed repos */ }
  }
});
