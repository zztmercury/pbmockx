// pbmockx Web UI — live flow list, request/response inspector, rules & setup.
import { api } from './api.js';
import { applyStatic, getLang, initLang, mountLangToggle, normalizeLang, setLang, t } from './i18n.js';
import { el, fmtBytes, fmtDuration, renderPbTree, renderJsonTree } from './tree.js';
import { renderRulesPanel, renderSetupPanel } from './panels.js';

// Resolve the language before anything renders. Module scripts are deferred, so
// the DOM is parsed here; ?lang= / the toggle choice / navigator decide now and
// the daemon default from /health only fills in later.
initLang();

const $ = (sel) => document.querySelector(sel);
const COLLAPSED_CARDS_KEY = 'pbmockx-collapsed-cards-v1';

const state = {
  flows: [],
  selectedId: null,
  detail: null,
  detailOriginal: null,
  tab: 'summary',
  bodyMode: 'decoded',
  original: false,
  filter: '',
  paused: false,
  rulesCount: 0,
  info: null,
  ca: null,
  health: null,
  conn: null,
  drawer: null,
  bodyCache: new Map(),
  detailTimer: null,
  listMode: localStorage.getItem('pbmockx-list-mode') || 'flat',
  treeOpen: loadSet('pbmockx-tree-open-v2'),
  collapsedCards: loadSet(COLLAPSED_CARDS_KEY),
};

const els = {
  version: $('#version'),
  conn: $('#conn'),
  connText: $('#conn-text'),
  filter: $('#filter'),
  flowList: $('#flow-list'),
  flowCount: $('#flow-count'),
  emptyList: $('#empty-list'),
  emptyDetail: $('#empty-detail'),
  detailBody: $('#detail-body'),
  rulesCount: $('#rules-count'),
  proxyAddr: $('#proxy-addr'),
  drawer: $('#drawer'),
  drawerBackdrop: $('#drawer-backdrop'),
  drawerTabs: $('#drawer-tabs'),
  drawerBody: $('#drawer-body'),
  modal: $('#modal'),
  modalBackdrop: $('#modal-backdrop'),
  modalTitle: $('#modal-title'),
  modalBody: $('#modal-body'),
  modalFoot: $('#modal-foot'),
  toasts: $('#toasts'),
  splitter: $('#splitter'),
  listMode: $('#list-mode'),
  treeExpand: $('#tree-expand'),
  treeCollapse: $('#tree-collapse'),
};

// --- utilities ---

function toast(message, isError = false) {
  const t = el('div', 'toast' + (isError ? ' err' : ''), message);
  els.toasts.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'));
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(t('common.copied')); } catch { toast(t('common.copyFailed'), true); }
    ta.remove();
  }
}

function statusClass(code) {
  const n = Number(code) || 0;
  return n >= 500 ? 's5' : n >= 400 ? 's4' : n >= 300 ? 's3' : n >= 200 ? 's2' : '';
}

function protoTag(p) {
  if (!p) return null;
  return el('span', 'code ' + (p === 'protobuf' ? 'pb' : p === 'json' ? 'json' : ''), p === 'protobuf' ? 'PB' : p.toUpperCase());
}

function timeOf(ts) {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ''; }
}

function loadSet(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch { return new Set(); }
}

function saveSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-2000))); } catch {}
}

function splitFlowUrl(flow) {
  const raw = flow.url || '';
  try {
    const u = new URL(raw);
    return { host: u.host, pathname: u.pathname || '/', search: u.search || '', full: raw };
  } catch {
    return { host: '', pathname: raw, search: '', full: raw };
  }
}

function setConn(ok, key) {
  state.conn = { ok, key: key || (ok ? 'conn.live' : 'conn.offline') };
  els.conn.classList.toggle('ok', !!ok);
  els.conn.classList.toggle('err', ok === false);
  els.connText.textContent = t(state.conn.key);
}

/** The Pause label follows app state, so it is not a data-i18n node. */
function renderPauseLabel() {
  const btn = $('#btn-pause');
  if (btn) btn.textContent = state.paused ? t('nav.paused') : t('nav.pause');
}

// --- theme ---

function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pbmockx-theme', theme);
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const cur = localStorage.getItem('pbmockx-theme') || 'auto';
  applyTheme(order[(order.indexOf(cur) + 1) % order.length]);
}

// --- modals ---

function closeModal() {
  els.modal.classList.remove('open');
  els.modalBackdrop.classList.remove('open');
  els.modal.setAttribute('aria-hidden', 'true');
}

function openModal({ title, body, footer }) {
  els.modalTitle.textContent = title || '';
  els.modalBody.innerHTML = '';
  if (typeof body === 'string') els.modalBody.appendChild(el('div', '', body));
  else if (body) els.modalBody.appendChild(body);
  els.modalFoot.innerHTML = '';
  for (const btn of footer || []) {
    const b = el('button', 'btn' + (btn.primary ? ' primary' : '') + (btn.danger ? ' danger' : ''), btn.label);
    b.addEventListener('click', async () => {
      try { await btn.onClick?.(); } catch (e) { toast(e.message, true); }
    });
    els.modalFoot.appendChild(b);
  }
  els.modal.classList.add('open');
  els.modalBackdrop.classList.add('open');
  els.modal.setAttribute('aria-hidden', 'false');
}

// --- drawer ---

function closeDrawer() {
  state.drawer = null;
  els.drawer.classList.remove('open');
  els.drawerBackdrop.classList.remove('open');
  els.drawer.setAttribute('aria-hidden', 'true');
  updateHash();
}

async function openDrawer(tab) {
  state.drawer = tab || 'rules';
  els.drawer.classList.add('open');
  els.drawerBackdrop.classList.add('open');
  els.drawer.setAttribute('aria-hidden', 'false');
  updateHash();
  await renderDrawer();
}

