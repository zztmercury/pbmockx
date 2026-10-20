// Rules manager + certificate/setup panels for the drawer.

import { api } from './api.js';
import { el, fmtBytes } from './tree.js';

function labeled(labelText, control, wide) {
  const f = el('div', 'field' + (wide ? ' wide' : ''));
  f.appendChild(el('label', '', labelText));
  f.appendChild(control);
  return f;
}

function input(placeholder, value) {
  const i = document.createElement('input');
  i.placeholder = placeholder || '';
  if (value !== undefined) i.value = value;
  return i;
}

function select(options, value) {
  const s = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    if (v === value) o.selected = true;
    s.appendChild(o);
  }
  return s;
}

function textarea(placeholder, value) {
  const t = document.createElement('textarea');
  t.placeholder = placeholder || '';
  t.spellcheck = false;
  if (value !== undefined) t.value = value;
  return t;
}

function ruleTypeLabel(type) {
  return type === 'patch' ? 'Patch' : type === 'map_local' ? 'Map local' : type === 'map_remote' ? 'Map remote' : type;
}

function ruleMeta(r) {
  const bits = [];
  if (r.type === 'patch') {
    bits.push('path: ' + (r.path || ''));
    if (r.action && r.action !== 'set') bits.push('action: ' + r.action + (r.index !== undefined ? ' #' + r.index : ''));
    if (r.action === 'unset') bits.push('value: (unset)');
    else if (r.value !== undefined) bits.push('value: ' + JSON.stringify(r.value));
    if (r.protocol) bits.push('protocol: ' + r.protocol);
  } else if (r.type === 'map_local') {
    bits.push('source: ' + (r.source || 'file'));
    if (r.source === 'file') bits.push('file: ' + (r.file_path || ''));
    else bits.push('data: ' + (r.data_file || 'inline'));
    if (r.status) bits.push('status: ' + r.status);
    if (r.messageType) bits.push('type: ' + r.messageType);
  } else if (r.type === 'map_remote') {
    bits.push('→ ' + (r.replacement || ''));
    if (r.is_regex) bits.push('regex');
  }
  return bits.join('  ·  ');
}

