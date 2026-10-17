"use strict";

/* ============================================================
 * 定数
 * ========================================================== */

const SCHEMA_VERSION = 1;
const DEFAULT_COLOR = "#888888";

const DB_NAME = "log-search-index";
const DB_VERSION = 2; // 2: キャラクター統合設定などを保存する settings ストアを追加（2026-10-16）
const STORE_SESSIONS = "sessions";
const STORE_SCROLL = "scrollPositions";
const STORE_SETTINGS = "settings";
const SETTING_ALIASES = "characterAliases";
const SETTING_SPEAKER_ROLES = "speakerRoles";
const SETTING_SECTIONS = "sections";
const SETTING_CURRENT_SECTION = "currentSectionId";

/* ============================================================
 * ユーティリティ
 * ========================================================== */

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
}

function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

// 外部ファイル由来の色は必ずここを通す。#rrggbb 以外は既定色に落とし、
// style属性への文字列注入を防ぐ（CClogのXSS修正の教訓を踏襲、8.1章参照）。
function normalizeColor(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : DEFAULT_COLOR;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTimestampForFilename(date) {
  return (
    date.getFullYear() +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    "_" +
    pad2(date.getHours()) +
    pad2(date.getMinutes())
  );
}

// レイアウト確定後に実行したいが、バックグラウンドタブ等ではrequestAnimationFrameが
// いつまでも発火しないことがあるため、setTimeoutの保険を必ず併用する。
function afterLayout(cb) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    cb();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 80);
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ============================================================
 * ファイル名からのシナリオ名・日付の自動抽出（5.5章）
 * 拾える範囲は自動で拾い、拾えなければ null のまま扱う。
 * ========================================================== */

function extractTitleAndDate(fileName) {
  let base = fileName.replace(/\.[^./\\]+$/, "");
  // ココフォリアの書き出し名末尾によく付く "[all]" 等のタグを取り除く
  base = base.replace(/(\s*\[[^[\]]*\])+$/, "").trim();

  const patterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/,
    /(\d{4})年(\d{1,2})月(\d{1,2})日/,
    /(\d{4})(\d{2})(\d{2})/,
  ];

  // "_2026-08-02" のようにアンダースコア等の直後に日付が来るファイル名は多いため、
  // \bではなく前後の文字が数字でないことだけを手動で確認する（アンダースコアは\w扱いで\bが効かないため）。
  let date = null;
  for (const re of patterns) {
    const m = base.match(re);
    if (!m) continue;
    const before = base[m.index - 1];
    const after = base[m.index + m[0].length];
    if ((before && /\d/.test(before)) || (after && /\d/.test(after))) continue;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y >= 1900 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      date = `${y}-${pad2(mo)}-${pad2(d)}`;
      break;
    }
  }

  return { title: base || fileName, date };
}

/* ============================================================
 * ログHTMLの解析（4章）
 * ココフォリア生HTML／CClogプレビュー用HTMLの2形式のみを対象とする。
 * パースロジックはCClog本体(app.js)のものを踏襲する。
 * ========================================================== */

function getTextWithBr(elNode) {
  const clone = elNode.cloneNode(true);
  clone.querySelectorAll("br").forEach((br) => {
    br.replaceWith(document.createTextNode("\n"));
  });
  const raw = clone.textContent || "";
  return raw
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// タブ名から表示カテゴリを判定する。CClogのgetTabCategoryと同じ考え方。
function getTabCategory(tab) {
  let t = (tab || "").trim().normalize("NFKC").toLowerCase();
  const bracketed = t.match(/^\[(.+)\]$/);
  if (bracketed) t = bracketed[1];
  if (t === "info") return "info";
  if (t === "other") return "other";
  return "main";
}

// ココフォリアの生HTML書き出し・新形式（2026年9月頃から）。1発言 = <article class="message">。
// 発言者は .speaker（色は style の --speaker-color）、タブは .channel-name / data-channel、
// 本文は .message-text。ダイスロールの結果文は .message-text とは別の .roll-result に
// 入るため、コマンド文と結合して1つの本文にする（CClog app.js parseCcfoliaHtmlNew と同じ）。
// システムメッセージ（article.message.system）は発言者なしの1行として扱う。
function parseCocofoliaHtmlNew(doc, articles) {
  const messages = [];
  let firstTimestamp = null;
  articles.forEach((article) => {
    const channel = article.getAttribute("data-channel") || "main";
    const channelNameEl = article.querySelector(".channel-name");
    const tabName = channelNameEl ? getTextWithBr(channelNameEl) : "";
    // data-channel が main/info/other 以外（独自タブはIDになる）のときはタブ名から判定する
    const category = ["main", "info", "other"].includes(channel) ? channel : getTabCategory(tabName);

    const timeEl = article.querySelector("time[datetime]");
    if (!firstTimestamp && timeEl) firstTimestamp = timeEl.getAttribute("datetime");

    const textEl = article.querySelector(".message-text");
    const commandText = textEl ? getTextWithBr(textEl) : "";

    if (article.classList.contains("system")) {
      if (commandText) messages.push({ speaker: "", text: commandText, color: normalizeColor(null), category });
      return;
    }

    const speakerEl = article.querySelector(".speaker");
    const speaker = speakerEl ? getTextWithBr(speakerEl) : "";
    const speakerStyle = speakerEl ? speakerEl.getAttribute("style") || "" : "";
    const colorMatch = speakerStyle.match(/--speaker-color:\s*(#[0-9a-fA-F]{6})/);
    const color = normalizeColor(colorMatch ? colorMatch[1] : null);

    const rollEl = article.querySelector(".roll-result");
    const rollText = rollEl ? getTextWithBr(rollEl) : "";
    const text = [commandText, rollText].filter(Boolean).join("\n");
    messages.push({ speaker, text, color, category });
  });
  return { messages, firstTimestamp };
}

// ISO形式の日時（UTC）を、閲覧端末のローカル日付 "YYYY-MM-DD" にする
function isoToLocalDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ココフォリアの生HTML書き出し・旧形式（4章）。1発言 = <p style="color:...;"> の中に
// <span>タブ</span><span>発言者</span> : <span>本文</span> という構造。
function parseCocofoliaHtml(doc) {
  const paragraphs = doc.querySelectorAll('p[style*="color:"]');
  const messages = [];
  paragraphs.forEach((p) => {
    const spans = p.querySelectorAll(":scope > span");
    if (spans.length < 3) return;
    const styleAttr = p.getAttribute("style") || "";
    const colorMatch = styleAttr.match(/color:\s*(#[0-9a-fA-F]{6})/);
    const color = normalizeColor(colorMatch ? colorMatch[1] : null);
    const tabRaw = getTextWithBr(spans[0]) || "[main]";
    const speaker = getTextWithBr(spans[1]);
    const text = getTextWithBr(spans[2]);
    messages.push({ speaker, text, color, category: getTabCategory(tabRaw) });
  });
  return messages;
}

// CClogが書き出す「プレビュー用HTML」。<p class="ccpv-line ccpv-tab-...">
// <span class="ccpv-speaker">発言者</span>：本文</p> という構造（CClog app.js
// buildPreviewLineHtml参照）。CClog本体はこの形式を読み込めない仕様のため、
// 本ツール独自にパースする。
// 2026年9月以降のCClogは、「キャラクター発言」に設定した発言者を
// <div class="ccpv-bubble-row ccpv-tab-..."> の吹き出し形式で、システムメッセージを
// <p class="ccpv-line ccpv-system"> で書き出すため、これらも文書順に読む。
function getPreviewCategory(node) {
  if (node.classList.contains("ccpv-tab-info")) return "info";
  if (node.classList.contains("ccpv-tab-other")) return "other";
  return "main";
}

function parsePreviewHtml(doc) {
  const lines = doc.querySelectorAll(".ccpv-line, .ccpv-bubble-row");
  const messages = [];
  lines.forEach((p) => {
    if (p.classList.contains("ccpv-bubble-row")) {
      const nameEl = p.querySelector(".ccpv-bubble-name");
      const bubbleEl = p.querySelector(".ccpv-bubble");
      const avatarEl = p.querySelector(".ccpv-bubble-avatar");
      const m = ((avatarEl && avatarEl.getAttribute("style")) || "").match(/border-color:\s*(#[0-9a-fA-F]{6})/);
      messages.push({
        speaker: nameEl ? getTextWithBr(nameEl) : "",
        text: bubbleEl ? getTextWithBr(bubbleEl) : "",
        color: normalizeColor(m ? m[1] : null),
        category: getPreviewCategory(p),
      });
      return;
    }
    if (p.classList.contains("ccpv-system")) {
      messages.push({ speaker: "", text: getTextWithBr(p), color: normalizeColor(null), category: "main" });
      return;
    }
    if (p.classList.contains("ccpv-tab-info")) {
      messages.push({ speaker: "", text: getTextWithBr(p), color: normalizeColor(null), category: "info" });
      return;
    }
    const clone = p.cloneNode(true);
    const speakerEl = clone.querySelector(".ccpv-speaker");
    let speaker = "";
    let color = normalizeColor(null);
    if (speakerEl) {
      speaker = getTextWithBr(speakerEl);
      const styleAttr = speakerEl.getAttribute("style") || "";
      const m = styleAttr.match(/color:\s*(#[0-9a-fA-F]{6})/);
      if (m) color = normalizeColor(m[1]);
      speakerEl.remove();
    }
    const text = getTextWithBr(clone).replace(/^：\s*/, "");
    const category = p.classList.contains("ccpv-tab-other") ? "other" : "main";
    messages.push({ speaker, text, color, category });
  });
  return messages;
}

function parseLogHtml(htmlString) {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  if (doc.querySelector(".ccpv-line, .ccpv-bubble-row")) {
    return { format: "preview", messages: parsePreviewHtml(doc) };
  }
  // ココフォリアは新形式（article.message）と旧形式の両方がありうる（新形式を先に判定）
  const articles = doc.querySelectorAll("article.message");
  if (articles.length > 0) {
    const { messages, firstTimestamp } = parseCocofoliaHtmlNew(doc, articles);
    return { format: "cocofolia", messages, logDate: isoToLocalDate(firstTimestamp) };
  }
  if (doc.querySelector('p[style*="color:"] > span')) {
    return { format: "cocofolia", messages: parseCocofoliaHtml(doc) };
  }
  return null;
}

function normalizeMessages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      speaker: toText(m.speaker),
      text: toText(m.text),
      color: normalizeColor(m.color),
      category: ["main", "info", "other"].includes(m.category) ? m.category : "main",
    }));
}

/* ============================================================
 * IndexedDB（3.1章：永続保存ではなく作業用キャッシュという位置づけ）
 * ========================================================== */

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SCROLL)) {
        db.createObjectStore(STORE_SCROLL, { keyPath: "sessionId" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbGetAllSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readonly");
    const req = tx.objectStore(STORE_SESSIONS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutAllSessions(sessions) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    const store = tx.objectStore(STORE_SESSIONS);
    sessions.forEach((s) => store.put(s));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteSession(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClearSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SESSIONS, "readwrite");
    tx.objectStore(STORE_SESSIONS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetSetting(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_SETTINGS, "readonly").objectStore(STORE_SETTINGS).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

async function dbPutSetting(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, "readwrite");
    tx.objectStore(STORE_SETTINGS).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveScrollPos(sessionId, pos) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SCROLL, "readwrite");
      tx.objectStore(STORE_SCROLL).put({ sessionId, pos });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 閲覧位置の保存に失敗しても致命的ではないので握りつぶす
  }
}

async function loadScrollPos(sessionId) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE_SCROLL, "readonly").objectStore(STORE_SCROLL).get(sessionId);
      req.onsuccess = () => resolve(req.result ? req.result.pos : 0);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return 0;
  }
}

async function dbDeleteScrollPos(sessionId) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SCROLL, "readwrite");
      tx.objectStore(STORE_SCROLL).delete(sessionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    // 無視
  }
}

