/* PersonalMail web-ui — Gmail API dans le navigateur (0 € d’hébergement serveur) */

const CFG = window.PM_CONFIG || {};
const LABELS = CFG.labels || {};
const state = {
  token: null,
  email: null,
  messages: [],
  selectedId: null,
  labelIds: {}, // name -> id
  tokenClient: null,
};

function $(id) { return document.getElementById(id); }

function toast(msg) {
  const root = $("toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function flash(msg, ok = false) {
  const el = $("flash");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.className = "flash" + (ok ? " ok" : "");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(Number(iso)).toLocaleString("fr-FR", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

async function gmail(path, options = {}) {
  if (!state.token) throw new Error("Non connecté");
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Gmail HTTP ${res.status}`;
    if (res.status === 401) {
      state.token = null;
      showLogin();
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function ensureLabel(name) {
  if (state.labelIds[name]) return state.labelIds[name];
  const listed = await gmail("labels");
  for (const lab of listed.labels || []) {
    if (lab.name === name) {
      state.labelIds[name] = lab.id;
      return lab.id;
    }
  }
  const created = await gmail("labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  state.labelIds[name] = created.id;
  return created.id;
}

async function resolveLabel(name) {
  if (["INBOX", "STARRED", "UNREAD", "SPAM", "TRASH"].includes(name)) return name;
  return ensureLabel(name);
}

async function modifyMessage(id, add = [], remove = []) {
  const addLabelIds = [];
  const removeLabelIds = [];
  for (const a of add) addLabelIds.push(await resolveLabel(a));
  for (const r of remove) removeLabelIds.push(await resolveLabel(r));
  return gmail(`messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

function classify(subject, from, labelIds) {
  const sub = (subject || "").toLowerCase();
  const fr = (from || "").toLowerCase();
  const blob = `${sub} ${fr}`;
  const labs = new Set(labelIds || []);
  if (sub.startsWith("[personalmail]")) {
    return { kind: "summary", reason: "Résumé PersonalMail" };
  }
  // Important : SOBEGI, alternance, mails personnels
  if (/sobegi|so[\s.\-]?begi/.test(blob)) {
    return { kind: "important", reason: "SOBEGI / lié à SOBEGI" };
  }
  if (/alternance|apprentissage|contrat\s+pro\b|\bcfa\b/.test(blob)) {
    return { kind: "important", reason: "Offre / sujet alternance" };
  }
  // Recrutement générique (hors alternance) → hors boîte
  if (/linkedin|hellowork|indeed|wttj|offre d['’]emploi|job alert|recrut|jobalerts/.test(blob)) {
    return { kind: "job", reason: "Alerte emploi / recrutement" };
  }
  if (
    labs.has("CATEGORY_PROMOTIONS") ||
    labs.has("CATEGORY_SOCIAL") ||
    labs.has("CATEGORY_UPDATES") ||
    labs.has("CATEGORY_FORUMS")
  ) {
    return { kind: "junk", reason: "Promotions / Social / Notifications / Forums" };
  }
  if (/newsletter|unsubscribe|promo|% off|soldes|code promo|vente flash/.test(sub)) {
    return { kind: "junk", reason: "Pub / newsletter" };
  }
  // Mail personnel : Prénom Nom + boîte perso / pas noreply
  const display = String(from || "").replace(/<[^>]+>/g, "").trim();
  const emailMatch = String(from || "").match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : "").toLowerCase();
  const isAuto = /noreply|no-reply|newsletter|notification|mailer-daemon|hellowork|linkedin/.test(fr + email);
  const personName = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+(\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]+){1,3}$/.test(display);
  const personalDomain = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|orange|free|sfr|laposte|wanadoo)\./i.test(email || fr);
  if (!isAuto && (personName || personalDomain)) {
    return { kind: "important", reason: "Mail personnel / interlocuteur réel" };
  }
  return { kind: "normal", reason: "Mail ordinaire" };
}

async function applyKind(messageId, kind) {
  // Boîte = résumé + important uniquement
  if (kind === "junk") {
    await modifyMessage(messageId, [LABELS.junk], ["INBOX"]);
  } else if (kind === "job") {
    await modifyMessage(messageId, [LABELS.job], ["INBOX"]);
  } else if (kind === "important") {
    await modifyMessage(messageId, [LABELS.important, "STARRED", "INBOX"], []);
  } else if (kind === "summary") {
    await modifyMessage(messageId, [LABELS.summary, "INBOX"], []);
  } else {
    await modifyMessage(messageId, [LABELS.todo], ["INBOX"]);
  }
}

async function loadMessages() {
  $("status-line").textContent = "Chargement…";
  // Toutes catégories encore en boîte (Principale + Promotions + Social + Notifications…)
  const listed = await gmail("messages?q=" + encodeURIComponent("in:inbox") + "&maxResults=100");
  const ids = (listed.messages || []).map((m) => m.id);
  const messages = [];
  for (const id of ids) {
    const raw = await gmail(
      `messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    const headers = Object.fromEntries(
      (raw.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
    );
    messages.push({
      id,
      subject: headers.subject || "(sans objet)",
      from: headers.from || "?",
      date: raw.internalDate,
      snippet: raw.snippet || "",
      labelIds: raw.labelIds || [],
    });
  }
  state.messages = messages;
  renderList();
  $("status-line").textContent = `${messages.length} mail(s) en boîte · ${state.email || ""}`;
}

function renderList() {
  const q = ($("search").value || "").trim().toLowerCase();
  const items = state.messages.filter((m) => {
    if (!q) return true;
    return (m.subject + m.from + m.snippet).toLowerCase().includes(q);
  });
  const list = $("mail-list");
  const empty = $("mail-empty");
  if (!items.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = items.map((m) => `
    <li class="mail-item ${m.id === state.selectedId ? "selected" : ""}" data-id="${m.id}">
      <div>
        <div class="mail-from">${escapeHtml(m.from)}</div>
        <div class="mail-subject">${escapeHtml(m.subject)}</div>
        <div class="mail-snippet">${escapeHtml(m.snippet)}</div>
      </div>
      <div class="mail-date">${formatDate(m.date)}</div>
    </li>`).join("");
  list.querySelectorAll(".mail-item").forEach((el) => {
    el.onclick = () => openDetail(el.dataset.id);
  });
}

function openDetail(id) {
  state.selectedId = id;
  renderList();
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  const c = classify(m.subject, m.from, m.labelIds);
  $("detail").innerHTML = `
    <div class="mail-from" style="font-size:1rem">${escapeHtml(m.from)}</div>
    <h2 style="margin:.25rem 0 .5rem;font-size:1.1rem">${escapeHtml(m.subject)}</h2>
    <div class="meta-line">${formatDate(m.date)} · suggestion : <strong>${escapeHtml(c.kind)}</strong> (${escapeHtml(c.reason)})</div>
    <div class="body-preview">${escapeHtml(m.snippet)}</div>
    <div class="actions-row" style="margin-top:1rem">
      <button type="button" class="btn btn-primary btn-sm" data-k="junk">Pubs / archiver</button>
      <button type="button" class="btn btn-secondary btn-sm" data-k="job">Recrutement</button>
      <button type="button" class="btn btn-secondary btn-sm" data-k="important">Important</button>
      <button type="button" class="btn btn-secondary btn-sm" data-k="normal">À-traiter</button>
      <button type="button" class="btn btn-ghost btn-sm" data-k="auto">Appliquer suggestion</button>
    </div>`;
  $("detail").querySelectorAll("[data-k]").forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const kind = btn.dataset.k === "auto" ? c.kind : btn.dataset.k;
        await applyKind(m.id, kind);
        toast("Tri appliqué dans Gmail");
        await loadMessages();
        $("detail").innerHTML = `<div class="detail-empty"><h3>Tri OK</h3><p>Choisis un autre mail.</p></div>`;
        state.selectedId = null;
      } catch (e) {
        flash(e.message);
      }
    };
  });
}

async function autoSortInbox() {
  const btn = $("btn-auto-sort");
  btn.disabled = true;
  btn.textContent = "Tri…";
  let n = 0;
  try {
    flash("");
    for (const m of [...state.messages]) {
      const c = classify(m.subject, m.from, m.labelIds);
      if (c.kind === "summary") {
        await applyKind(m.id, "summary");
      } else if (c.kind === "job" || c.kind === "important") {
        await applyKind(m.id, c.kind);
      } else {
        await applyKind(m.id, c.kind);
      }
      n += 1;
    }
    toast(`${n} mail(s) traités`);
    await loadMessages();
  } catch (e) {
    flash(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Trier la boîte";
  }
}

function shortTxt(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function whoFrom(from) {
  return shortTxt(String(from || "?").replace(/<[^>]+>/g, "").trim() || "?", 40);
}

/** Hier (Europe/Paris) → dates Gmail after:/before: et libellé FR. */
function parisYesterdayRange() {
  const parisStr = new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" });
  const p = new Date(parisStr);
  p.setDate(p.getDate() - 1);
  const y = p.getFullYear();
  const m = p.getMonth() + 1;
  const d = p.getDate();
  const next = new Date(p);
  next.setDate(next.getDate() + 1);
  const gmailAfter = `${y}/${m}/${d}`;
  const gmailBefore = `${next.getFullYear()}/${next.getMonth() + 1}/${next.getDate()}`;
  const labelFr = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
  return { gmailAfter, gmailBefore, labelFr };
}

async function fetchMessagesByQuery(query, maxResults = 80) {
  const listed = await gmail(
    "messages?q=" + encodeURIComponent(query) + "&maxResults=" + maxResults
  );
  const ids = (listed.messages || []).map((m) => m.id);
  const messages = [];
  for (const id of ids) {
    const raw = await gmail(
      `messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
    );
    const headers = Object.fromEntries(
      (raw.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
    );
    messages.push({
      id,
      subject: headers.subject || "(sans objet)",
      from: headers.from || "?",
      date: raw.internalDate,
      snippet: raw.snippet || "",
      labelIds: raw.labelIds || [],
    });
  }
  return messages;
}

async function fetchYesterdayMessages() {
  const { gmailAfter, gmailBefore, labelFr } = parisYesterdayRange();
  // Tous les mails du jour (archivés inclus), hors spam/corbeille/résumés PM
  const q =
    `-in:spam -in:trash -subject:[PersonalMail] after:${gmailAfter} before:${gmailBefore}`;
  const messages = await fetchMessagesByQuery(q, 80);
  return { messages, labelFr, query: q };
}

function buildFrenchDigest(messages, periodLabel) {
  const buckets = { important: [], job: [], junk: [], useful: [], summary: [] };
  for (const m of messages) {
    const c = classify(m.subject, m.from, m.labelIds);
    if (c.kind === "summary") continue;
    const k = c.kind === "normal" ? "useful" : c.kind;
    (buckets[k] || buckets.useful).push(m);
  }
  const nUseful = buckets.important.length + buckets.job.length + buckets.useful.length;
  const period = periodLabel || new Date().toLocaleString("fr-FR");
  const paras = [];
  paras.push(
    `Voici le résumé de ta messagerie (${period}). ` +
    `${messages.length} mail(s) reçus ce jour (y compris déjà triés ou sortis de la boîte), ` +
    `dont ${nUseful} utile(s) et ${buckets.junk.length} pub(s)/bruit.`
  );
  if (buckets.important.length) {
    const bits = buckets.important.slice(0, 5).map((m) => {
      const sn = shortTxt(m.snippet, 110);
      return `${whoFrom(m.from)} au sujet de « ${shortTxt(m.subject, 70)} »` +
        (sn ? ` (${sn})` : "");
    });
    paras.push(
      `En priorité : ${bits.join(". Ensuite, ")}.`
    );
  } else {
    paras.push("Rien d’urgent à traiter en priorité sur cette période.");
  }
  if (buckets.job.length) {
    const samples = buckets.job.slice(0, 4).map((m) => shortTxt(m.subject, 65));
    paras.push(
      `Recrutement : ${buckets.job.length} alerte(s). ` +
      `Exemples : ${samples.map((s) => `« ${s} »`).join(", ")}.`
    );
  }
  if (buckets.useful.length) {
    const bits = buckets.useful.slice(0, 6).map(
      (m) => `« ${shortTxt(m.subject, 55)} » (${whoFrom(m.from)})`
    );
    paras.push(`Autres messages utiles : ${bits.join(" ; ")}.`);
  }
  if (buckets.junk.length) {
    paras.push(
      `${buckets.junk.length} pub(s) / notif(s) / promo(s) ont été (ou peuvent être) filtrées.`
    );
  }
  if (!messages.length) {
    return `Résumé (${period}) : aucun mail reçu ce jour-là.`;
  }
  return paras.join("\n\n");
}

async function sendSelfSummary() {
  const btn = $("btn-summary");
  btn.disabled = true;
  btn.textContent = "Résumé veille…";
  try {
    flash("Chargement des mails de la veille (même déjà triés)…", true);
    const { messages, labelFr } = await fetchYesterdayMessages();
    const body = buildFrenchDigest(messages, `veille ${labelFr}`);
    const raw = btoa(unescape(encodeURIComponent(
      `To: ${state.email}\r\n` +
      `Subject: [PersonalMail] Resume veille ${labelFr}\r\n` +
      `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
      body
    ))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const sent = await gmail("messages/send", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    if (sent?.id) {
      try { await applyKind(sent.id, "summary"); } catch (_) {}
    }
    toast(`Résumé veille (${labelFr}) envoyé — ${messages.length} mail(s)`);
    flash(`Résumé de la veille (${labelFr}) envoyé : ${messages.length} mail(s) analysés.`, true);
  } catch (e) {
    flash(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Résumé de la veille";
  }
}

function showLogin() {
  $("login-view").hidden = false;
  $("app-view").hidden = true;
  $("btn-logout").hidden = true;
  $("user-email").textContent = "";
}

function showApp() {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("btn-logout").hidden = false;
  $("user-email").textContent = state.email || "";
}

function initGis() {
  if (!CFG.clientId || CFG.clientId.includes("REMPLACE")) {
    $("oauth-help").hidden = false;
    $("oauth-help").innerHTML =
      "Configure <span class='mono'>config.js</span> avec un Client ID « Application Web ». Suis <a href='SETUP.html'>SETUP.html</a> (gratuit, ~2 min).";
    return;
  }
  if (!window.google?.accounts?.oauth2) {
    setTimeout(initGis, 200);
    return;
  }
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.clientId,
    scope: CFG.scopes,
    callback: async (resp) => {
      if (resp.error) {
        flash(resp.error_description || resp.error);
        $("oauth-help").hidden = false;
        $("oauth-help").textContent =
          "Échec OAuth. Crée un client « Application Web » et ajoute cette URL dans les origines JavaScript autorisées (SETUP.html).";
        return;
      }
      state.token = resp.access_token;
      try {
        const profile = await gmail("profile");
        state.email = profile.emailAddress;
        showApp();
        await loadMessages();
      } catch (e) {
        flash(e.message);
      }
    },
  });
}

$("btn-login").onclick = () => {
  if (!state.tokenClient) {
    flash("Google Identity pas prêt — recharge la page.");
    return;
  }
  state.tokenClient.requestAccessToken({ prompt: "" });
};

$("btn-logout").onclick = () => {
  if (state.token && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(state.token, () => {});
  }
  state.token = null;
  state.messages = [];
  showLogin();
};

$("btn-refresh").onclick = () => loadMessages().catch((e) => flash(e.message));
$("btn-auto-sort").onclick = () => autoSortInbox();
$("btn-summary").onclick = () => sendSelfSummary();
$("search").oninput = () => renderList();

window.addEventListener("load", initGis);