async function renderDrawer() {
  els.drawerTabs.innerHTML = '';
  for (const [key, label] of [['rules', t('drawer.tabRules')], ['setup', t('drawer.tabSetup')]]) {
    const b = el('button', 'tab' + (state.drawer === key ? ' active' : ''), label);
    b.addEventListener('click', () => { state.drawer = key; renderDrawer(); updateHash(); });
    els.drawerTabs.appendChild(b);
  }
  els.drawerBody.innerHTML = '';
  if (state.drawer === 'rules') {
    await renderRulesPanel(els.drawerBody, drawerCtx());
  } else {
    await ensureInfo();
    await renderSetupPanel(els.drawerBody, drawerCtx());
  }
}

async function ensureInfo() {
  try { state.info = await api('/info'); } catch {}
  try { state.ca = await api('/ca/info'); } catch {}
}

function drawerCtx() {
  return {
    openModal,
    closeModal,
    toast,
    copy: copyText,
    info: state.info,
    ca: state.ca,
    refreshRules: () => {
      if (state.drawer === 'rules') renderDrawer();
      fetchHealth();
    },
    onRulesCount: (n) => { state.rulesCount = n; els.rulesCount.textContent = String(n); },
  };
}

// --- flow list (flat + tree) ---

function activeFilter() {
  const raw = state.filter.trim();
  if (!raw) return () => true;
  try {
    const re = new RegExp(raw, 'i');
    return (f) => re.test(f.url || '') || re.test(f.method || '') || re.test(String(f.status || ''));
  } catch {
    const needle = raw.toLowerCase();
    return (f) => (f.url || '').toLowerCase().includes(needle) || (f.method || '').toLowerCase().includes(needle);
  }
}

function visibleFlows() {
  const fn = activeFilter();
  return state.flows.filter(fn);
}

function flowRow(f, depth = 0, basePath = '') {
  const { host, pathname, search } = splitFlowUrl(f);
  // Inside a path group, show only the suffix relative to that group; the
  // group row already carries the long shared prefix.
  let displayPath = pathname;
  if (depth > 0 && basePath && pathname.startsWith(basePath)) {
    const rest = pathname.slice(basePath.length);
    // Flows that end exactly at the group path are distinguished by query.
    displayPath = rest || (search ? '' : '/');
  }
  const row = el('div', 'flow-row leaf-row' + (depth ? ' depth-' + depth : '') + (f.id === state.selectedId ? ' selected' : ''));
  row.dataset.id = f.id;
  row.title = f.url || '';
  if (depth) row.style.paddingLeft = (12 + depth * 16) + 'px';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', f.id === state.selectedId ? 'true' : 'false');
  row.appendChild(el('div', 'method ' + (f.method || ''), f.method || '?'));

  const main = el('div', 'flow-main');
  const urlLine = el('div', 'flow-url');
  // Under a host group the host is already shown by the parent row; only the
  // flat list and the host row itself need it inline.
  if (host && depth === 0) urlLine.appendChild(el('span', 'host', host));
  urlLine.appendChild(el('span', 'path', displayPath + search));
  main.appendChild(urlLine);

  const meta = el('div', 'flow-meta');
  if (f.status) meta.appendChild(el('span', 'status ' + statusClass(f.status), String(f.status)));
  const p = protoTag(f.resProto || f.reqProto);
  if (p) meta.appendChild(p);
  if (f.mocked) meta.appendChild(el('span', 'tag mock', t('list.tagMock')));
  if (f.upgrade) meta.appendChild(el('span', 'tag ws', 'ws'));
  if (f.tunnel) {
    meta.appendChild(el('span', 'tag tunnel', t('list.tagTunnel')));
    meta.appendChild(el('span', '', '\u2191 ' + fmtBytes(f.tunnelBytesUp || 0) + '  \u2193 ' + fmtBytes(f.tunnelBytesDown || 0)));
  }
  if (f.patchError || f.error) meta.appendChild(el('span', 'tag err', t('list.tagErr')));
  if (f.durationMs !== undefined && f.durationMs !== null) meta.appendChild(el('span', '', fmtDuration(f.durationMs)));
  if (f.resSize) meta.appendChild(el('span', '', fmtBytes(f.resSize)));
  meta.appendChild(el('span', 'spacer'));
  meta.appendChild(el('span', '', timeOf(f.ts)));
  main.appendChild(meta);
  row.appendChild(main);
  row.addEventListener('click', () => selectFlow(f.id));
  return row;
}

function buildTree(list) {
  const hosts = new Map();
  for (const f of list) {
    const u = splitFlowUrl(f);
    const hostName = u.host || t('tree.unknownHost');
    let h = hosts.get(hostName);
    if (!h) {
      h = {
        key: 'h:' + hostName,
        host: hostName,
        latest: f,
        flows: [],
        root: { segment: '', path: '', children: new Map(), flows: [] },
      };
      hosts.set(hostName, h);
    }
    h.flows.push(f);
    if (!h.latest) h.latest = f;
    const segments = (u.pathname || '/').split('/').filter(Boolean);
    let node = h.root;
    for (const seg of segments) {
      let child = node.children.get(seg);
      if (!child) {
        child = {
          segment: seg,
          path: (node.path || '') + '/' + seg,
          children: new Map(),
          flows: [],
          latest: f,
        };
        node.children.set(seg, child);
      }
      if (!child.latest) child.latest = f;
      node = child;
    }
    node.flows.push(f);
  }
  // Stable order: alphabetical, so a new request never reshuffles existing
  // groups (recency ordering made the tree jump on every capture).
  return [...hosts.values()].sort((a, b) => compareTreeLabel(a.host, b.host));
}