/* ============================================================
 * 並び順（5.5・6章）
 * 日付が拾えたログは日付順に挿入し、拾えなかったログは末尾に追加する。
 * 一度手動で並べ替えたセッションの相対順序はそのまま尊重する。
 * ========================================================== */

function insertNewSessionsIntoOrder(existing, newSessions) {
  let list = existing.slice();
  const dated = newSessions
    .filter((s) => s.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const undated = newSessions.filter((s) => !s.date);

  dated.forEach((ns) => {
    let idx = list.findIndex((s) => s.date && s.date > ns.date);
    if (idx === -1) {
      idx = list.findIndex((s) => !s.date);
      if (idx === -1) idx = list.length;
    }
    list.splice(idx, 0, ns);
  });

  list = list.concat(undated);
  list.forEach((s, i) => {
    s.order = i;
  });
  return list;
}

/* ============================================================
 * アプリ状態
 * ========================================================== */

const state = {
  sessions: [], // 表示中のセクションのセッション { id, sectionId, title, date, dateAuto, order, format, fileName, addedAt, messages }
  otherSessions: [], // 表示中以外のセクションのセッション（切り替え・バックアップ用に保持する）
  sections: [], // { id, name, createdAt, updatedAt, lastSessionId }（2026-10-16追加）
  currentSectionId: null,
  view: "list", // 'list' | 'session'
  currentSessionId: null,
  reorderMode: false,
  filter: { keyword: "", characters: new Set() },
  aliases: {}, // キャラクター統合設定 { 元の発言者名: 代表の名前 }（5.4章）
  charIndex: new Map(), // 代表の名前 -> { count, color, members: Map(元の名前 -> 発言数) }
  speakerRoles: {}, // KP・PLの手動設定 { 代表の名前: "kp" | "pl" | "character" }（5.3章）
  hits: [], // [{ sessionId, msgIndex }]
  hitIndex: -1,
};

/* ============================================================
 * DOM要素
 * ========================================================== */

const el = {
  btnSidebarOpen: document.getElementById("btn-sidebar-open"),
  sidebarFilterDot: document.getElementById("sidebar-filter-dot"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  btnSidebarClose: document.getElementById("btn-sidebar-close"),
  btnGotoList: document.getElementById("btn-goto-list"),

  currentSectionName: document.getElementById("current-section-name"),
  btnNewSection: document.getElementById("btn-new-section"),
  sectionHistory: document.getElementById("section-history"),
  listSectionLabel: document.getElementById("list-section-label"),

  fileInput: document.getElementById("file-input"),
  folderInput: document.getElementById("folder-input"),
  folderPickerArea: document.getElementById("folder-picker-area"),
  loadStatus: document.getElementById("load-status"),

  searchKeywordInput: document.getElementById("search-keyword-input"),
  characterChecklist: document.getElementById("character-checklist"),
  btnApplyFilter: document.getElementById("btn-apply-filter"),
  btnClearFilter: document.getElementById("btn-clear-filter"),
  btnOpenMerge: document.getElementById("btn-open-merge"),
  btnOpenRoles: document.getElementById("btn-open-roles"),
  filterSummary: document.getElementById("filter-summary"),

  btnToggleReorder: document.getElementById("btn-toggle-reorder"),
  sidebarReorderSection: document.getElementById("sidebar-reorder-section"),
  reorderBar: document.getElementById("reorder-bar"),
  btnReorderDone: document.getElementById("btn-reorder-done"),

  btnBackupExport: document.getElementById("btn-backup-export"),
  backupFileInput: document.getElementById("backup-file-input"),

  viewList: document.getElementById("view-list"),
  listEmptyNote: document.getElementById("list-empty-note"),
  reorderNote: document.getElementById("reorder-note"),
  sessionList: document.getElementById("session-list"),

  viewSession: document.getElementById("view-session"),
  btnPrevSession: document.getElementById("btn-prev-session"),
  sessionViewTitle: document.getElementById("session-view-title"),
  sessionViewMeta: document.getElementById("session-view-meta"),
  btnNextSession: document.getElementById("btn-next-session"),
  btnPrevSessionBottom: document.getElementById("btn-prev-session-bottom"),
  btnNextSessionBottom: document.getElementById("btn-next-session-bottom"),
  hitNav: document.getElementById("hit-nav"),
  hitNavLabel: document.getElementById("hit-nav-label"),
  btnHitPrev: document.getElementById("btn-hit-prev"),
  btnHitNext: document.getElementById("btn-hit-next"),
  btnHitClose: document.getElementById("btn-hit-close"),
  sessionMessageList: document.getElementById("session-message-list"),

  assignOverlay: document.getElementById("assign-overlay"),
  assignOverlayBackdrop: document.getElementById("assign-overlay-backdrop"),
  assignDesc: document.getElementById("assign-desc"),
  assignList: document.getElementById("assign-list"),
  btnAssignCancel: document.getElementById("btn-assign-cancel"),
  btnAssignConfirm: document.getElementById("btn-assign-confirm"),

  backupModeOverlay: document.getElementById("backup-mode-overlay"),
  backupModeOverlayBackdrop: document.getElementById("backup-mode-overlay-backdrop"),
  backupModeDesc: document.getElementById("backup-mode-desc"),
  btnBackupRestore: document.getElementById("btn-backup-restore"),
  btnBackupMerge: document.getElementById("btn-backup-merge"),
  btnBackupModeCancel: document.getElementById("btn-backup-mode-cancel"),

  backupPromptToast: document.getElementById("backup-prompt-toast"),
  btnBackupPromptDismiss: document.getElementById("btn-backup-prompt-dismiss"),
  btnBackupPromptExport: document.getElementById("btn-backup-prompt-export"),

  simpleToast: document.getElementById("simple-toast"),

  mergeOverlay: document.getElementById("merge-overlay"),
  mergeOverlayBackdrop: document.getElementById("merge-overlay-backdrop"),
  mergeSuggestionsWrap: document.getElementById("merge-suggestions-wrap"),
  mergeSuggestions: document.getElementById("merge-suggestions"),
  mergeChecklist: document.getElementById("merge-checklist"),
  mergeRepSelect: document.getElementById("merge-rep-select"),
  btnMergeConfirm: document.getElementById("btn-merge-confirm"),
  mergeGroupsWrap: document.getElementById("merge-groups-wrap"),
  mergeGroups: document.getElementById("merge-groups"),
  btnMergeClose: document.getElementById("btn-merge-close"),

  rolesOverlay: document.getElementById("roles-overlay"),
  rolesOverlayBackdrop: document.getElementById("roles-overlay-backdrop"),
  rolesList: document.getElementById("roles-list"),
  btnRolesClose: document.getElementById("btn-roles-close"),
  simpleToastText: document.getElementById("simple-toast-text"),
};

/* ============================================================
 * トースト
 * ========================================================== */

function showBackupPromptToast() {
  el.backupPromptToast.hidden = false;
}
function hideBackupPromptToast() {
  el.backupPromptToast.hidden = true;
}

let simpleToastTimer = null;
function showSimpleToast(text, ms = 2500) {
  el.simpleToastText.textContent = text;
  el.simpleToast.hidden = false;
  if (simpleToastTimer) clearTimeout(simpleToastTimer);
  simpleToastTimer = setTimeout(() => {
    el.simpleToast.hidden = true;
  }, ms);
}

/* ============================================================
 * サイドバー
 * ========================================================== */

function openSidebar() {
  el.sidebar.classList.add("is-open");
  el.sidebarBackdrop.hidden = false;
}
function closeSidebar() {
  el.sidebar.classList.remove("is-open");
  el.sidebarBackdrop.hidden = true;
}
el.btnSidebarOpen.addEventListener("click", openSidebar);
el.btnSidebarClose.addEventListener("click", closeSidebar);
el.sidebarBackdrop.addEventListener("click", closeSidebar);
// セッション一覧にいるときは「セッション一覧に戻る」を出さない（2026-10-16、Mikoto要望）
function updateGotoListButton() {
  el.btnGotoList.hidden = state.view !== "session";
}
el.btnGotoList.addEventListener("click", async () => {
  await backToList();
  closeSidebar();
});

/* ============================================================
 * キャラクター一覧（5.4章）
 * ========================================================== */

// 発言者名を、キャラクター統合設定にもとづく代表の名前にする
function canonicalName(raw) {
  return Object.prototype.hasOwnProperty.call(state.aliases, raw) ? state.aliases[raw] : raw;
}

// 全セッションの発言から、代表の名前ごとの発言数・表示色・統合元の名前を集計する。
// 色は既定色（色なし）以外で最も多く使われた色にする。これにより、同じ名前で
// 色なし・色ありの発言が混在していても、自動的に色ありの方にそろう（2026-10-16、Mikoto要望）。
function rebuildCharacterIndex() {
  const index = new Map();
  state.sessions.forEach((s) =>
    s.messages.forEach((m) => {
      if (!m.speaker) return;
      const name = canonicalName(m.speaker);
      let entry = index.get(name);
      if (!entry) {
        entry = { count: 0, color: DEFAULT_COLOR, colorCounts: new Map(), members: new Map() };
        index.set(name, entry);
      }
      entry.count++;
      entry.members.set(m.speaker, (entry.members.get(m.speaker) || 0) + 1);
      if (m.color !== DEFAULT_COLOR) entry.colorCounts.set(m.color, (entry.colorCounts.get(m.color) || 0) + 1);
    })
  );
  index.forEach((entry) => {
    let best = 0;
    entry.colorCounts.forEach((n, color) => {
      if (n > best) {
        best = n;
        entry.color = color;
      }
    });
  });
  state.charIndex = index;
}

// 発言数の多い順（同数なら名前順）に並べた代表の名前の一覧（2026-10-16、Mikoto要望）
function sortedCharacterNames() {
  return Array.from(state.charIndex.keys()).sort(
    (a, b) => state.charIndex.get(b).count - state.charIndex.get(a).count || a.localeCompare(b, "ja")
  );
}

function renderCharacterChecklist() {
  rebuildCharacterIndex();
  const names = sortedCharacterNames();

  el.characterChecklist.innerHTML = "";
  if (names.length === 0) {
    const p = document.createElement("p");
    p.className = "character-checklist__empty";
    p.textContent = "ログを読み込むと発言者が表示されます。";
    el.characterChecklist.appendChild(p);
    return;
  }

  names.forEach((name) => {
    const entry = state.charIndex.get(name);
    const label = document.createElement("label");
    label.className = "character-check";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.checked = state.filter.characters.has(name);

    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = entry.color;

    const textSpan = document.createElement("span");
    textSpan.textContent = `${name}（${entry.count}）`;
    const others = Array.from(entry.members.keys()).filter((n) => n !== name);
    if (others.length) {
      const sub = document.createElement("span");
      sub.className = "character-check__members";
      sub.textContent = `統合: ${others.join("、")}`;
      textSpan.appendChild(sub);
    }

    label.appendChild(checkbox);
    label.appendChild(dot);
    label.appendChild(textSpan);
    el.characterChecklist.appendChild(label);
  });
}

/* ============================================================
 * キャラクターの統合（5.4章、2026-10-16追加）
 * 選んだ複数の発言者名を、1人のキャラクター（代表の名前）として扱う。
 * 元のログは書き換えず、表示・絞り込みのときだけ代表の名前・色に読み替える。
 * ========================================================== */

// 統合候補の判定用キー。全角半角・スペースの有無・末尾の読み仮名（「立花 果凛（たちばな かりん）」
// のような括弧書き）の違いを無視する（2026-10-16、Mikoto要望）。
function characterMatchKey(name) {
  return name
    .normalize("NFKC")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .replace(/\s+/g, "");
}

function findMergeSuggestions() {
  const groups = new Map();
  sortedCharacterNames().forEach((name) => {
    const key = characterMatchKey(name);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(name);
  });
  return Array.from(groups.values()).filter((g) => g.length >= 2);
}

async function saveAliases() {
  try {
    await dbPutSetting(SETTING_ALIASES, state.aliases);
  } catch (e) {
    showSimpleToast("統合設定の保存中にエラーが発生しました。");
  }
}

// 統合設定の変更後、絞り込み中のキャラクター・検索結果・表示をすべて新しい設定に合わせる
function refreshAfterAliasChange() {
  state.filter.characters = new Set(Array.from(state.filter.characters).map(canonicalName));
  renderCharacterChecklist();
  const hasFilter = state.filter.keyword.trim() !== "" || state.filter.characters.size > 0;
  if (hasFilter) {
    state.hits = computeHits();
    state.hitIndex = state.hits.length > 0 ? Math.min(Math.max(state.hitIndex, 0), state.hits.length - 1) : -1;
  }
  updateFilterSummary();
  if (state.view === "session") {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (session) renderSessionMessageList(session);
    updateHitNav();
  } else {
    renderSessionList();
  }
  renderMergeModal();
}

async function mergeCharacters(selectedNames, rep) {
  const selected = new Set(selectedNames);
  // すでに統合済みのものも含め、選んだキャラクターに属する元の名前をすべて代表の名前に向ける
  Object.keys(state.aliases).forEach((raw) => {
    if (selected.has(state.aliases[raw])) state.aliases[raw] = rep;
  });
  selectedNames.forEach((name) => {
    const entry = state.charIndex.get(name);
    if (entry) entry.members.forEach((_, raw) => (state.aliases[raw] = rep));
    state.aliases[name] = rep;
  });
  delete state.aliases[rep];
  await saveAliases();
  refreshAfterAliasChange();
  showSimpleToast(`${selectedNames.length}件を「${rep}」に統合しました。`);
}

async function unmergeCharacter(rep) {
  const entry = state.charIndex.get(rep);
  Object.keys(state.aliases).forEach((raw) => {
    if (state.aliases[raw] === rep) delete state.aliases[raw];
  });
  // 解除したキャラクターで絞り込んでいた場合は、元の名前すべてを絞り込み対象に戻す
  if (state.filter.characters.has(rep) && entry) {
    entry.members.forEach((_, raw) => state.filter.characters.add(raw));
  }
  await saveAliases();
  refreshAfterAliasChange();
  showSimpleToast(`「${rep}」の統合を解除しました。`);
}

function getMergeSelection() {
  return Array.from(el.mergeChecklist.querySelectorAll("input[type=checkbox]:checked")).map((cb) => cb.value);
}

// 代表の名前の選択肢を、選んだキャラクターに合わせて作り直す（初期値は発言数の最も多い名前）
function updateMergeRepSelect() {
  const selected = getMergeSelection();
  const prev = el.mergeRepSelect.value;
  el.mergeRepSelect.innerHTML = "";
  selected
    .slice()
    .sort((a, b) => state.charIndex.get(b).count - state.charIndex.get(a).count)
    .forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name}（${state.charIndex.get(name).count}）`;
      el.mergeRepSelect.appendChild(opt);
    });
  if (selected.includes(prev)) el.mergeRepSelect.value = prev;
  el.mergeRepSelect.disabled = selected.length < 2;
  el.btnMergeConfirm.disabled = selected.length < 2;
}

function buildMergeRow(text, buttonLabel, onClick) {
  const row = document.createElement("div");
  row.className = "merge-row";
  const span = document.createElement("span");
  span.className = "merge-row__text";
  span.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn--secondary btn--small";
  btn.textContent = buttonLabel;
  btn.addEventListener("click", onClick);
  row.appendChild(span);
  row.appendChild(btn);
  return row;
}

function renderMergeModal() {
  if (el.mergeOverlay.hidden) return;
  const names = sortedCharacterNames();

  // 統合候補（表記ゆれ）
  const suggestions = findMergeSuggestions();
  el.mergeSuggestions.innerHTML = "";
  el.mergeSuggestionsWrap.hidden = suggestions.length === 0;
  suggestions.forEach((group) => {
    el.mergeSuggestions.appendChild(
      buildMergeRow(group.join(" ／ "), "選ぶ", () => {
        const set = new Set(group);
        el.mergeChecklist.querySelectorAll("input[type=checkbox]").forEach((cb) => {
          cb.checked = set.has(cb.value);
        });
        updateMergeRepSelect();
        el.mergeRepSelect.scrollIntoView({ block: "nearest" });
      })
    );
  });

  // 統合するキャラクターの選択（作り直しても選択状態は保つ）
  const keep = new Set(getMergeSelection());
  el.mergeChecklist.innerHTML = "";
  names.forEach((name) => {
    const entry = state.charIndex.get(name);
    const label = document.createElement("label");
    label.className = "character-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = keep.has(name);
    cb.addEventListener("change", updateMergeRepSelect);
    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = entry.color;
    const textSpan = document.createElement("span");
    textSpan.textContent = `${name}（${entry.count}）`;
    label.appendChild(cb);
    label.appendChild(dot);
    label.appendChild(textSpan);
    el.mergeChecklist.appendChild(label);
  });
  updateMergeRepSelect();

  // 統合済みの一覧（現在のログにない名前の統合設定も、解除できるよう表示する）
  const byRep = new Map();
  Object.keys(state.aliases).forEach((raw) => {
    const rep = state.aliases[raw];
    if (!byRep.has(rep)) byRep.set(rep, []);
    byRep.get(rep).push(raw);
  });
  el.mergeGroups.innerHTML = "";
  el.mergeGroupsWrap.hidden = byRep.size === 0;
  byRep.forEach((others, rep) => {
    el.mergeGroups.appendChild(buildMergeRow(`${rep} ← ${others.join("、")}`, "解除", () => unmergeCharacter(rep)));
  });
}

function openMergeModal() {
  rebuildCharacterIndex();
  if (state.charIndex.size === 0) {
    showSimpleToast("ログを読み込むと発言者を統合できます。");
    return;
  }
  el.mergeChecklist.innerHTML = "";
  el.mergeOverlay.hidden = false;
  renderMergeModal();
}

function closeMergeModal() {
  el.mergeOverlay.hidden = true;
}

el.btnOpenMerge.addEventListener("click", openMergeModal);
el.btnMergeClose.addEventListener("click", closeMergeModal);
el.mergeOverlayBackdrop.addEventListener("click", closeMergeModal);
el.btnMergeConfirm.addEventListener("click", () => {
  const selected = getMergeSelection();
  const rep = el.mergeRepSelect.value;
  if (selected.length < 2 || !selected.includes(rep)) return;
  el.mergeChecklist.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = false));
  mergeCharacters(selected, rep);
});

/* ============================================================
 * KP・PL（地の文）の設定（5.3章、2026-10-16追加）
 * KP・PLの発言は地の文、それ以外はキャラクター発言として表示を分ける
 * （CClogのプレビュー用HTMLの見た目にならう）。
 * 名前が「KP」「PL」の発言者は自動でKP・PLにし、それ以外もメニューから設定できる。
 * ========================================================== */

const ROLE_LABELS = { kp: "KP（地の文）", pl: "PL（地の文）", character: "キャラクター" };

// 名前だけから決まる既定の役割（全角・大文字小文字の違いは無視）
function autoSpeakerRole(name) {
  const t = name.normalize("NFKC").trim().toUpperCase();
  if (t === "KP") return "kp";
  if (t === "PL") return "pl";
  return "character";
}

// 代表の名前（統合後）に対する役割。手動設定があればそれを優先する
function getSpeakerRole(name) {
  return Object.prototype.hasOwnProperty.call(state.speakerRoles, name) ? state.speakerRoles[name] : autoSpeakerRole(name);
}

// ダイスロールの発言かどうか（CClogのdetectDiceRollと同じ判定）。
// 新形式のログではロール結果をコマンド文と結合して本文にしているため、本文だけで判定できる。
function isDiceRollText(text) {
  return /\d+d\d+/i.test(text) && text.includes("＞");
}

async function saveSpeakerRoles() {
  try {
    await dbPutSetting(SETTING_SPEAKER_ROLES, state.speakerRoles);
  } catch (e) {
    showSimpleToast("KP・PLの設定の保存中にエラーが発生しました。");
  }
}

// 外部ファイル由来の役割設定を検査する（kp/pl/character 以外は捨てる）
function normalizeSpeakerRoles(obj) {
  const out = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    Object.keys(obj).forEach((k) => {
      if (k && ["kp", "pl", "character"].includes(obj[k])) out[k] = obj[k];
    });
  }
  return out;
}

async function setSpeakerRole(name, role) {
  // 自動判定と同じになる場合は手動設定を消し、設定を最小限に保つ
  if (role === autoSpeakerRole(name)) delete state.speakerRoles[name];
  else state.speakerRoles[name] = role;
  await saveSpeakerRoles();
  if (state.view === "session") {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (session) renderSessionMessageList(session);
  }
}

function renderRolesModal() {
  rebuildCharacterIndex();
  el.rolesList.innerHTML = "";
  sortedCharacterNames().forEach((name) => {
    const entry = state.charIndex.get(name);
    const row = document.createElement("div");
    row.className = "merge-row";

    const dot = document.createElement("span");
    dot.className = "color-dot";
    dot.style.background = entry.color;

    const text = document.createElement("span");
    text.className = "merge-row__text";
    text.textContent = `${name}（${entry.count}）`;

    const select = document.createElement("select");
    select.className = "role-select";
    ["character", "kp", "pl"].forEach((role) => {
      const opt = document.createElement("option");
      opt.value = role;
      opt.textContent = ROLE_LABELS[role];
      select.appendChild(opt);
    });
    select.value = getSpeakerRole(name);
    select.addEventListener("change", () => setSpeakerRole(name, select.value));

    row.appendChild(dot);
    row.appendChild(text);
    row.appendChild(select);
    el.rolesList.appendChild(row);
  });
}

function openRolesModal() {
  rebuildCharacterIndex();
  if (state.charIndex.size === 0) {
    showSimpleToast("ログを読み込むとKP・PLを設定できます。");
    return;
  }
  el.rolesOverlay.hidden = false;
  renderRolesModal();
}

function closeRolesModal() {
  el.rolesOverlay.hidden = true;
}

el.btnOpenRoles.addEventListener("click", openRolesModal);
el.btnRolesClose.addEventListener("click", closeRolesModal);
el.rolesOverlayBackdrop.addEventListener("click", closeRolesModal);

/* ============================================================
 * 検索・絞り込み（5.4章）
 * ========================================================== */

function computeHits() {
  const kw = state.filter.keyword.trim().toLowerCase();
  const chars = state.filter.characters;
  if (!kw && chars.size === 0) return [];

  const hits = [];
  state.sessions.forEach((session) => {
    session.messages.forEach((m, idx) => {
      const speakerOk = chars.size === 0 || chars.has(canonicalName(m.speaker));
      const keywordOk = !kw || m.text.toLowerCase().includes(kw);
      if (speakerOk && keywordOk) hits.push({ sessionId: session.id, msgIndex: idx });
    });
  });
  return hits;
}

function updateFilterSummary() {
  const kw = state.filter.keyword.trim();
  const chars = Array.from(state.filter.characters);
  if (!kw && chars.length === 0) {
    el.filterSummary.textContent = "絞り込みなし";
    return;
  }
  const parts = [];
  if (kw) parts.push(`キーワード「${kw}」`);
  if (chars.length) parts.push("発言者: " + chars.join("、"));
  el.filterSummary.textContent = `${parts.join(" / ")}（${state.hits.length}件ヒット）`;
}

function updateFilterBadge() {
  const active = state.filter.keyword.trim() !== "" || state.filter.characters.size > 0;
  el.sidebarFilterDot.hidden = !active;
}

function clearFilterState() {
  state.filter = { keyword: "", characters: new Set() };
  state.hits = [];
  state.hitIndex = -1;
  el.searchKeywordInput.value = "";
  updateFilterSummary();
  updateFilterBadge();
}

el.btnApplyFilter.addEventListener("click", () => {
  const keyword = el.searchKeywordInput.value;
  const characters = new Set(
    Array.from(el.characterChecklist.querySelectorAll("input[type=checkbox]:checked")).map((cb) => cb.value)
  );
  state.filter = { keyword, characters };
  state.hits = computeHits();
  state.hitIndex = state.hits.length > 0 ? 0 : -1;
  updateFilterSummary();
  updateFilterBadge();
  closeSidebar();

  if (state.hits.length > 0) {
    // 検索条件が変わりハイライトを付け直す必要があるため、同じセッション内でも描き直す
    gotoHit(0, { rerender: true });
  } else {
    backToList();
    if (keyword.trim() || characters.size > 0) {
      showSimpleToast("一致する発言が見つかりませんでした。");
    }
  }
});

el.btnClearFilter.addEventListener("click", () => {
  clearFilterState();
  if (state.view === "session") {
    const session = state.sessions.find((s) => s.id === state.currentSessionId);
    if (session) renderSessionMessageList(session);
    updateHitNav();
  } else {
    renderSessionList();
  }
  renderCharacterChecklist();
});

// 以前は一致箇所へ移るたびにセッション全体を描き直していたため、iPhoneで「次へ」を連打すると
// 描き直しが積み重なってSafariがページを落とすことがあった（2026-10-17、Mikoto報告）。
// 同じセッション内の移動はスクロールだけにし、別セッションへの移動は1回ずつ順番に処理する。
// 処理中に押された分は件数表示だけ先に進め、最後に押された一致箇所へまとめて移動する。
// それでもiPhoneで連打すると落ちたため（2026-10-17、Mikoto報告）、続けて押している間は件数表示だけを進め、
// 指が止まってから1回だけ実際に移動する。長いページの大きなジャンプや描き直しを短時間に詰め込まないため。
const HIT_MOVE_SETTLE_MS = 300;
let hitMoveBusy = false;
let hitMovePending = false;
let hitMoveRerender = false;
let hitMoveTimer = null;
let hitMoveLastAt = 0;
function gotoHit(idx, opts = {}) {
  if (state.hits.length === 0) return;
  state.hitIndex = ((idx % state.hits.length) + state.hits.length) % state.hits.length;
  if (opts.rerender) hitMoveRerender = true;
  el.hitNavLabel.textContent = `${state.hitIndex + 1} / ${state.hits.length} 件`;

  const now = Date.now();
  const tappingFast = now - hitMoveLastAt < HIT_MOVE_SETTLE_MS;
  hitMoveLastAt = now;
  clearTimeout(hitMoveTimer);
  hitMoveTimer = null;
  if (tappingFast || hitMoveBusy) {
    hitMoveTimer = setTimeout(() => {
      hitMoveTimer = null;
      runHitMove();
    }, HIT_MOVE_SETTLE_MS);
    return;
  }
  runHitMove();
}

async function runHitMove() {
  if (hitMoveBusy) {
    hitMovePending = true;
    return;
  }
  hitMoveBusy = true;
  try {
    do {
      hitMovePending = false;
      const hit = state.hits[state.hitIndex];
      if (!hit) break;
      const rerender = hitMoveRerender;
      hitMoveRerender = false;
      if (!rerender && state.view === "session" && state.currentSessionId === hit.sessionId) {
        updateHitNav();
        scrollToMsg(hit.msgIndex);
      } else {
        await openSession(hit.sessionId, { focusMsgIndex: hit.msgIndex });
      }
    } while (hitMovePending);
  } finally {
    hitMoveBusy = false;
  }
}

function scrollToMsg(msgIndex) {
  const target = el.sessionMessageList.querySelector(`.msg-line[data-idx="${msgIndex}"]`);
  if (target) target.scrollIntoView({ block: "center" });
}
el.btnHitPrev.addEventListener("click", () => gotoHit(state.hitIndex - 1));
el.btnHitNext.addEventListener("click", () => gotoHit(state.hitIndex + 1));
el.btnHitClose.addEventListener("click", () => {
  clearFilterState();
  const session = state.sessions.find((s) => s.id === state.currentSessionId);
  if (session) renderSessionMessageList(session);
  updateHitNav();
  renderCharacterChecklist();
});

/* ============================================================
 * セッション一覧（5.3章）
 * ========================================================== */

function renderSessionList() {
  const hasFilter = state.filter.keyword.trim() !== "" || state.filter.characters.size > 0;
  const hitCountBySession = new Map();
  state.hits.forEach((h) => hitCountBySession.set(h.sessionId, (hitCountBySession.get(h.sessionId) || 0) + 1));
  const visibleSessions = hasFilter ? state.sessions.filter((s) => hitCountBySession.has(s.id)) : state.sessions;

  el.sessionList.classList.toggle("is-reorder-mode", state.reorderMode);
  el.sessionList.innerHTML = "";

  if (state.sessions.length === 0) {
    el.listEmptyNote.textContent = "まだログが読み込まれていません。メニューの「ファイルを選ぶ」から読み込んでください。";
    el.listEmptyNote.hidden = false;
  } else if (hasFilter && visibleSessions.length === 0) {
    el.listEmptyNote.textContent = "絞り込みに一致するセッションがありません。";
    el.listEmptyNote.hidden = false;
  } else {
    el.listEmptyNote.hidden = true;
  }

  visibleSessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "session-row";
    row.dataset.sessionId = session.id;

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "session-row__handle";
    handle.textContent = "≡";
    handle.setAttribute("aria-label", "ドラッグして並べ替え");
    handle.addEventListener("pointerdown", (e) => onHandlePointerDown(e, session.id));
    row.appendChild(handle);

    const body = document.createElement("div");
    body.className = "session-row__body";
    const title = document.createElement("div");
    title.className = "session-row__title";
    title.textContent = session.title || "（無題のセッション）";
    const meta = document.createElement("div");
    meta.className = "session-row__meta";
    meta.textContent = `${session.date || "日付不明"}・${session.messages.length}件の発言`;
    body.appendChild(title);
    body.appendChild(meta);
    row.appendChild(body);

    if (hasFilter && hitCountBySession.has(session.id)) {
      const badge = document.createElement("span");
      badge.className = "session-row__hit-badge";
      badge.textContent = `${hitCountBySession.get(session.id)}件`;
      row.appendChild(badge);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "session-row__delete";
    delBtn.textContent = "削除";
    delBtn.setAttribute("aria-label", "このセッションを削除");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleDeleteSession(session.id);
    });
    row.appendChild(delBtn);

    row.addEventListener("click", () => {
      if (state.reorderMode) return;
      const firstHit = hasFilter ? state.hits.find((h) => h.sessionId === session.id) : null;
      openSession(session.id, { focusMsgIndex: firstHit ? firstHit.msgIndex : null });
    });

    el.sessionList.appendChild(row);
  });
}

async function handleDeleteSession(id) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;
  const ok = confirm(`「${session.title || "（無題のセッション）"}」をインデックスから削除します。よろしいですか？`);
  if (!ok) return;

  state.sessions = state.sessions.filter((s) => s.id !== id);
  state.sessions.forEach((s, i) => {
    s.order = i;
  });
  try {
    await dbDeleteSession(id);
    await dbPutAllSessions(state.sessions);
  } catch (e) {
    // 表示上は削除済みとして扱う
  }
  await dbDeleteScrollPos(id);
  await touchCurrentSection();

  if (state.currentSessionId === id) {
    await backToList();
  } else {
    renderSessionList();
  }
  renderCharacterChecklist();
  showSimpleToast("削除しました。");
}

/* ============================================================
 * 並べ替えモード（ポインタ操作によるドラッグ&ドロップ、5.5章）
 * ========================================================== */

let dragState = null;

// ハンドルをつかんだまま画面の上端・下端に近づけたら、その方向へ自動でスクロールする（2026-10-17、Mikoto要望）。
// 指を止めていても pointermove は来ないため、約60回/秒のタイマーで最後の指の位置を見る。
const AUTO_SCROLL_EDGE = 80; // 画面端からこの距離（px）に入ったらスクロールを始める
const AUTO_SCROLL_MAX_SPEED = 18; // 1回（約16ms）あたりの最大スクロール量（px）。端に近いほど速くする

function onHandlePointerDown(e, sessionId) {
  if (!state.reorderMode) return;
  e.preventDefault();
  const row = e.currentTarget.closest(".session-row");
  if (!row) return;
  dragState = { row, sessionId, lastY: e.clientY, timerId: null };
  row.classList.add("is-dragging");
  document.addEventListener("pointermove", onDragPointerMove);
  document.addEventListener("pointerup", onDragPointerUp);
  document.addEventListener("pointercancel", onDragPointerUp);
  dragState.timerId = setInterval(autoScrollStep, 16);
}

// 指の位置（clientY）に合わせて、つかんでいる行を並びの中へ差し込む
function placeDraggedRow(clientY) {
  const { row } = dragState;
  const siblings = Array.from(el.sessionList.querySelectorAll(".session-row")).filter((r) => r !== row);
  let inserted = false;
  for (const sib of siblings) {
    const rect = sib.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      if (row.nextSibling !== sib) el.sessionList.insertBefore(row, sib);
      inserted = true;
      break;
    }
  }
  if (!inserted && siblings.length > 0) {
    const last = siblings[siblings.length - 1];
    if (last.nextSibling !== row) el.sessionList.insertBefore(row, last.nextSibling);
  }
}

function onDragPointerMove(e) {
  if (!dragState) return;
  e.preventDefault();
  dragState.lastY = e.clientY;
  placeDraggedRow(e.clientY);
}

function autoScrollStep() {
  if (!dragState) return;
  const y = dragState.lastY;
  // 画面最下部の「並び替えモードを終了する」バーに隠れる部分は除き、バーの上端を下端とみなす
  const bottom = el.reorderBar.hidden ? window.innerHeight : el.reorderBar.getBoundingClientRect().top;
  let dy = 0;
  if (y < AUTO_SCROLL_EDGE) {
    dy = -Math.ceil(((AUTO_SCROLL_EDGE - y) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED);
  } else if (y > bottom - AUTO_SCROLL_EDGE) {
    dy = Math.ceil(Math.min(1, (y - (bottom - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED);
  }
  if (dy !== 0) {
    const before = window.scrollY;
    window.scrollBy(0, dy);
    // スクロールで行の位置がずれるので、同じ指の位置で差し込み先を計算し直す
    if (window.scrollY !== before) placeDraggedRow(y);
  }
}

async function onDragPointerUp() {
  if (!dragState) return;
  const { row, timerId } = dragState;
  if (timerId) clearInterval(timerId);
  row.classList.remove("is-dragging");
  document.removeEventListener("pointermove", onDragPointerMove);
  document.removeEventListener("pointerup", onDragPointerUp);
  document.removeEventListener("pointercancel", onDragPointerUp);
  dragState = null;

  const orderedIds = Array.from(el.sessionList.querySelectorAll(".session-row")).map((r) => r.dataset.sessionId);
  orderedIds.forEach((id, idx) => {
    const s = state.sessions.find((x) => x.id === id);
    if (s) s.order = idx;
  });
  state.sessions.sort((a, b) => a.order - b.order);
  try {
    await dbPutAllSessions(state.sessions);
  } catch (e) {
    // 並び順の保存に失敗しても表示上の並びはそのまま維持する
  }
  await touchCurrentSection();
}

// 並び替えモードの開始・終了。モード中はサイドメニューの「並べ替え」欄を隠し、
// 画面最下部の「並び替えモードを終了する」バーで終了する（2026-10-17、Mikoto要望）。
function setReorderMode(on) {
  state.reorderMode = on;
  if (on) {
    clearFilterState();
    renderCharacterChecklist();
  }
  el.sidebarReorderSection.hidden = on;
  el.reorderBar.hidden = !on;
  el.reorderNote.hidden = !on;
  document.body.classList.toggle("is-reorder-mode", on);
}

el.btnToggleReorder.addEventListener("click", async () => {
  setReorderMode(true);
  await backToList();
  closeSidebar();
});

el.btnReorderDone.addEventListener("click", () => {
  setReorderMode(false);
  renderSessionList();
});

/* ============================================================
 * 個別セッション閲覧画面（5.3章）
 * ========================================================== */

function renderMessageTextWithHighlight(container, text, keyword) {
  if (!keyword) {
    container.textContent = text;
    return;
  }
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  let cursor = 0;
  let idx;
  const frag = document.createDocumentFragment();
  while ((idx = lower.indexOf(kw, cursor)) !== -1) {
    if (idx > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, idx)));
    const mark = document.createElement("mark");
    mark.className = "search-mark";
    mark.textContent = text.slice(idx, idx + keyword.length);
    frag.appendChild(mark);
    cursor = idx + keyword.length;
  }
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  container.appendChild(frag);
}

// 1発言の表示を、CClogのプレビュー用HTMLにならって3種類に分ける（2026-10-16、Mikoto要望）。
// ・KP・PLの発言、およびダイスロールの発言（発言者を問わない）: 地の文（「名前：本文」の1行、KP・PLは左に色帯）
// ・それ以外の発言者: キャラクター発言（色付きの名前の下に吹き出し）
// ・発言者なし（システムメッセージ等）・infoタブ: 従来どおり
// 統合したキャラクターは代表の名前・色で表示する（2026-10-16、Mikoto確認）。
function renderSessionMessageList(session) {
  const kw = state.filter.keyword.trim();
  const chars = state.filter.characters;

  // 1行ずつ画面に足すと長いログで重くなるため、まとめて組み立ててから1回で差し替える
  const frag = document.createDocumentFragment();
  session.messages.forEach((m, idx) => {
    const line = document.createElement("div");
    line.className = "msg-line";
    if (m.category === "info") line.classList.add("msg-line--info");
    if (m.category === "other") line.classList.add("msg-line--other");
    line.dataset.idx = String(idx);

    const speakerName = m.speaker ? canonicalName(m.speaker) : "";
    const isCharHit = chars.size > 0 && chars.has(speakerName);
    const isKwHit = !!kw && m.text.toLowerCase().includes(kw.toLowerCase());
    if (isCharHit || isKwHit) line.classList.add("is-hit");

    const textSpan = document.createElement("span");
    textSpan.className = "msg-line__text";
    renderMessageTextWithHighlight(textSpan, m.text, isKwHit ? kw : "");

    // システムメッセージ（発言者なし・旧形式の発言者「system」）は、枠で囲んだ灰色の地の文にする（2026-10-16、Mikoto要望）
    if (isSystemMessage(m)) {
      line.classList.add("msg-line--system");
      line.appendChild(textSpan);
      frag.appendChild(line);
      return;
    }

    if (m.category === "info") {
      if (m.speaker) line.appendChild(buildSpeakerSpan(speakerName, m));
      line.appendChild(textSpan);
      frag.appendChild(line);
      return;
    }

    const role = getSpeakerRole(speakerName);
    if (role === "character" && !isDiceRollText(m.text)) {
      line.classList.add("msg-line--character");
      const name = document.createElement("div");
      name.className = "msg-line__bubble-name";
      name.textContent = speakerName;
      name.style.color = speakerColor(speakerName, m);
      const bubble = document.createElement("div");
      bubble.className = "msg-line__bubble";
      bubble.appendChild(textSpan);
      line.appendChild(name);
      line.appendChild(bubble);
    } else {
      line.classList.add("msg-line--narration");
      if (role === "kp") line.classList.add("msg-line--kp");
      if (role === "pl") line.classList.add("msg-line--pl");
      line.appendChild(buildSpeakerSpan(speakerName, m));
      line.appendChild(textSpan);
    }
    frag.appendChild(line);
  });
  el.sessionMessageList.replaceChildren(frag);
}

function isSystemMessage(m) {
  // infoタブの発言者なしの行（CClogプレビューの情報欄）は従来どおりinfoの見た目にする
  if (m.category === "info") return false;
  return !m.speaker || m.speaker.trim().toLowerCase() === "system";
}

function speakerColor(speakerName, m) {
  const charEntry = state.charIndex.get(speakerName);
  return charEntry ? charEntry.color : m.color;
}

// 「名前：」部分。KP・PLの色はCSS側（役割の色）で付けるため、それ以外の発言者だけ本人の色を付ける
function buildSpeakerSpan(speakerName, m) {
  const sp = document.createElement("span");
  sp.className = "msg-line__speaker";
  sp.textContent = speakerName + "：";
  const role = getSpeakerRole(speakerName);
  if (role !== "kp" && role !== "pl") sp.style.color = speakerColor(speakerName, m);
  return sp;
}

function updateHitNav() {
  if (state.hits.length === 0) {
    el.hitNav.hidden = true;
    return;
  }
  el.hitNav.hidden = false;
  el.hitNavLabel.textContent = `${state.hitIndex + 1} / ${state.hits.length} 件`;

  el.sessionMessageList.querySelectorAll(".msg-line.is-hit-current").forEach((n) => n.classList.remove("is-hit-current"));
  const hit = state.hits[state.hitIndex];
  if (hit && hit.sessionId === state.currentSessionId) {
    const line = el.sessionMessageList.querySelector(`.msg-line[data-idx="${hit.msgIndex}"]`);
    if (line) line.classList.add("is-hit-current");
  }
}

async function openSession(id, opts = {}) {
  const session = state.sessions.find((s) => s.id === id);
  if (!session) return;

  if (state.currentSessionId && state.currentSessionId !== id && state.view === "session") {
    flushScrollSave();
    await saveScrollPos(state.currentSessionId, window.scrollY);
  }

  state.currentSessionId = id;
  state.view = "session";
  updateGotoListButton();
  el.viewList.hidden = true;
  el.viewSession.hidden = false;

  const idx = state.sessions.findIndex((s) => s.id === id);
  el.sessionViewTitle.textContent = session.title || "（無題のセッション）";
  el.sessionViewMeta.textContent = `${session.date || "日付不明"}・${idx + 1} / ${state.sessions.length}`;
  el.btnPrevSession.disabled = idx <= 0;
  el.btnNextSession.disabled = idx < 0 || idx >= state.sessions.length - 1;
  el.btnPrevSessionBottom.disabled = el.btnPrevSession.disabled;
  el.btnNextSessionBottom.disabled = el.btnNextSession.disabled;

  renderSessionMessageList(session);
  updateHitNav();
  closeSidebar();

  if (typeof opts.focusMsgIndex === "number") {
    // スクロールが終わるまで待ってから戻る（gotoHitが次の移動を始めたあとに古い位置へ戻されないように）
    await new Promise((resolve) =>
      afterLayout(() => {
        scrollToMsg(opts.focusMsgIndex);
        resolve();
      })
    );
  } else {
    const savedY = await loadScrollPos(id);
    afterLayout(() => window.scrollTo(0, savedY || 0));
  }
}

function gotoPrevSession() {
  const idx = state.sessions.findIndex((s) => s.id === state.currentSessionId);
  if (idx > 0) openSession(state.sessions[idx - 1].id, {});
}
function gotoNextSession() {
  const idx = state.sessions.findIndex((s) => s.id === state.currentSessionId);
  if (idx >= 0 && idx < state.sessions.length - 1) openSession(state.sessions[idx + 1].id, {});
}
// 長いログを読み終えたときにページ先頭へ戻らなくて済むよう、最下部にも同じボタンを置く
el.btnPrevSession.addEventListener("click", gotoPrevSession);
el.btnNextSession.addEventListener("click", gotoNextSession);
el.btnPrevSessionBottom.addEventListener("click", gotoPrevSession);
el.btnNextSessionBottom.addEventListener("click", gotoNextSession);

async function backToList() {
  if (state.currentSessionId && state.view === "session") {
    flushScrollSave();
    await saveScrollPos(state.currentSessionId, window.scrollY);
  }
  state.view = "list";
  updateGotoListButton();
  state.currentSessionId = null;
  el.viewSession.hidden = true;
  el.viewList.hidden = false;
  renderSessionList();
  window.scrollTo(0, 0);
}

/* 個別セッション閲覧中のスクロール位置を記憶する（5.3章） */
let scrollSaveTimer = null;
function flushScrollSave() {
  if (scrollSaveTimer) {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
  }
}
window.addEventListener(
  "scroll",
  () => {
    if (state.view !== "session" || !state.currentSessionId) return;
    const sid = state.currentSessionId;
    flushScrollSave();
    scrollSaveTimer = setTimeout(() => {
      saveScrollPos(sid, window.scrollY);
    }, 400);
  },
  { passive: true }
);

/* ============================================================
 * 差し替え識別モーダル（5.1・5.2・5.6章で共用）
 * ========================================================== */

let pendingAssign = null; // { items, onConfirm }

function openAssignModal(items, onConfirm) {
  pendingAssign = { items, onConfirm };
  el.assignList.innerHTML = "";

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "assign-row";

    const name = document.createElement("div");
    name.className = "assign-row__name";
    name.textContent = item.label;
    row.appendChild(name);

    const select = document.createElement("select");
    select.dataset.tempId = item.tempId;

    const optNew = document.createElement("option");
    optNew.value = "__new__";
    optNew.textContent = "新規として追加";
    select.appendChild(optNew);

    state.sessions.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `差し替え: ${s.title || "（無題）"}${s.date ? ` (${s.date})` : ""}`;
      select.appendChild(opt);
    });

    select.value = "__new__";
    row.appendChild(select);
    el.assignList.appendChild(row);
  });

  el.assignDesc.textContent =
    state.sessions.length === 0
      ? "既存のログがまだないため、すべて新規として追加されます。"
      : "それぞれ「新規として追加」か、更新版として置き換える既存セッションを選んでください。";
  el.assignOverlay.hidden = false;
}

function closeAssignModal() {
  el.assignOverlay.hidden = true;
  pendingAssign = null;
}

el.btnAssignCancel.addEventListener("click", closeAssignModal);
el.assignOverlayBackdrop.addEventListener("click", closeAssignModal);

el.btnAssignConfirm.addEventListener("click", async () => {
  if (!pendingAssign) return;
  const selects = Array.from(el.assignList.querySelectorAll("select"));
  const decisions = selects.map((sel) => ({ tempId: sel.dataset.tempId, target: sel.value }));
  const { items, onConfirm } = pendingAssign;
  closeAssignModal();
  await onConfirm(items, decisions);
});

async function applyImportDecisions(items, decisions) {
  const newDrafts = [];
  decisions.forEach((dec) => {
    const item = items.find((i) => i.tempId === dec.tempId);
    if (!item) return;
    if (dec.target === "__new__") {
      newDrafts.push({ ...item.draft });
    } else {
      const existing = state.sessions.find((s) => s.id === dec.target);
      // item.draft は id・order を持たないため、既存セッションのid・orderは変わらない
      if (existing) Object.assign(existing, item.draft);
    }
  });

  if (newDrafts.length > 0) {
    const withIds = newDrafts.map((d) => ({ ...d, id: uid(), sectionId: state.currentSectionId }));
    state.sessions = insertNewSessionsIntoOrder(state.sessions, withIds);
  }

  await saveAfterImport();
}

/* ============================================================
 * ログの読み込み・追加（5.1・5.2章）
 * ========================================================== */

el.fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length > 0) importLogFiles(files, { fromFolder: false });
});

el.folderInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = "";
  if (files.length > 0) importLogFiles(files, { fromFolder: true });
});

// ファイル名の比較用。Googleドライブ・OS間でUnicode正規化（NFC/NFD）が揺れるため揃える。
function fileNameKey(name) {
  return toText(name).normalize("NFC");
}

function sameMessages(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ログHTMLの取り込み（5.1・5.2章）。
// 既存セッションと同じファイル名のものは、中身が変わっていれば自動で差し替え、
// 変わっていなければ何もしない（2026-10-16、Mikoto確認）。
// 同名がないものは、フォルダ読み込みなら新規として自動追加し、ファイル選択なら
// 従来どおり差し替え識別モーダルで「新規／差し替え先」を選ぶ（ファイル名が変わった更新版用）。
async function importLogFiles(allFiles, { fromFolder }) {
  const files = allFiles.filter((f) => /\.html?$/i.test(f.name) && !f.name.startsWith("."));
  if (files.length === 0) {
    el.loadStatus.textContent = "HTMLファイルが見つかりませんでした。";
    return;
  }

  const existingByName = new Map(state.sessions.map((s) => [fileNameKey(s.fileName), s]));
  const seenNames = new Set();
  const newItems = [];
  const failedNames = [];
  let replaced = 0;
  let unchanged = 0;
  let duplicated = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    el.loadStatus.textContent = `読み込み中...（${i + 1}/${files.length}）`;
    // 件数が多いときも進捗表示が更新されるよう、描画の機会を作る
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));

    const key = fileNameKey(file.name);
    if (seenNames.has(key)) {
      // サブフォルダに同名ファイルがある場合などは、最初の1件だけを使う
      duplicated++;
      continue;
    }
    seenNames.add(key);

    let parsed = null;
    try {
      parsed = parseLogHtml(await file.text());
    } catch (err) {
      parsed = null;
    }
    if (!parsed || parsed.messages.length === 0) {
      failedNames.push(file.name);
      continue;
    }

    const extracted = extractTitleAndDate(file.name);
    const date = extracted.date || parsed.logDate || null;
    const draft = {
      title: extracted.title,
      date,
      dateAuto: !!date,
      format: parsed.format,
      fileName: file.name,
      addedAt: new Date().toISOString(),
      messages: normalizeMessages(parsed.messages),
    };

    const existing = existingByName.get(key);
    if (existing) {
      if (sameMessages(existing.messages, draft.messages)) {
        unchanged++;
      } else {
        // draft は id・order を持たないため、既存セッションのid・order（並び順）は変わらない
        Object.assign(existing, draft);
        replaced++;
      }
      continue;
    }

    newItems.push({
      tempId: uid(),
      label: `${draft.title}${date ? `（${date}）` : ""} / ${file.name}`,
      draft,
    });
  }

  const parts = [];
  if (fromFolder || newItems.length === 0) {
    if (newItems.length) parts.push(`新規追加 ${newItems.length}件`);
  } else {
    parts.push(`新しいファイル ${newItems.length}件`);
  }
  if (replaced) parts.push(`最新版に差し替え ${replaced}件`);
  if (unchanged) parts.push(`変更なし ${unchanged}件`);
  if (duplicated) parts.push(`同名ファイルのため無視 ${duplicated}件`);
  let status = parts.length ? parts.join("・") + "。" : "";
  if (failedNames.length) {
    status += `${failedNames.length}件はログとして認識できませんでした（${failedNames.join("、")}）。`;
  }
  if (!status) status = "取り込めるログがありませんでした。";
  el.loadStatus.textContent = status;

  if (!fromFolder && newItems.length > 0) {
    // 自動差し替え分を先に保存してから、残りを差し替え識別モーダルに回す
    if (replaced) await saveAfterImport();
    openAssignModal(newItems, applyImportDecisions);
    return;
  }

  if (newItems.length > 0) {
    const withIds = newItems.map((item) => ({ ...item.draft, id: uid(), sectionId: state.currentSectionId }));
    state.sessions = insertNewSessionsIntoOrder(state.sessions, withIds);
  }
  if (newItems.length > 0 || replaced > 0) await saveAfterImport();
}

async function saveAfterImport() {
  try {
    await dbPutAllSessions(state.sessions);
  } catch (e) {
    showSimpleToast("保存中にエラーが発生しました。");
  }
  await touchCurrentSection();
  renderSessionList();
  renderCharacterChecklist();
  showBackupPromptToast();
}

/* ============================================================
 * バックアップの書き出し・復元・統合（5.6章）
 * ========================================================== */

function exportBackup() {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    // 全セクションをまとめて書き出す（2026-10-16、Mikoto確認）
    sessions: allSessions(),
    sections: state.sections,
    currentSectionId: state.currentSectionId,
    characterAliases: state.aliases,
    speakerRoles: state.speakerRoles,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ログ検索インデックス_backup_${formatTimestampForFilename(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  hideBackupPromptToast();
  showSimpleToast("バックアップを書き出しました。");
}

el.btnBackupExport.addEventListener("click", exportBackup);
el.btnBackupPromptDismiss.addEventListener("click", hideBackupPromptToast);
el.btnBackupPromptExport.addEventListener("click", exportBackup);

function normalizeBackupSessions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s === "object" && Array.isArray(s.messages))
    .map((s) => ({
      id: typeof s.id === "string" && s.id ? s.id : uid(),
      sectionId: typeof s.sectionId === "string" ? s.sectionId : "",
      title: toText(s.title),
      date: typeof s.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : null,
      dateAuto: !!s.dateAuto,
      order: typeof s.order === "number" ? s.order : 0,
      format: s.format === "preview" ? "preview" : "cocofolia",
      fileName: toText(s.fileName),
      addedAt: typeof s.addedAt === "string" ? s.addedAt : new Date().toISOString(),
      messages: normalizeMessages(s.messages),
    }));
}

// 外部ファイル由来の統合設定を検査する。文字列どうしの対応だけを残し、
// 「A→B→C」のような連鎖は最終的な代表の名前に付け替え、循環するものは捨てる。
function normalizeAliases(obj) {
  const src = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    Object.keys(obj).forEach((k) => {
      if (typeof obj[k] === "string" && k && obj[k] && k !== obj[k]) src[k] = obj[k];
    });
  }
  const out = {};
  Object.keys(src).forEach((k) => {
    let rep = src[k];
    const seen = new Set([k]);
    while (Object.prototype.hasOwnProperty.call(src, rep) && !seen.has(rep)) {
      seen.add(rep);
      rep = src[rep];
    }
    if (rep !== k && !Object.prototype.hasOwnProperty.call(src, rep)) out[k] = rep;
  });
  return out;
}

let pendingBackupData = null;
let pendingBackupAliases = {};
let pendingBackupRoles = {};
let pendingBackupSections = [];
let pendingBackupCurrentSection = null;

el.backupFileInput.addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.sessions)) throw new Error("invalid backup shape");
    pendingBackupData = normalizeBackupSessions(data.sessions);
    pendingBackupAliases = normalizeAliases(data.characterAliases);
    pendingBackupRoles = normalizeSpeakerRoles(data.speakerRoles);
    pendingBackupSections = normalizeSections(data.sections);
    pendingBackupCurrentSection = typeof data.currentSectionId === "string" ? data.currentSectionId : null;
    const sectionNote = pendingBackupSections.length > 1 ? `（${pendingBackupSections.length}セクション）` : "";
    el.backupModeDesc.textContent =
      `${pendingBackupData.length}件のセッション${sectionNote}を含むバックアップです。読み込み方法を選んでください。` +
      `復元はセクションの構成ごと置き換え、統合は表示中のセクション「${currentSectionName()}」に取り込みます。`;
    el.backupModeOverlay.hidden = false;
  } catch (err) {
    showSimpleToast("バックアップファイルを読み込めませんでした。ファイルの形式をご確認ください。");
  }
});

el.btnBackupModeCancel.addEventListener("click", () => {
  pendingBackupData = null;
  el.backupModeOverlay.hidden = true;
});
el.backupModeOverlayBackdrop.addEventListener("click", () => {
  pendingBackupData = null;
  el.backupModeOverlay.hidden = true;
});

el.btnBackupRestore.addEventListener("click", async () => {
  if (!pendingBackupData) return;
  const ok = confirm("今のインデックスの内容をすべて置き換えます。元に戻せません。よろしいですか？");
  if (!ok) return;

  el.backupModeOverlay.hidden = true;
  const restored = pendingBackupData.slice().sort((a, b) => a.order - b.order);
  restored.forEach((s, i) => {
    s.order = i;
  });
  // セクションの構成もバックアップの内容に置き換える（セクションを持たない古いバックアップは1つのセクションにまとめる）
  const fixed = ensureSections(restored, pendingBackupSections, pendingBackupCurrentSection);

  try {
    await dbClearSessions();
    await dbPutAllSessions(restored);
  } catch (e) {
    showSimpleToast("復元中にエラーが発生しました。");
  }

  state.sections = fixed.sections;
  state.currentSectionId = fixed.currentSectionId;
  state.sections.forEach((sec) => {
    sec.lastSessionId = null;
  });
  splitSessionsBySection(restored);
  await saveSections();
  renderSectionUi();
  pendingBackupData = null;
  pendingBackupSections = [];
  pendingBackupCurrentSection = null;
  // 復元（全置換）では、キャラクター統合設定・KP・PLの設定もバックアップの内容に置き換える
  state.aliases = pendingBackupAliases;
  state.speakerRoles = pendingBackupRoles;
  pendingBackupAliases = {};
  pendingBackupRoles = {};
  await saveAliases();
  await saveSpeakerRoles();
  clearFilterState();
  await backToList();
  renderCharacterChecklist();
  showSimpleToast("バックアップから復元しました。");
});

el.btnBackupMerge.addEventListener("click", () => {
  if (!pendingBackupData) return;
  el.backupModeOverlay.hidden = true;

  const items = pendingBackupData.map((s) => ({
    tempId: uid(),
    label: `${s.title || "（無題）"}${s.date ? `（${s.date}）` : ""} / ${s.fileName || "(ファイル名不明)"}`,
    draft: {
      title: s.title,
      date: s.date,
      dateAuto: s.dateAuto,
      format: s.format,
      fileName: s.fileName,
      addedAt: s.addedAt,
      messages: s.messages,
    },
  }));
  const backupAliases = pendingBackupAliases;
  const backupRoles = pendingBackupRoles;
  pendingBackupAliases = {};
  pendingBackupRoles = {};
  pendingBackupData = null;
  openAssignModal(items, async (confirmedItems, decisions) => {
    // 統合（マージ）では、キャラクター統合設定・KP・PLの設定も足し合わせる（同じ名前の設定が食い違うときは今の設定を優先）。
    // 取り込みを確定したときだけ反映し、キャンセルしたときは今の設定のままにする。
    state.aliases = normalizeAliases({ ...backupAliases, ...state.aliases });
    state.speakerRoles = { ...backupRoles, ...state.speakerRoles };
    await saveAliases();
    await saveSpeakerRoles();
    await applyImportDecisions(confirmedItems, decisions);
  });
});

/* ============================================================
 * 初期化
 * ========================================================== */

/* ============================================================
 * セクション（2026-10-16、Mikoto要望）
 * セッション一覧を丸ごと分ける「別々の本棚」。一覧・検索・絞り込み・前後移動は
 * 表示中のセクションの中だけで行う。キャラクター統合・KP・PL設定は全セクション共通。
 * サイドメニューの「セクション履歴」に最終編集が新しい順で並べ、すぐに切り替えられるようにする。
 * ========================================================== */

function allSessions() {
  return state.otherSessions.concat(state.sessions);
}

// 全セッションを、表示中のセクションの分（state.sessions）とそれ以外に分ける
function splitSessionsBySection(list) {
  const sorted = list.slice().sort((a, b) => a.order - b.order);
  state.sessions = sorted.filter((s) => s.sectionId === state.currentSectionId);
  state.otherSessions = sorted.filter((s) => s.sectionId !== state.currentSectionId);
}

function normalizeSections(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list
    .filter((s) => s && typeof s === "object" && typeof s.id === "string" && s.id && !seen.has(s.id) && seen.add(s.id))
    .map((s) => ({
      id: s.id,
      name: toText(s.name).trim() || "（無題のセクション）",
      createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date().toISOString(),
      updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date().toISOString(),
      lastSessionId: typeof s.lastSessionId === "string" ? s.lastSessionId : null,
    }));
}

function newSectionRecord(name) {
  const now = new Date().toISOString();
  return { id: uid(), name, createdAt: now, updatedAt: now, lastSessionId: null };
}

// セクションが1つもない・どのセクションにも属さないセッションがある、といった状態を直す。
// 戻り値の changedSessions は sectionId を付け直したセッション（保存が必要なもの）。
function ensureSections(sessions, sections, currentId) {
  const list = sections.slice();
  if (list.length === 0) list.push(newSectionRecord("セクション1"));
  const ids = new Set(list.map((s) => s.id));
  const fallbackId = list[0].id;
  const changedSessions = [];
  sessions.forEach((s) => {
    if (!ids.has(s.sectionId)) {
      s.sectionId = fallbackId;
      changedSessions.push(s);
    }
  });
  const current = ids.has(currentId) ? currentId : sectionsByRecent(list)[0].id;
  return { sections: list, currentSectionId: current, changedSessions };
}

function sectionsByRecent(list = state.sections) {
  return list.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function currentSection() {
  return state.sections.find((s) => s.id === state.currentSectionId) || null;
}
function currentSectionName() {
  const sec = currentSection();
  return sec ? sec.name : "";
}

async function saveSections() {
  try {
    await dbPutSetting(SETTING_SECTIONS, state.sections);
    await dbPutSetting(SETTING_CURRENT_SECTION, state.currentSectionId);
  } catch (e) {
    // セクション情報の保存に失敗しても表示は続ける
  }
}

// ログの追加・差し替え・削除・並べ替えをしたときに、表示中のセクションの最終編集日時を更新する
async function touchCurrentSection() {
  const sec = currentSection();
  if (!sec) return;
  sec.updatedAt = new Date().toISOString();
  await saveSections();
  renderSectionUi();
}

function formatSectionTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderSectionUi() {
  const name = currentSectionName();
  el.currentSectionName.textContent = name;
  el.listSectionLabel.textContent = `セクション：${name}`;

  const counts = new Map();
  allSessions().forEach((s) => counts.set(s.sectionId, (counts.get(s.sectionId) || 0) + 1));

  el.sectionHistory.innerHTML = "";
  sectionsByRecent().forEach((sec) => {
    const isCurrent = sec.id === state.currentSectionId;
    const row = document.createElement("div");
    row.className = "section-row" + (isCurrent ? " is-current" : "");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "section-row__main";
    const title = document.createElement("span");
    title.className = "section-row__name";
    title.textContent = sec.name + (isCurrent ? "（表示中）" : "");
    const meta = document.createElement("span");
    meta.className = "section-row__meta";
    meta.textContent = `${counts.get(sec.id) || 0}件・最終編集 ${formatSectionTime(sec.updatedAt)}`;
    main.appendChild(title);
    main.appendChild(meta);
    main.addEventListener("click", () => switchSection(sec.id));
    row.appendChild(main);

    const actions = document.createElement("div");
    actions.className = "section-row__actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "section-row__action";
    rename.textContent = "名前を変更";
    rename.addEventListener("click", () => renameSection(sec.id));
    actions.appendChild(rename);
    if (state.sections.length > 1) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "section-row__action section-row__action--danger";
      del.textContent = "削除";
      del.addEventListener("click", () => deleteSection(sec.id));
      actions.appendChild(del);
    }
    row.appendChild(actions);
    el.sectionHistory.appendChild(row);
  });
}

// 表示中のセクションで閲覧していたセッションを覚えておき、戻ってきたときに同じ位置から再開する
async function leaveCurrentSection() {
  const sec = currentSection();
  if (state.view === "session" && state.currentSessionId) {
    flushScrollSave();
    await saveScrollPos(state.currentSessionId, window.scrollY);
    if (sec) sec.lastSessionId = state.currentSessionId;
  } else if (sec) {
    sec.lastSessionId = null;
  }
  state.view = "list";
  state.currentSessionId = null;
}

async function switchSection(id, { toList = false } = {}) {
  if (id === state.currentSectionId && !toList) {
    closeSidebar();
    return;
  }
  if (!state.sections.some((s) => s.id === id)) return;
  await leaveCurrentSection();

  const all = allSessions();
  state.currentSectionId = id;
  splitSessionsBySection(all);
  await saveSections();

  if (state.reorderMode) setReorderMode(false);
  clearFilterState();
  renderCharacterChecklist();
  renderSectionUi();

  const sec = currentSection();
  const resumeId = !toList && sec && sec.lastSessionId;
  if (resumeId && state.sessions.some((s) => s.id === resumeId)) {
    await openSession(resumeId, {});
  } else {
    await backToList();
    closeSidebar();
  }
  showSimpleToast(`セクション「${currentSectionName()}」を表示しています。`);
}

el.btnNewSection.addEventListener("click", async () => {
  const defaultName = `セクション${state.sections.length + 1}`;
  const input = prompt("新しいセクションの名前を入力してください。", defaultName);
  if (input === null) return;
  const sec = newSectionRecord(input.trim() || defaultName);
  state.sections.push(sec);
  await switchSection(sec.id, { toList: true });
});

async function renameSection(id) {
  const sec = state.sections.find((s) => s.id === id);
  if (!sec) return;
  const input = prompt("セクションの名前を変更します。", sec.name);
  if (input === null || !input.trim()) return;
  sec.name = input.trim();
  await saveSections();
  renderSectionUi();
}

async function deleteSection(id) {
  const sec = state.sections.find((s) => s.id === id);
  if (!sec || state.sections.length <= 1) return;
  const targets = allSessions().filter((s) => s.sectionId === id);
  const ok = confirm(
    `セクション「${sec.name}」と、その中の${targets.length}件のセッションをインデックスから削除します。元に戻せません。よろしいですか？`
  );
  if (!ok) return;

  if (id === state.currentSectionId) {
    const next = sectionsByRecent().find((s) => s.id !== id);
    await switchSection(next.id, { toList: true });
  }
  state.otherSessions = state.otherSessions.filter((s) => s.sectionId !== id);
  state.sections = state.sections.filter((s) => s.id !== id);
  try {
    for (const s of targets) {
      await dbDeleteSession(s.id);
      await dbDeleteScrollPos(s.id);
    }
  } catch (e) {
    // 表示上は削除済みとして扱う
  }
  await saveSections();
  renderSectionUi();
  showSimpleToast(`セクション「${sec.name}」を削除しました。`);
}

// iPhone/iPadのSafariでは「フォルダを選ぶ」が通常のファイル選択になることを実機で確認したため
// （2026-10-16、Mikoto確認）、iOS系ではボタンを出さず「ファイルを選ぶ」だけにする。
// iPadOSはMacと同じUAを名乗るので、タッチ点数でも判定する。
function isIOSLike() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

async function init() {
  if (isIOSLike()) el.folderPickerArea.hidden = true;
  updateGotoListButton();
  try {
    state.aliases = normalizeAliases(await dbGetSetting(SETTING_ALIASES));
    state.speakerRoles = normalizeSpeakerRoles(await dbGetSetting(SETTING_SPEAKER_ROLES));
  } catch (e) {
    state.aliases = {};
  }
  let all = [];
  let savedSections = [];
  let savedCurrent = null;
  try {
    all = (await dbGetAllSessions()).sort((a, b) => a.order - b.order);
    savedSections = normalizeSections(await dbGetSetting(SETTING_SECTIONS));
    savedCurrent = await dbGetSetting(SETTING_CURRENT_SECTION);
  } catch (e) {
    el.loadStatus.textContent = "保存済みインデックスの読み込みに失敗しました。";
  }
  // セクション機能より前のデータは、すべて「セクション1」に入れる
  const fixed = ensureSections(all, savedSections, savedCurrent);
  state.sections = fixed.sections;
  state.currentSectionId = fixed.currentSectionId;
  splitSessionsBySection(all);
  try {
    if (fixed.changedSessions.length > 0) await dbPutAllSessions(fixed.changedSessions);
    await saveSections();
  } catch (e) {
    // 保存に失敗しても表示は続ける
  }
  renderSectionUi();
  renderSessionList();
  renderCharacterChecklist();
  updateFilterSummary();
  updateFilterBadge();
}

init();
