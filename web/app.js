// pbmockx Web UI — live flow list, request/response inspector, rules & setup.
import { api } from './api.js';
import { el, fmtBytes, fmtDuration, renderPbTree, renderJsonTree } from './tree.js';
import { renderRulesPanel, renderSetupPanel } from './panels.js';

const $ = (sel) => document.querySelector(sel);
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
  drawer: null,
  bodyCache: new Map(),
  detailTimer: null,
  listMode: localStorage.getItem('pbmockx-list-mode') || 'flat',
  treeClosed: loadSet('pbmockx-tree-closed'),
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
    toast('Copied');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy failed', true); }
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

function setConn(ok, text) {
  els.conn.classList.toggle('ok', !!ok);
  els.conn.classList.toggle('err', ok === false);
  els.connText.textContent = text || (ok ? 'live' : 'offline');
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
  for (const [key, label] of [['rules', 'Mock rules'], ['setup', 'Setup & CA']]) {
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
  if (f.mocked) meta.appendChild(el('span', 'tag mock', 'mock'));
  if (f.upgrade) meta.appendChild(el('span', 'tag ws', 'ws'));
  if (f.patchError || f.error) meta.appendChild(el('span', 'tag err', 'err'));
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
    const hostName = u.host || '(unknown host)';
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
  return [...hosts.values()];
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
  const row = el('div', 'flow-row group-row host-row');
  row.title = h.host + ' — ' + h.flows.length + ' request(s)';
  row.appendChild(el('span', 'disclosure', open ? '▾' : '▸'));
  row.appendChild(el('span', 'host-label', h.host));
  row.appendChild(el('span', 'count-badge', String(h.flows.length)));
  if (h.latest && h.latest.status) row.appendChild(el('span', 'last-status ' + statusClass(h.latest.status), String(h.latest.status)));
  row.appendChild(el('span', 'spacer'));
  if (h.latest) row.appendChild(el('span', 'last-dur', timeOf(h.latest.ts)));
  row.addEventListener('click', () => {
    if (open) state.treeClosed.add(h.key);
    else state.treeClosed.delete(h.key);
    saveSet('pbmockx-tree-closed', state.treeClosed);
    renderFlows();
  });
  return row;
}

function pathGroupRow(host, node, depth, open) {
  const row = el('div', 'flow-row group-row endpoint-row');
  const count = nodeTotal(node);
  row.title = host.host + (node.path || '/') + ' — ' + count + ' request(s)';
  row.style.paddingLeft = (12 + depth * 16) + 'px';
  row.appendChild(el('span', 'disclosure', open ? '▾' : '▸'));
  row.appendChild(el('span', 'path-label', node.path || '/'));
  row.appendChild(el('span', 'count-badge', String(count)));
  if (node.latest && node.latest.status) row.appendChild(el('span', 'last-status ' + statusClass(node.latest.status), String(node.latest.status)));
  if (node.latest && node.latest.durationMs !== undefined) row.appendChild(el('span', 'last-dur', fmtDuration(node.latest.durationMs)));
  const key = 'p:' + host.host + '|' + node.path;
  row.addEventListener('click', () => {
    if (open) state.treeClosed.add(key);
    else state.treeClosed.delete(key);
    saveSet('pbmockx-tree-closed', state.treeClosed);
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
  const open = !state.treeClosed.has(key);
  frag.appendChild(pathGroupRow(host, cur, depth, open));
  if (!open) return;
  for (const f of cur.flows) frag.appendChild(flowRow(f, depth + 1, cur.path));
  for (const child of cur.children.values()) renderPathNode(host, child, depth + 1, frag, cur.path);
}

function renderTree(list) {
  const frag = document.createDocumentFragment();
  for (const h of buildTree(list)) {
    const open = !state.treeClosed.has(h.key);
    frag.appendChild(hostRow(h, open));
    if (!open) continue;
    for (const f of h.root.flows) frag.appendChild(flowRow(f, 1));
    for (const child of h.root.children.values()) renderPathNode(h, child, 1, frag);
  }
  return frag;
}

function renderFlows() {
  const list = visibleFlows();
  els.flowList.innerHTML = '';
  els.flowCount.textContent = list.length + ' / ' + state.flows.length + ' flows';
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

function ensureTreeVisible(flow) {
  if (!flow) return;
  const u = splitFlowUrl(flow);
  const hostName = u.host || '(unknown host)';
  state.treeClosed.delete('h:' + hostName);
  let path = '';
  for (const seg of (u.pathname || '/').split('/').filter(Boolean)) {
    path += '/' + seg;
    state.treeClosed.delete('p:' + hostName + '|' + path);
  }
  saveSet('pbmockx-tree-closed', state.treeClosed);
}

function setAllTreeGroups(expand) {
  for (const h of buildTree(visibleFlows())) {
    if (expand) state.treeClosed.delete(h.key);
    else state.treeClosed.add(h.key);
    const walk = (node) => {
      if (node.path) {
        const key = 'p:' + h.host + '|' + node.path;
        if (expand) state.treeClosed.delete(key);
        else state.treeClosed.add(key);
      }
      for (const child of node.children.values()) walk(child);
    };
    walk(h.root);
  }
  saveSet('pbmockx-tree-closed', state.treeClosed);
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
  if (state.listMode === 'tree') ensureTreeVisible(state.flows.find((f) => f.id === id));
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
  els.emptyDetail.classList.add('hidden');
  els.detailBody.classList.remove('hidden');
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
  if (d.resSize) sub.appendChild(el('span', '', 'resp ' + fmtBytes(d.resSize)));
  if (d.reqSize) sub.appendChild(el('span', '', 'req ' + fmtBytes(d.reqSize)));
  if (d.mocked) sub.appendChild(el('span', 'pill mock', 'mocked'));
  if (d.upgrade) sub.appendChild(el('span', 'pill', d.upgrade));
  if (d.resPatched) sub.appendChild(el('span', 'pill mock', 'patched'));
  const copyUrl = el('button', 'btn small', 'Copy URL');
  copyUrl.addEventListener('click', () => copyText(d.url || ''));
  sub.appendChild(copyUrl);
  head.appendChild(sub);
  els.detailBody.appendChild(head);

  const tabs = el('div', 'tabs');
  for (const [key, label] of [['summary', 'Summary'], ['req', 'Request'], ['res', 'Response']]) {
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
}

function card(title, bodyBuilder, extraHead) {
  const c = el('div', 'card');
  const h = el('div', 'card-head');
  h.appendChild(el('span', 'title', title));
  h.appendChild(el('span', 'spacer'));
  if (extraHead) extraHead(h);
  c.appendChild(h);
  const b = el('div', 'card-body');
  bodyBuilder(b);
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

function renderSummary(container, d) {
  const overview = card('Overview', (b) => {
    const list = [
      ['method', d.method],
      ['status', d.status ? d.status + (d.statusText ? ' ' + d.statusText : '') : ''],
      ['url', d.url],
      ['original URL', d.originalUrl && d.originalUrl !== d.url ? d.originalUrl : ''],
      ['request', d.reqProtocol ? (d.reqProtocol === 'protobuf' ? 'protobuf ' + (d.reqMessageType || '') : d.reqProtocol) : ''],
      ['response', d.resProtocol ? (d.resProtocol === 'protobuf' ? 'protobuf ' + (d.resMessageType || '') : d.resProtocol) : ''],
      ['duration', d.durationMs !== undefined ? fmtDuration(d.durationMs) : ''],
      ['request bytes', d.reqSize ? fmtBytes(d.reqSize) + (d.reqTruncated ? ' (truncated)' : '') : ''],
      ['response bytes', d.resSize ? fmtBytes(d.resSize) + (d.resTruncated ? ' (truncated)' : '') : ''],
      ['content-encoding', d.resContentEncoding],
      ['started', d.timings?.start ? new Date(d.timings.start).toLocaleString() : ''],
      ['flow id', d.id],
    ];
    b.appendChild(kv(list));
  });
  container.appendChild(overview);

  const rules = d.matchedRules || [];
  if (rules.length) {
    const rc = card('Matched rules', (b) => {
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
    });
    container.appendChild(rc);
  }

  const timings = d.timings || {};
  if (timings.start) {
    const tc = card('Timing', (b) => {
      const base = timings.start;
      const list = [
        ['start', '0 ms'],
        ['upstream connected', timings.upstreamStart ? (timings.upstreamStart - base) + ' ms' : ''],
        ['first byte', timings.firstByte ? (timings.firstByte - base) + ' ms' : ''],
        ['complete', timings.end ? (timings.end - base) + ' ms' : ''],
      ];
      b.appendChild(kv(list));
    });
    container.appendChild(tc);
  }

  const problems = [];
  if (d.error) problems.push(['error', d.error]);
  if (d.patchError) problems.push(['patch_error', d.patchError]);
  if (d.decodeError) problems.push(['decode_error', d.decodeError]);
  if (d.reqDecodeError) problems.push(['request decode', d.reqDecodeError]);
  if (d.resDecodeError) problems.push(['response decode', d.resDecodeError]);
  if (d.resTruncated) problems.push(['note', 'Response body was truncated at the recording cap; decoding may be incomplete.']);
  for (const [k, v] of problems) {
    const banner = el('div', 'banner err');
    banner.textContent = k + ': ' + v;
    container.appendChild(banner);
  }
}

function headersCard(title, headers) {
  return card(title, (b) => {
    if (!headers || !Object.keys(headers).length) {
      b.appendChild(el('div', 'body-empty', '(no headers)'));
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
  });
}

function bodyToolbar(part, d) {
  const toolbar = el('div', 'body-toolbar');
  const seg = el('div', 'seg');
  for (const [mode, label] of [['decoded', 'Decoded'], ['raw', 'Raw'], ['hex', 'Hex']]) {
    const b = el('button', state.bodyMode === mode ? 'active' : '', label);
    b.addEventListener('click', () => { state.bodyMode = mode; renderDetail(); });
    seg.appendChild(b);
  }
  toolbar.appendChild(seg);
  if (part === 'res' && d.resPatched) {
    const seg2 = el('div', 'seg');
    for (const [orig, label] of [[false, 'Patched'], [true, 'Original']]) {
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
  const copyBtn = el('button', 'btn small', 'Copy');
  copyBtn.addEventListener('click', async () => {
    const src = sourceDetail(part);
    const data = part === 'req' ? src.reqData : src.resData;
    copyText(data !== undefined ? JSON.stringify(data, null, 2) : '');
  });
  toolbar.appendChild(copyBtn);
  const dl = el('a', 'btn small', 'Download');
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
  if (!res.ok) throw new Error('Body not available (HTTP ' + res.status + ')');
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
    if (bytes.length > limit) lines.push('… ' + (bytes.length - limit) + ' more bytes');
    out = lines.join('\n');
  } else {
    out = new TextDecoder('utf-8').decode(bytes);
    if (out.length > 400000) out = out.slice(0, 400000) + '\n… (truncated for display)';
  }
  state.bodyCache.set(key, out);
  return out;
}

function renderDecodedBody(container, part) {
  const src = sourceDetail(part);
  if (!src) {
    container.appendChild(el('div', 'body-empty', 'No data yet'));
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
    container.appendChild(el('div', 'body-empty', hasBody ? 'Body is not decodable (use Raw/Hex)' : '(empty body)'));
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

function renderMessage(container, part) {
  const d = state.detail;
  const isReq = part === 'req';
  const headers = isReq ? d.reqHeaders : d.resHeaders;
  container.appendChild(headersCard(isReq ? 'Request headers' : 'Response headers', headers));

  const bodyCard = el('div', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('span', 'title', isReq ? 'Request body' : 'Response body'));
  head.appendChild(el('span', 'spacer'));
  head.appendChild(bodyToolbar(part, d));
  bodyCard.appendChild(head);
  const bodyBox = el('div', 'card-body');
  bodyCard.appendChild(bodyBox);

  if (state.bodyMode === 'decoded') {
    renderDecodedBody(bodyBox, part);
  } else {
    bodyBox.appendChild(el('div', 'body-empty', 'Loading…'));
    fetchBodyText(d, part, state.bodyMode)
      .then((text) => {
        bodyBox.innerHTML = '';
        const pre = el('pre', 'raw' + (state.bodyMode === 'hex' ? ' hex' : ''), text || '(empty)');
        bodyBox.appendChild(pre);
      })
      .catch((e) => {
        bodyBox.innerHTML = '';
        bodyBox.appendChild(el('div', 'banner err', e.message));
      });
  }
  container.appendChild(bodyCard);
}

// --- health / load ---

async function fetchHealth() {
  try {
    state.health = await api('/health');
    setConn(true, 'live');
    els.version.textContent = 'v' + state.health.version;
    state.rulesCount = state.health.rules || 0;
    els.rulesCount.textContent = String(state.rulesCount);
  } catch {
    setConn(false, 'offline');
  }
}

async function initialLoad() {
  try {
    state.info = await api('/info');
    els.proxyAddr.textContent = (state.info.host === '0.0.0.0' ? '<this-machine-ip>' : state.info.host) + ':' + state.info.port;
  } catch {}
  try {
    const flows = await api('/flows');
    state.flows = flows || [];
    renderFlows();
  } catch (e) {
    setConn(false, 'offline');
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
    setConn(true, 'live');
    fetchHealth();
  };
  es.onerror = () => setConn(false, 'reconnecting…');
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
      if (state.listMode === 'tree') ensureTreeVisible(state.flows.find((f) => f.id === state.selectedId));
      renderFlows();
    });
  }
  els.treeExpand.addEventListener('click', () => setAllTreeGroups(true));
  els.treeCollapse.addEventListener('click', () => setAllTreeGroups(false));

  $('#btn-pause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('#btn-pause').classList.toggle('active', state.paused);
    $('#btn-pause').textContent = state.paused ? 'Paused' : 'Pause';
    if (!state.paused) {
      renderFlows();
      fetchHealth();
      if (state.selectedId) scheduleDetail();
    }
  });
  $('#btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all captured flows?')) return;
    try {
      await api('/flows', { method: 'DELETE' });
      state.flows = [];
      state.selectedId = null;
      state.detail = null;
      els.detailBody.classList.add('hidden');
      els.emptyDetail.classList.remove('hidden');
      renderFlows();
      updateHash();
      toast('Flows cleared');
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
wire();
initialLoad();
connectEvents();
setInterval(fetchHealth, 10000);