function compareTreeLabel(a, b) {
  // The unknown-host bucket sinks to the bottom; otherwise case-insensitive
  // with numeric collation so /item-2 sorts before /item-10.
  const unknown = t('tree.unknownHost');
  const ua = a === unknown;
  const ub = b === unknown;
  if (ua !== ub) return ua ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function sortedChildren(node) {
  return [...node.children.values()].sort((a, b) => compareTreeLabel(a.segment, b.segment));
}

function nodeTotal(node) {
  if (node.total === undefined) {
    node.total = node.flows.length;
    for (const child of node.children.values()) node.total += nodeTotal(child);
  }
  return node.total;
}

function compressPathNode(node) {
  let cur = node;
  while (cur.flows.length === 0 && cur.children.size === 1) {
    cur = [...cur.children.values()][0];
  }
  return cur;
}

function hostRow(h, open) {
  const selectedInside = h.flows.some((f) => f.id === state.selectedId);
  const row = el('div', 'flow-row group-row host-row' + (selectedInside ? ' has-selected' : ''));
  row.title = t('tree.hostTitle', { host: h.host, n: h.flows.length });
  row.appendChild(el('span', 'disclosure', open ? '▾' : '▸'));
  row.appendChild(el('span', 'host-label', h.host));
  row.appendChild(el('span', 'count-badge', String(h.flows.length)));
  if (h.latest && h.latest.status) row.appendChild(el('span', 'last-status ' + statusClass(h.latest.status), String(h.latest.status)));
  row.appendChild(el('span', 'spacer'));
  if (h.latest) row.appendChild(el('span', 'last-dur', timeOf(h.latest.ts)));
  row.addEventListener('click', () => {
    if (open) state.treeOpen.delete(h.key);
    else state.treeOpen.add(h.key);
    saveSet('pbmockx-tree-open-v2', state.treeOpen);
    renderFlows();
  });
  return row;
}

function nodeHasSelected(node) {
  if (node.flows.some((f) => f.id === state.selectedId)) return true;
  for (const child of node.children.values()) {
    if (nodeHasSelected(child)) return true;
  }
  return false;
}

function pathGroupRow(host, node, depth, open) {
  const row = el('div', 'flow-row group-row endpoint-row' + (nodeHasSelected(node) ? ' has-selected' : ''));
  const count = nodeTotal(node);
  row.title = t('tree.pathTitle', { host: host.host, path: node.path || '/', n: count });
  row.style.paddingLeft = (12 + depth * 16) + 'px';
  row.appendChild(el('span', 'disclosure', open ? '▾' : '▸'));
  row.appendChild(el('span', 'path-label', node.path || '/'));
  row.appendChild(el('span', 'count-badge', String(count)));
  if (node.latest && node.latest.status) row.appendChild(el('span', 'last-status ' + statusClass(node.latest.status), String(node.latest.status)));
  if (node.latest && node.latest.durationMs !== undefined) row.appendChild(el('span', 'last-dur', fmtDuration(node.latest.durationMs)));
  const key = 'p:' + host.host + '|' + node.path;
  row.addEventListener('click', () => {
    if (open) state.treeOpen.delete(key);
    else state.treeOpen.add(key);
    saveSet('pbmockx-tree-open-v2', state.treeOpen);
    renderFlows();
  });
  return row;
}

function renderPathNode(host, node, depth, frag, basePath = '') {
  // A terminal path with a single request needs no group row of its own.
  if (node.flows.length === 1 && node.children.size === 0) {
    frag.appendChild(flowRow(node.flows[0], depth, basePath));
    return;
  }
  const cur = compressPathNode(node);
  const key = 'p:' + host.host + '|' + cur.path;
  const open = state.treeOpen.has(key);
  frag.appendChild(pathGroupRow(host, cur, depth, open));
  if (!open) return;
  for (const f of cur.flows) frag.appendChild(flowRow(f, depth + 1, cur.path));
  for (const child of sortedChildren(cur)) renderPathNode(host, child, depth + 1, frag, cur.path);
}

function renderTree(list) {
  const frag = document.createDocumentFragment();
  let openHosts = 0;
  for (const h of buildTree(list)) {
    const open = state.treeOpen.has(h.key);
    if (open) openHosts++;
    frag.appendChild(hostRow(h, open));
    if (!open) continue;
    for (const f of h.root.flows) frag.appendChild(flowRow(f, 1));
    for (const child of sortedChildren(h.root)) renderPathNode(h, child, 1, frag);
  }
  if (openHosts === 0 && list.length) {
    frag.appendChild(el('div', 'tree-hint', t('list.treeHint')));
  }
  return frag;
}

/**
 * renderFlows() rebuilds the whole list on every SSE event. Without help the
 * browser resets scrollTop to 0, so a busy capture yanks the user back to the
 * top. Anchor on the request currently at the top of the viewport instead.
 */
function withListAnchor(rebuild) {
  const listEl = els.flowList;
  let anchorId = null;
  let anchorOffset = 0;
  if (listEl.scrollTop > 0) {
    const box = listEl.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 8, box.top + 4);
    const row = hit && hit.closest ? hit.closest('.flow-row[data-id]') : null;
    if (row) {
      anchorId = row.dataset.id;
      anchorOffset = row.getBoundingClientRect().top - box.top;
    }
  }
  const prevScroll = listEl.scrollTop;
  rebuild();
  if (!anchorId) {
    listEl.scrollTop = prevScroll;
    return;
  }
  const again = listEl.querySelector('.flow-row[data-id="' + CSS.escape(anchorId) + '"]');
  if (!again) {
    listEl.scrollTop = prevScroll;
    return;
  }
  const box = listEl.getBoundingClientRect();
  // Chrome keeps (or scroll-anchors) scrollTop while innerHTML is rebuilt, so
  // convert the row's viewport offset back into content coordinates first.
  const contentTop = again.getBoundingClientRect().top - box.top + listEl.scrollTop;
  listEl.scrollTop = Math.max(0, contentTop - anchorOffset);
}

function renderFlows() {
  withListAnchor(() => paintFlows());
}