async function ruleForm(ctx, presetType) {
  const form = el('div');
  const typeSel = select([
    ['patch', 'Patch — modify a response field'],
    ['map_local', 'Map local — replace the whole response'],
    ['map_remote', 'Map remote — rewrite the request URL'],
  ], presetType || 'patch');
  form.appendChild(labeled('Rule type', typeSel, true));

  const common = el('div', 'form-grid');
  const url = input('URL regex, e.g. api/game');
  common.appendChild(labeled('URL pattern (regex)', url, true));
  form.appendChild(common);

  const body = el('div');
  form.appendChild(body);

  const build = () => {
    body.innerHTML = '';
    const type = typeSel.value;
    if (type === 'patch') {
      const grid = el('div', 'form-grid');
      const path = input('field path, e.g. game.name');
      const action = select([['set', 'set (replace)'], ['append', 'append'], ['insert', 'insert'], ['remove', 'remove'], ['unset', 'unset (delete key)']], 'set');
      const idx = input('index (insert/remove)', '');
      idx.type = 'number';
      const protocol = select([['', 'both'], ['protobuf', 'protobuf'], ['json', 'json']], '');
      grid.appendChild(labeled('Path', path));
      grid.appendChild(labeled('Action', action));
      grid.appendChild(labeled('Index (optional)', idx));
      grid.appendChild(labeled('Protocol (optional)', protocol));
      body.appendChild(grid);
      const value = textarea('Value as JSON, e.g. "Mocked" / 999 / {"k":"v"} / false', '');
      body.appendChild(labeled('Value', value, true));

      const send = async () => {
        if (!url.value.trim()) throw new Error('URL pattern is required');
        if (!path.value.trim()) throw new Error('Path is required');
        const rule = { type: 'patch', url_pattern: url.value.trim(), path: path.value.trim() };
        if (action.value !== 'set') rule.action = action.value;
        if ((action.value === 'insert' || action.value === 'remove') && idx.value !== '') {
          rule.index = parseInt(idx.value, 10);
        }
        if (protocol.value) rule.protocol = protocol.value;
        if (action.value !== 'unset' && action.value !== 'remove') {
          if (!value.value.trim() && action.value === 'set') throw new Error('Value is required for set');
          if (value.value.trim()) {
            try { rule.value = JSON.parse(value.value); }
            catch { rule.value = value.value; }
          }
        }
        await api('/rules', { method: 'POST', body: rule });
      };
      return send;
    }

    if (type === 'map_local') {
      const source = select([['data', 'data — JSON encoded to protobuf'], ['file', 'file — serve local bytes']], 'data');
      const grid = el('div', 'form-grid');
      grid.appendChild(labeled('Source', source));
      const status = input('status code override, e.g. 200', '');
      status.type = 'number';
      grid.appendChild(labeled('Status (optional)', status));
      const desc = input('desc URL (optional for PB)');
      const mt = input('messageType (optional for PB)');
      grid.appendChild(labeled('desc (optional)', desc));
      grid.appendChild(labeled('messageType (optional)', mt));
      body.appendChild(grid);

      const dataBox = textarea('JSON body, e.g. {"game":{"name":"Mocked"}}', '{\n  \n}');
      const fileBox = input('/absolute/path/to/mock.bin');
      const dataWrap = labeled('Mock data (JSON)', dataBox, true);
      const fileWrap = labeled('Local file path', fileBox, true);
      body.appendChild(dataWrap);
      body.appendChild(fileWrap);
      const syncSource = () => {
        const isData = source.value === 'data';
        dataWrap.style.display = isData ? '' : 'none';
        fileWrap.style.display = isData ? 'none' : '';
      };
      source.addEventListener('change', syncSource);
      syncSource();

      return async () => {
        if (!url.value.trim()) throw new Error('URL pattern is required');
        const rule = { type: 'map_local', url_pattern: url.value.trim(), source: source.value };
        if (source.value === 'data') {
          try { rule.data = JSON.parse(dataBox.value); }
          catch (e) { throw new Error('Mock data must be valid JSON: ' + e.message); }
        } else {
          if (!fileBox.value.trim()) throw new Error('File path is required');
          rule.file_path = fileBox.value.trim();
        }
        if (status.value) rule.status = parseInt(status.value, 10);
        if (desc.value.trim()) rule.desc = desc.value.trim();
        if (mt.value.trim()) rule.messageType = mt.value.trim();
        await api('/map-local', { method: 'POST', body: rule });
      };
    }

    // map_remote
    const grid = el('div', 'form-grid');
    const replacement = input('https://new.example.com/path or 127.0.0.1:9101/path');
    const regex = document.createElement('input');
    regex.type = 'checkbox';
    const regexWrap = el('label', '', 'Treat replacement as a regex');
    regexWrap.prepend(regex);
    regexWrap.style.display = 'flex';
    regexWrap.style.alignItems = 'center';
    regexWrap.style.gap = '6px';
    grid.appendChild(labeled('Replacement', replacement, true));
    body.appendChild(grid);
    body.appendChild(regexWrap);

    return async () => {
      if (!url.value.trim() || !replacement.value.trim()) throw new Error('URL and replacement are required');
      await api('/rules', {
        method: 'POST',
        body: {
          type: 'map_remote',
          url_pattern: url.value.trim(),
          replacement: replacement.value.trim(),
          is_regex: regex.checked,
        },
      });
    };
  };

  let submit = build();
  typeSel.addEventListener('change', () => { submit = build(); });

  ctx.openModal({
    title: 'Add mock rule',
    body: form,
    footer: [
      { label: 'Cancel', onClick: () => ctx.closeModal() },
      {
        label: 'Add rule', primary: true,
        onClick: async () => {
          try {
            await submit();
            ctx.closeModal();
            ctx.toast('Rule added');
            ctx.refreshRules();
          } catch (e) {
            ctx.toast(e.message, true);
          }
        },
      },
    ],
  });
}

async function editMockData(ctx, file) {
  let content = '';
  try {
    const r = await api('/mock-data/' + encodeURIComponent(file));
    content = r.content;
  } catch (e) {
    ctx.toast(e.message, true);
    return;
  }
  const box = textarea('', content);
  box.style.minHeight = '300px';
  ctx.openModal({
    title: 'Edit ' + file,
    body: box,
    footer: [
      { label: 'Cancel', onClick: () => ctx.closeModal() },
      {
        label: 'Save', primary: true,
        onClick: async () => {
          try {
            JSON.parse(box.value);
            await api('/mock-data/' + encodeURIComponent(file), { method: 'PUT', body: { content: box.value } });
            ctx.closeModal();
            ctx.toast('Mock data saved');
          } catch (e) {
            ctx.toast('Invalid JSON: ' + e.message, true);
          }
        },
      },
    ],
  });
}