function paintFlows() {
  const list = visibleFlows();
  els.flowList.innerHTML = '';
  els.flowCount.textContent = t('list.count', { shown: list.length, total: state.flows.length });
  const empty = state.flows.length === 0;
  els.emptyList.classList.toggle('show', empty);
  els.flowList.style.display = empty ? 'none' : '';
  document.body.classList.toggle('tree-mode', state.listMode === 'tree');

  for (const b of els.listMode.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === state.listMode);
    b.setAttribute('aria-pressed', b.dataset.mode === state.listMode ? 'true' : 'false');
  }

  if (empty) return;
  if (state.listMode === 'tree') {
    els.flowList.appendChild(renderTree(list));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of list) frag.appendChild(flowRow(f, 0));
  els.flowList.appendChild(frag);
}

function setAllTreeGroups(expand) {
  for (const h of buildTree(visibleFlows())) {
    if (expand) state.treeOpen.add(h.key);
    else state.treeOpen.delete(h.key);
    const walk = (node) => {
      if (node.path) {
        const key = 'p:' + h.host + '|' + node.path;
        if (expand) state.treeOpen.add(key);
        else state.treeOpen.delete(key);
      }
      for (const child of node.children.values()) walk(child);
    };
    walk(h.root);
  }
  saveSet('pbmockx-tree-open-v2', state.treeOpen);
  renderFlows();
}

function upsertFlow(f, isNew) {
  const idx = state.flows.findIndex((x) => x.id === f.id);
  if (idx >= 0) state.flows[idx] = { ...state.flows[idx], ...f };
  else state.flows.unshift(f);
  if (state.flows.length > 500) state.flows.length = 500;
  if (state.paused) return;
  renderFlows();
  if (state.selectedId === f.id) scheduleDetail();
  else if (isNew && !state.selectedId) selectFlow(f.id);
}

// --- detail ---

function selectFlow(id) {
  state.selectedId = id;
  state.detail = null;
  state.detailOriginal = null;
  state.bodyCache.clear();
  state.tab = 'summary';
  state.original = false;
  state.bodyMode = 'decoded';
  renderFlows();
  updateHash();
  loadDetail(id);
}

async function loadDetail(id, silent = false) {
  try {
    const d = await api('/flows/' + encodeURIComponent(id) + (state.original ? '?original=1' : ''));
    if (state.selectedId !== id) return;
    state.detail = d;
    if (state.original) state.detailOriginal = d;
    renderDetail();
  } catch (e) {
    if (!silent) {
      toast(e.message, true);
      els.emptyDetail.classList.remove('hidden');
      els.detailBody.classList.add('hidden');
    }
  }
}

function scheduleDetail() {
  clearTimeout(state.detailTimer);
  state.detailTimer = setTimeout(() => {
    if (state.selectedId) loadDetail(state.selectedId, true);
  }, 150);
}

async function loadOriginalDetail() {
  if (!state.selectedId || state.detailOriginal) return;
  try {
    state.detailOriginal = await api('/flows/' + encodeURIComponent(state.selectedId) + '?original=1');
  } catch (e) {
    toast(e.message, true);
  }
}

function sourceDetail(part) {
  if (part === 'res' && state.original && state.detailOriginal) return state.detailOriginal;
  return state.detail;
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  if (d.tunnel) state.tab = 'summary';
  els.emptyDetail.classList.add('hidden');
  els.detailBody.classList.remove('hidden');
  // SSE updates re-render this pane; wiping the DOM would otherwise snap the
  // reader back to the top (and out of a long body).
  const scroller = els.detailBody.closest('.detail');
  const scrollTop = scroller ? scroller.scrollTop : 0;
  els.detailBody.innerHTML = '';

  const head = el('div', 'detail-head');
  const u = el('div', 'detail-url');
  u.appendChild(el('span', 'm', d.method || ''));
  u.appendChild(el('span', '', d.url || ''));
  head.appendChild(u);
  const sub = el('div', 'detail-sub');
  if (d.status) sub.appendChild(el('span', 'status ' + statusClass(d.status), 'HTTP ' + d.status + (d.statusText ? ' ' + d.statusText : '')));
  if (d.resProtocol) sub.appendChild(el('span', 'code ' + (d.resProtocol === 'protobuf' ? 'pb' : 'json'), d.resProtocol === 'protobuf' ? 'PB' : d.resProtocol.toUpperCase()));
  if (d.resMessageType) sub.appendChild(el('span', '', d.resMessageType));
  if (d.durationMs !== undefined) sub.appendChild(el('span', '', fmtDuration(d.durationMs)));
  if (d.resSize) sub.appendChild(el('span', '', t('detail.respSize', { size: fmtBytes(d.resSize) })));
  if (d.reqSize) sub.appendChild(el('span', '', t('detail.reqSize', { size: fmtBytes(d.reqSize) })));
  if (d.mocked) sub.appendChild(el('span', 'pill mock', t('detail.mocked')));
  if (d.upgrade) sub.appendChild(el('span', 'pill', d.upgrade));
  if (d.tunnel) sub.appendChild(el('span', 'pill' + (d.error ? ' err' : ''), t('detail.notDecrypted')));
  if (d.resPatched) sub.appendChild(el('span', 'pill mock', t('detail.patched')));
  const copyUrl = el('button', 'btn small', t('detail.copyUrl'));
  copyUrl.addEventListener('click', () => copyText(d.url || ''));
  sub.appendChild(copyUrl);
  head.appendChild(sub);
  els.detailBody.appendChild(head);

  const tabs = el('div', 'tabs');
  for (const [key, label] of [['summary', t('detail.tab.summary')], ['req', t('detail.tab.request')], ['res', t('detail.tab.response')]]) {
    if (d.tunnel && key !== 'summary') continue;
    const b = el('button', 'tab' + (state.tab === key ? ' active' : ''), label);
    b.addEventListener('click', () => { state.tab = key; renderDetail(); });
    tabs.appendChild(b);
  }
  els.detailBody.appendChild(tabs);

  const content = el('div');
  els.detailBody.appendChild(content);
  if (state.tab === 'summary') renderSummary(content, d);
  else if (state.tab === 'req') renderMessage(content, 'req');
  else renderMessage(content, 'res');
  if (scroller && scrollTop) scroller.scrollTop = scrollTop;
}