export async function renderRulesPanel(container, ctx) {
  container.innerHTML = '';
  let rules = [];
  try { rules = await api('/rules'); } catch (e) { container.appendChild(el('div', 'banner err', e.message)); return; }
  ctx.onRulesCount && ctx.onRulesCount(rules.length);

  const head = el('div', 'section');
  const bar = el('div', 'copy-row');
  const addBtn = el('button', 'btn primary small', '+ Add rule');
  addBtn.addEventListener('click', () => ruleForm(ctx));
  bar.appendChild(addBtn);
  const saveBtn = el('button', 'btn small', 'Save');
  saveBtn.addEventListener('click', async () => {
    try { await api('/rules/save', { method: 'POST', body: {} }); ctx.toast('rules.yaml saved'); }
    catch (e) { ctx.toast(e.message, true); }
  });
  const reloadBtn = el('button', 'btn small', 'Reload');
  reloadBtn.addEventListener('click', async () => {
    try {
      const r = await api('/rules/reload', { method: 'POST', body: {} });
      ctx.toast('Reloaded ' + r.reloaded + ' rules');
      ctx.refreshRules();
    } catch (e) { ctx.toast(e.message, true); }
  });
  bar.appendChild(saveBtn);
  bar.appendChild(reloadBtn);
  head.appendChild(bar);
  container.appendChild(head);

  if (!rules.length) {
    container.appendChild(el('div', 'body-empty', 'No rules yet. Add a patch rule to modify a response field.'));
    return;
  }

  for (const type of ['patch', 'map_local', 'map_remote']) {
    const items = rules.filter((r) => r.type === type);
    if (!items.length) continue;
    const group = el('div', 'rule-group');
    const gh = el('div', 'rule-group-head');
    gh.appendChild(el('h3', '', ruleTypeLabel(type)));
    gh.appendChild(el('span', 'pill', String(items.length)));
    group.appendChild(gh);

    for (const r of items) {
      const row = el('div', 'rule-row' + (r.enabled === false ? ' disabled' : ''));
      const main = el('div');
      main.appendChild(el('div', 'rule-url', r.url_pattern || ''));
      main.appendChild(el('div', 'rule-meta', ruleMeta(r)));
      row.appendChild(main);

      const actions = el('div', 'rule-actions');
      const toggle = el('button', 'icon-btn', r.enabled === false ? '○' : '●');
      toggle.title = r.enabled === false ? 'Enable rule' : 'Disable rule';
      toggle.addEventListener('click', async () => {
        try {
          await api('/rules/' + encodeURIComponent(r.id) + '/enabled', {
            method: 'POST', body: { enabled: r.enabled === false },
          });
          ctx.refreshRules();
        } catch (e) { ctx.toast(e.message, true); }
      });
      actions.appendChild(toggle);
      if (r.data_file) {
        const edit = el('button', 'icon-btn', '✎');
        edit.title = 'Edit mock data';
        edit.addEventListener('click', () => editMockData(ctx, r.data_file));
        actions.appendChild(edit);
      }
      const del = el('button', 'icon-btn danger', '✕');
      del.title = 'Delete rule';
      del.addEventListener('click', async () => {
        if (!confirm('Delete rule ' + r.id + '?')) return;
        try {
          await api('/rules/' + encodeURIComponent(r.id), { method: 'DELETE' });
          ctx.toast('Rule deleted');
          ctx.refreshRules();
        } catch (e) { ctx.toast(e.message, true); }
      });
      actions.appendChild(del);
      row.appendChild(actions);
      group.appendChild(row);
    }
    container.appendChild(group);
  }
}