/** Stable identity for a card: counts ("Query (5)") must not create a new key. */
function cardKey(title) {
  return String(title).replace(/\s*\(\d+\)\s*$/, '').trim();
}

function setCardCollapsed(c, collapsed) {
  const key = c.dataset.collapseKey;
  c.classList.toggle('collapsed', collapsed);
  c.classList.toggle('expanded', !collapsed);
  const toggle = c.querySelector(':scope > .card-head > .card-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  const body = c.querySelector(':scope > .card-body');
  // Lazy body: a collapsed card (e.g. a huge PB tree) is not even built, and
  // the fetch/decoding work inside its builder is deferred until expanded.
  if (!collapsed && body && body.dataset.pending === '1') {
    delete body.dataset.pending;
    body.innerHTML = '';
    if (typeof body._build === 'function') body._build(body);
  }
  if (key) {
    if (collapsed) state.collapsedCards.add(key);
    else state.collapsedCards.delete(key);
    saveSet(COLLAPSED_CARDS_KEY, state.collapsedCards);
  }
}

function card(title, bodyBuilder, extraHead, opts = {}) {
  const key = opts.key || cardKey(title);
  const collapsed = state.collapsedCards.has(key);
  const c = el('div', 'card collapsible ' + (collapsed ? 'collapsed' : 'expanded'));
  c.dataset.collapseKey = key;
  const h = el('div', 'card-head');
  const toggle = el('button', 'card-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  toggle.setAttribute('aria-label', t(collapsed ? 'card.expand' : 'card.collapse', { title }));
  toggle.appendChild(el('span', 'chev'));
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setCardCollapsed(c, !c.classList.contains('collapsed'));
  });
  h.appendChild(toggle);
  h.appendChild(el('span', 'title', title));
  h.appendChild(el('span', 'spacer'));
  if (extraHead) extraHead(h);
  h.addEventListener('click', (e) => {
    // Toolbar buttons (Decoded/Raw/Hex, Copy, Download) live in the head and
    // must keep their own click.
    if (e.target.closest && e.target.closest('button, a, input, select, textarea, .seg')) return;
    setCardCollapsed(c, !c.classList.contains('collapsed'));
  });
  c.appendChild(h);
  const b = el('div', 'card-body');
  b._build = bodyBuilder;
  if (collapsed) b.dataset.pending = '1';
  else bodyBuilder(b);
  c.appendChild(b);
  return c;
}

function kv(list) {
  const grid = el('div', 'kv');
  for (const [k, v] of list) {
    if (v === undefined || v === null || v === '') continue;
    grid.appendChild(el('div', 'k', k));
    grid.appendChild(el('div', 'v', v));
  }
  return grid;
}

// Tunnel reasons are machine values; only the explanation is translated.
const TUNNEL_KEY = {
  bypass: 'tunnel.bypass',
  'mitm-disabled': 'tunnel.mitmDisabled',
  port: 'tunnel.port',
  'tls-handshake': 'tunnel.tlsHandshake',
  'ca-error': 'tunnel.caError',
};

function renderSummary(container, d) {
  if (d.tunnel) {
    container.appendChild(card(t('detail.card.notDecrypted'), (b) => {
      const note = TUNNEL_KEY[d.tunnel];
      b.appendChild(el('div', 'banner warn', note ? t(note) : d.tunnel));
      b.appendChild(kv([
        [t('kv.reason'), d.tunnel],
        [t('kv.connect'), d.url],
        [t('kv.error'), d.error],
        [t('kv.bytesUp'), d.tunnelBytesUp !== undefined ? fmtBytes(d.tunnelBytesUp) : ''],
        [t('kv.bytesDown'), d.tunnelBytesDown !== undefined ? fmtBytes(d.tunnelBytesDown) : ''],
        [t('kv.closed'), d.tunnelClose],
        [t('kv.duration'), d.durationMs !== undefined ? fmtDuration(d.durationMs) : ''],
        [t('kv.client'), d.clientIp],
      ]));
    }, null, { key: 'Not decrypted' }));
  }

  const overview = card(t('detail.card.overview'), (b) => {
    const list = [
      [t('kv.method'), d.method],
      [t('kv.status'), d.status ? d.status + (d.statusText ? ' ' + d.statusText : '') : ''],
      [t('kv.url'), d.url],
      [t('kv.originalUrl'), d.originalUrl && d.originalUrl !== d.url ? d.originalUrl : ''],
      [t('kv.request'), d.reqProtocol ? (d.reqProtocol === 'protobuf' ? 'protobuf ' + (d.reqMessageType || '') : d.reqProtocol) : ''],
      [t('kv.response'), d.resProtocol ? (d.resProtocol === 'protobuf' ? 'protobuf ' + (d.resMessageType || '') : d.resProtocol) : ''],
      [t('kv.duration'), d.durationMs !== undefined ? fmtDuration(d.durationMs) : ''],
      [t('kv.reqBytes'), d.reqSize ? fmtBytes(d.reqSize) + (d.reqTruncated ? ' ' + t('detail.truncated') : '') : ''],
      [t('kv.resBytes'), d.resSize ? fmtBytes(d.resSize) + (d.resTruncated ? ' ' + t('detail.truncated') : '') : ''],
      [t('kv.contentEncoding'), d.resContentEncoding],
      [t('kv.started'), d.timings?.start ? new Date(d.timings.start).toLocaleString() : ''],
      [t('kv.flowId'), d.id],
    ];
    b.appendChild(kv(list));
  }, null, { key: 'Overview' });
  container.appendChild(overview);

  const rules = d.matchedRules || [];
  if (rules.length) {
    const rc = card(t('detail.matchedRules'), (b) => {
      for (const r of rules) {
        const row = el('div', 'rule-row');
        const main = el('div');
        main.appendChild(el('div', 'rule-url', r.type + '  ·  ' + r.phase));
        if (r.detail) main.appendChild(el('div', 'rule-meta', r.detail));
        row.appendChild(main);
        const pill = el('span', 'pill ' + (r.outcome === 'applied' ? 'ok' : r.outcome === 'error' ? 'err' : ''), r.outcome);
        const actions = el('div', 'rule-actions');
        actions.appendChild(pill);
        row.appendChild(actions);
        b.appendChild(row);
      }
    }, null, { key: 'Matched rules' });
    container.appendChild(rc);
  }

  const timings = d.timings || {};
  if (timings.start) {
    const tc = card(t('detail.card.timing'), (b) => {
      const base = timings.start;
      const list = [
        [t('kv.start'), '0 ms'],
        [t('kv.upstreamConnected'), timings.upstreamStart ? (timings.upstreamStart - base) + ' ms' : ''],
        [t('kv.firstByte'), timings.firstByte ? (timings.firstByte - base) + ' ms' : ''],
        [t('kv.complete'), timings.end ? (timings.end - base) + ' ms' : ''],
      ];
      b.appendChild(kv(list));
    }, null, { key: 'Timing' });
    container.appendChild(tc);
  }

  const problems = [];
  if (d.error) problems.push([t('problem.error'), d.error]);
  if (d.patchError) problems.push([t('problem.patchError'), d.patchError]);
  if (d.decodeError) problems.push([t('problem.decodeError'), d.decodeError]);
  if (d.reqDecodeError) problems.push([t('problem.reqDecode'), d.reqDecodeError]);
  if (d.resDecodeError) problems.push([t('problem.resDecode'), d.resDecodeError]);
  if (d.resTruncated) problems.push([t('problem.note'), t('problem.truncatedNote')]);
  for (const [k, v] of problems) {
    const banner = el('div', 'banner err');
    banner.textContent = k + ': ' + v;
    container.appendChild(banner);
  }
}

function headersCard(title, headers, opts = {}) {
  const count = headers ? Object.keys(headers).length : 0;
  const c = card(title + (count ? ' (' + count + ')' : ''), (b) => {
    if (!count) {
      b.appendChild(el('div', 'body-empty', opts.empty || t('detail.noReqHeaders')));
      return;
    }
    const table = el('table', 'headers');
    for (const [k, v] of Object.entries(headers)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'k', k));
      tr.appendChild(el('td', 'v', Array.isArray(v) ? v.join('\n') : String(v)));
      table.appendChild(tr);
    }
    b.appendChild(table);
  }, null, opts.key ? { key: opts.key } : {});
  c.classList.add('headers-card');
  return c;
}

function bodyToolbar(part, d) {
  const toolbar = el('div', 'body-toolbar');
  const seg = el('div', 'seg');
  for (const [mode, label] of [['decoded', t('detail.mode.decoded')], ['raw', t('detail.mode.raw')], ['hex', t('detail.mode.hex')]]) {
    const b = el('button', state.bodyMode === mode ? 'active' : '', label);
    b.addEventListener('click', () => { state.bodyMode = mode; renderDetail(); });
    seg.appendChild(b);
  }
  toolbar.appendChild(seg);
  if (part === 'res' && d.resPatched) {
    const seg2 = el('div', 'seg');
    for (const [orig, label] of [[false, t('detail.mode.patched')], [true, t('detail.mode.original')]]) {
      const b = el('button', state.original === orig ? 'active' : '', label);
      b.addEventListener('click', async () => {
        if (orig && !state.detailOriginal) await loadOriginalDetail();
        state.original = orig;
        renderDetail();
      });
      seg2.appendChild(b);
    }
    toolbar.appendChild(seg2);
  }
  toolbar.appendChild(el('span', 'spacer'));
  const copyBtn = el('button', 'btn small', t('common.copy'));
  copyBtn.addEventListener('click', async () => {
    const src = sourceDetail(part);
    const data = part === 'req' ? src.reqData : src.resData;
    copyText(data !== undefined ? JSON.stringify(data, null, 2) : '');
  });
  toolbar.appendChild(copyBtn);
  const dl = el('a', 'btn small', t('common.download'));
  const q = new URLSearchParams({ part: part === 'req' ? 'req' : (state.original ? 'res-original' : 'res') });
  dl.href = '/__pbmockx/api/flows/' + encodeURIComponent(d.id) + '/body?' + q.toString();
  dl.download = d.id + '-' + (part === 'req' ? 'request' : 'response') + '.bin';
  toolbar.appendChild(dl);
  return toolbar;
}