export async function renderSetupPanel(container, ctx) {
  container.innerHTML = '';
  const info = ctx.info || {};
  const ca = ctx.ca || {};

  const proxy = el('div', 'section card');
  const ph = el('div', 'card-head');
  ph.appendChild(el('span', 'title', 'Proxy'));
  proxy.appendChild(ph);
  const pb = el('div', 'card-body');
  pb.appendChild(el('div', 'note', 'Point your device/browser HTTP proxy at this address. HTTPS is captured via a local CA.'));
  const row = el('div', 'copy-row');
  const lanHost = info.lanAddresses && info.lanAddresses[0];
  const shownHost = (info.host === '0.0.0.0' || info.host === '::')
    ? (lanHost || '<this-machine-ip>')
    : (info.host || '127.0.0.1');
  const addr = el('code', '', shownHost + ':' + (info.port || ''));
  row.appendChild(addr);
  const copyBtn = el('button', 'btn small', 'Copy');
  copyBtn.addEventListener('click', () => ctx.copy(addr.textContent));
  row.appendChild(copyBtn);
  pb.appendChild(row);
  if (info.host === '0.0.0.0' || info.host === '::') {
    pb.appendChild(el('div', 'note', 'Bound to 0.0.0.0 — devices on the same LAN can use this proxy and open the UI. Only do this on trusted networks.'));
    if (info.lanAddresses && info.lanAddresses.length > 1) {
      pb.appendChild(el('div', 'note', 'Other addresses: ' + info.lanAddresses.slice(1).join(', ')));
    }
    if (info.ui && info.ui.lanAccess === false) {
      pb.appendChild(el('div', 'banner warn', 'LAN UI access is disabled (ui.lanAccess=false); the proxy is reachable but the UI/API are loopback-only.'));
    }
  }
  proxy.appendChild(pb);
  container.appendChild(proxy);

  const caCard = el('div', 'section card');
  const ch = el('div', 'card-head');
  ch.appendChild(el('span', 'title', 'Certificate authority'));
  caCard.appendChild(ch);
  const cb = el('div', 'card-body');
  if (ca.path) {
    const kv = el('div', 'kv');
    const add = (k, v, cls) => {
      kv.appendChild(el('div', 'k', k));
      kv.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
    };
    add('File', ca.path);
    add('Subject', ca.subject || '');
    add('SHA-256', ca.fingerprint256 || '', 'ca-fingerprint');
    add('Android hash', ca.subjectHashOld || '');
    add('Valid', (ca.notBefore || '') + ' → ' + (ca.notAfter || ''));
    cb.appendChild(kv);
    const dl = el('button', 'btn primary small', 'Download CA (.crt)');
    dl.addEventListener('click', () => { window.location.href = '/__pbmockx/api/ca.pem'; });
    const copyPath = el('button', 'btn small', 'Copy path');
    copyPath.addEventListener('click', () => ctx.copy(ca.path));
    const actions = el('div', 'copy-row');
    actions.appendChild(dl);
    actions.appendChild(copyPath);
    cb.appendChild(actions);
    cb.appendChild(el('div', 'note', 'Trust this CA on any device whose HTTPS traffic you want to inspect. Remove it when you are done.'));
  } else {
    cb.appendChild(el('div', 'banner warn', 'CA not available yet. Start the daemon first: pbmockx start'));
  }
  caCard.appendChild(cb);
  container.appendChild(caCard);

  const mac = el('div', 'section card');
  const mh = el('div', 'card-head');
  mh.appendChild(el('span', 'title', 'Install the CA'));
  mac.appendChild(mh);
  const mb = el('div', 'card-body');
  const details = (title, lines) => {
    const d = document.createElement('details');
    d.open = title.startsWith('macOS');
    const s = document.createElement('summary');
    s.textContent = title;
    s.style.cursor = 'pointer';
    s.style.fontWeight = '600';
    d.appendChild(s);
    const ol = el('ol', 'steps');
    for (const line of lines) {
      const li = document.createElement('li');
      li.innerHTML = line;
      ol.appendChild(li);
    }
    d.appendChild(ol);
    return d;
  };
  mb.appendChild(details('macOS', [
    'Download the CA (.crt) above.',
    'Open <code>pbmockx-ca.crt</code> in Keychain Access → System → <b>Always Trust</b>.',
    'Or: <code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain pbmockx-ca.crt</code>',
  ]));
  mb.appendChild(details('Windows', [
    'Download the CA, then run <code>certutil -addstore -f "ROOT" pbmockx-ca.crt</code> as Administrator.',
  ]));
  mb.appendChild(details('Linux', [
    '<code>sudo cp pbmockx-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</code>',
    'For Chrome/Electron apps, also import it under Settings → Privacy → Manage certificates → Authorities.',
  ]));
  mb.appendChild(details('Android', [
    'Enable USB debugging, then run <code>pbmockx connect-android</code> to set <code>adb reverse</code> + <code>http_proxy</code>.',
    'User certificates are not trusted by apps targeting Android 7+ — install as a system cert (root / Magisk) or use an emulator.',
    'Download URL: <code>/__pbmockx/api/ca.pem</code>',
  ]));
  mac.appendChild(mb);
  container.appendChild(mac);

  const data = el('div', 'section card');
  const dh = el('div', 'card-head');
  dh.appendChild(el('span', 'title', 'Data & limits'));
  data.appendChild(dh);
  const db = el('div', 'card-body');
  const kv = el('div', 'kv');
  const add = (k, v) => { kv.appendChild(el('div', 'k', k)); kv.appendChild(el('div', 'v', v)); };
  add('Data directory', info.dataDir || '');
  add('rules.yaml', info.rulesFile || '');
  add('mock-data', info.mockDataDir || '');
  const cap = info.capture || {};
  add('max flows', String(cap.maxFlows || ''));
  add('record body cap', fmtBytes(cap.maxRecordBodyBytes || 0));
  add('total record cap', fmtBytes(cap.maxTotalRecordBytes || 0));
  add('rewrite body cap', fmtBytes(cap.maxRewriteBodyBytes || 0));
  db.appendChild(kv);
  data.appendChild(db);
  container.appendChild(data);
}