async function fetchBodyText(d, part, mode) {
  const key = d.id + ':' + part + ':' + (part === 'res' && state.original ? 'orig' : 'cur') + ':' + mode;
  if (state.bodyCache.has(key)) return state.bodyCache.get(key);
  const q = new URLSearchParams({ part: part === 'req' ? 'req' : (state.original ? 'res-original' : 'res') });
  const res = await fetch('/__pbmockx/api/flows/' + encodeURIComponent(d.id) + '/body?' + q.toString());
  if (!res.ok) throw new Error(t('body.notAvailable', { status: res.status }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  let out;
  if (mode === 'hex') {
    const limit = Math.min(bytes.length, 64 * 1024);
    const lines = [];
    for (let i = 0; i < limit; i += 16) {
      const chunk = bytes.subarray(i, i + 16);
      const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
      const ascii = Array.from(chunk).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      lines.push(i.toString(16).padStart(8, '0') + '  ' + hex + '  ' + ascii);
    }
    if (bytes.length > limit) lines.push(t('body.moreBytes', { n: bytes.length - limit }));
    out = lines.join('\n');
  } else {
    out = new TextDecoder('utf-8').decode(bytes);
    if (out.length > 400000) out = out.slice(0, 400000) + '\n' + t('body.truncatedForDisplay');
  }
  state.bodyCache.set(key, out);
  return out;
}

function renderDecodedBody(container, part) {
  const src = sourceDetail(part);
  if (!src) {
    container.appendChild(el('div', 'body-empty', t('body.noData')));
    return;
  }
  const protocol = part === 'req' ? src.reqProtocol : src.resProtocol;
  const data = part === 'req' ? src.reqData : src.resData;
  const decodeError = part === 'req' ? src.reqDecodeError : src.resDecodeError;
  if (decodeError && data === undefined) {
    container.appendChild(el('div', 'banner err', decodeError));
    return;
  }
  if (data === undefined || data === null) {
    const hasBody = part === 'req' ? src.reqSize : src.resSize;
    container.appendChild(el('div', 'body-empty', hasBody ? t('body.notDecodable') : t('body.empty')));
    return;
  }
  if (protocol === 'protobuf') {
    renderPbTree(container, data);
  } else if (protocol === 'json') {
    renderJsonTree(container, data);
  } else if (protocol === 'form') {
    const table = el('table', 'headers');
    for (const [k, v] of Object.entries(data)) {
      const tr = el('tr');
      tr.appendChild(el('td', 'k', k));
      tr.appendChild(el('td', 'v', Array.isArray(v) ? v.join(', ') : String(v)));
      table.appendChild(tr);
    }
    container.appendChild(table);
  } else {
    renderJsonTree(container, data);
  }
}

function queryCard(url) {
  let entries = [];
  try {
    entries = [...new URL(url, location.origin).searchParams.entries()];
  } catch {}
  if (!entries.length) return null;
  const c = card(t('detail.queryCount', { n: entries.length }), (b) => {
    const table = el('table', 'headers');
    for (const [k, v] of entries) {
      const tr = el('tr');
      tr.appendChild(el('td', 'k', k));
      tr.appendChild(el('td', 'v', v === '' ? t('common.emptyParen') : v));
      table.appendChild(tr);
    }
    b.appendChild(table);
  }, null, { key: 'Query' });
  c.classList.add('query-card');
  return c;
}

function renderMessage(container, part) {
  const d = state.detail;
  const isReq = part === 'req';
  const headers = isReq ? d.reqHeaders : d.resHeaders;
  const qc = isReq ? queryCard(d.url) : null;
  if (qc) container.appendChild(qc);
  container.appendChild(headersCard(isReq ? t('detail.reqHeaders') : t('detail.resHeaders'), headers, {
    empty: isReq ? t('detail.noReqHeaders') : t('detail.noResHeaders'),
    key: isReq ? 'Request headers' : 'Response headers',
  }));

  // Build lazily: collapsing a huge body must not keep decoding it on every
  // SSE re-render, and the raw fetch is deferred until the card is opened.
  const bodyCard = card(isReq ? t('detail.reqBody') : t('detail.resBody'), (bodyBox) => {
    if (state.bodyMode === 'decoded') {
      renderDecodedBody(bodyBox, part);
      return;
    }
    bodyBox.appendChild(el('div', 'body-empty', t('common.loading')));
    fetchBodyText(d, part, state.bodyMode)
      .then((text) => {
        bodyBox.innerHTML = '';
        const pre = el('pre', 'raw' + (state.bodyMode === 'hex' ? ' hex' : ''), text || t('common.emptyParen'));
        bodyBox.appendChild(pre);
      })
      .catch((e) => {
        bodyBox.innerHTML = '';
        bodyBox.appendChild(el('div', 'banner err', e.message));
      });
  }, (head) => {
    head.appendChild(bodyToolbar(part, d));
  }, { key: isReq ? 'Request body' : 'Response body' });
  container.appendChild(bodyCard);
}

// --- language ---

function hasExplicitLangChoice() {
  try {
    return !!new URLSearchParams(location.search).get('lang') || !!localStorage.getItem('pbmockx-lang');
  } catch { return false; }
}

/**
 * /health.lang is a default, not an override: ?lang= and a choice made with the
 * toggle always win. Never awaited before rendering — a late answer just
 * re-renders the panes that already baked t() output into the DOM.
 */
function syncLangFromServer(serverLang) {
  const next = normalizeLang(serverLang);
  if (!next || next === getLang() || hasExplicitLangChoice()) return;
  setLang(next, { persist: false });
  refreshForLang();
}

function refreshForLang() {
  renderPauseLabel();
  if (state.conn) setConn(state.conn.ok, state.conn.key);
  renderFlows();
  if (state.detail) renderDetail();
  if (state.drawer) renderDrawer().catch(() => {});
}

// --- health / load ---

async function fetchHealth() {
  try {
    state.health = await api('/health');
    setConn(true);
    els.version.textContent = 'v' + state.health.version;
    state.rulesCount = state.health.rules || 0;
    els.rulesCount.textContent = String(state.rulesCount);
    syncLangFromServer(state.health.lang);
  } catch {
    setConn(false);
  }
}

async function initialLoad() {
  try {
    state.info = await api('/info');
    const host = state.info.host === '0.0.0.0' || state.info.host === '::'
      ? (state.info.lanAddresses && state.info.lanAddresses[0]) || t('setup.thisMachineIp')
      : state.info.host;
    els.proxyAddr.textContent = host + ':' + state.info.port;
  } catch {}
  try {
    const flows = await api('/flows');
    state.flows = flows || [];
    renderFlows();
  } catch (e) {
    setConn(false);
  }
  await fetchHealth();
  const hash = location.hash;
  const m = /^#\/flow\/(.+)$/.exec(hash);
  if (m) {
    selectFlow(decodeURIComponent(m[1]));
  } else if (state.flows.length) {
    selectFlow(state.flows[0].id);
  }
  if (hash === '#/rules') openDrawer('rules');
  if (hash === '#/setup') openDrawer('setup');
}

function updateHash() {
  let hash = '#/';
  if (state.drawer === 'rules') hash = '#/rules';
  else if (state.drawer === 'setup') hash = '#/setup';
  else if (state.selectedId) hash = '#/flow/' + encodeURIComponent(state.selectedId);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

// --- SSE ---

function connectEvents() {
  const es = new EventSource('/__pbmockx/api/events');
  es.onopen = () => {
    setConn(true);
    fetchHealth();
  };
  es.onerror = () => setConn(false, 'conn.reconnecting');
  es.addEventListener('flow.new', (e) => {
    try { upsertFlow(JSON.parse(e.data), true); } catch {}
  });
  es.addEventListener('flow.update', (e) => {
    try { upsertFlow(JSON.parse(e.data), false); } catch {}
  });
  es.addEventListener('rules.changed', () => {
    fetchHealth();
    if (state.drawer === 'rules') renderDrawer();
  });
}

// --- wiring ---

function wire() {
  els.filter.addEventListener('input', () => {
    state.filter = els.filter.value;
    renderFlows();
  });
  for (const b of els.listMode.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      state.listMode = b.dataset.mode === 'tree' ? 'tree' : 'flat';
      localStorage.setItem('pbmockx-list-mode', state.listMode);
      renderFlows();
    });
  }
  els.treeExpand.addEventListener('click', () => setAllTreeGroups(true));
  els.treeCollapse.addEventListener('click', () => setAllTreeGroups(false));

  $('#btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#btn-pause').classList.toggle('active', state.paused);
    renderPauseLabel();
    if (!state.paused) {
      renderFlows();
      fetchHealth();
      if (state.selectedId) scheduleDetail();
    }
  });
  $('#btn-clear').addEventListener('click', async () => {
    if (!confirm(t('confirm.clearFlows'))) return;
    try {
      await api('/flows', { method: 'DELETE' });
      state.flows = [];
      state.selectedId = null;
      state.detail = null;
      els.detailBody.classList.add('hidden');
      els.emptyDetail.classList.remove('hidden');
      renderFlows();
      updateHash();
      toast(t('toast.flowsCleared'));
    } catch (e) { toast(e.message, true); }
  });
  $('#btn-rules').addEventListener('click', () => openDrawer('rules'));
  $('#btn-setup').addEventListener('click', () => openDrawer('setup'));
  $('#btn-theme').addEventListener('click', cycleTheme);
  $('#btn-drawer-close').addEventListener('click', closeDrawer);
  $('#btn-modal-close').addEventListener('click', closeModal);
  $('#btn-copy-proxy').addEventListener('click', () => copyText(els.proxyAddr.textContent));

  // Draggable divider: the flow list remembers its width across reloads.
  const applySidebarWidth = (width, persist = true) => {
    const max = Math.max(360, Math.min(1000, window.innerWidth - 360));
    const w = Math.max(320, Math.min(max, Math.round(width)));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    if (persist) { try { localStorage.setItem('pbmockx-sidebar-width', String(w)); } catch {} }
  };
  const savedWidth = parseInt(localStorage.getItem('pbmockx-sidebar-width') || '', 10);
  if (savedWidth) applySidebarWidth(savedWidth, false);
  let dragging = false;
  const startDrag = (e) => {
    if (window.innerWidth <= 860) return;
    dragging = true;
    document.body.classList.add('resizing');
    els.splitter.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  els.splitter.addEventListener('pointerdown', startDrag);
  els.splitter.addEventListener('dblclick', () => applySidebarWidth(520));
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const left = document.querySelector('.layout').getBoundingClientRect().left;
    applySidebarWidth(e.clientX - left);
  });
  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
  };
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
  els.splitter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 520;
    applySidebarWidth(current + (e.key === 'ArrowRight' ? 24 : -24));
  });
  window.addEventListener('resize', () => {
    const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 520;
    if (window.innerWidth > 860) applySidebarWidth(current, false);
  });
  els.drawerBackdrop.addEventListener('click', closeDrawer);
  els.modalBackdrop.addEventListener('click', closeModal);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') {
      if (els.modal.classList.contains('open')) closeModal();
      else if (state.drawer) closeDrawer();
      else if (typing) document.activeElement.blur();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      els.filter.focus();
      els.filter.select();
    } else if ((e.key === 'j' || e.key === 'k') && !typing) {
      const list = visibleFlows();
      if (!list.length) return;
      let idx = list.findIndex((f) => f.id === state.selectedId);
      if (idx < 0) idx = 0;
      else idx = e.key === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
      selectFlow(list[idx].id);
    }
  });

  window.addEventListener('hashchange', () => {
    const hash = location.hash;
    if (hash === '#/rules') { if (state.drawer !== 'rules') openDrawer('rules'); }
    else if (hash === '#/setup') { if (state.drawer !== 'setup') openDrawer('setup'); }
    else {
      if (state.drawer) closeDrawer();
      const m = /^#\/flow\/(.+)$/.exec(hash);
      if (m && decodeURIComponent(m[1]) !== state.selectedId) selectFlow(decodeURIComponent(m[1]));
    }
  });
}

applyTheme(localStorage.getItem('pbmockx-theme') || 'auto');

function startUi() {
  // Static markup first, then the toggle. The reload below is deliberate:
  // dynamically rendered panes would otherwise keep the old language. List
  // width, tree expansion and collapsed cards are already in localStorage.
  applyStatic();
  renderPauseLabel();
  const langButton = $('#btn-lang');
  mountLangToggle(langButton);
  if (langButton) {
    langButton.addEventListener('click', () => {
      // mountLangToggle already flipped and persisted; drop ?lang= so the
      // shareable query param cannot override the new choice after reloading.
      try {
        const url = new URL(location.href);
        if (url.searchParams.has('lang')) {
          url.searchParams.delete('lang');
          history.replaceState(null, '', url.pathname + url.search + url.hash);
        }
      } catch { /* no location/history */ }
      location.reload();
    });
  }
  wire();
  initialLoad();
  connectEvents();
  setInterval(fetchHealth, 10000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUi, { once: true });
else startUi();
