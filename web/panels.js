// Rules manager + certificate/setup panels for the drawer.

import { api } from './api.js';
import { t } from './i18n.js';
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
  if (type === 'patch') return t('rules.typePatch');
  if (type === 'map_local') return t('rules.typeMapLocal');
  if (type === 'map_remote') return t('rules.typeMapRemote');
  return type;
}

/** Compact rules.yaml summary. Field labels mirror the YAML keys on purpose. */
function ruleMeta(r) {
  const bits = [];
  if (r.type === 'patch') {
    bits.push('path: ' + (r.path || ''));
    if (r.action && r.action !== 'set') bits.push('action: ' + r.action + (r.index !== undefined ? ' #' + r.index : ''));
    if (r.action === 'unset') bits.push(t('rules.metaUnset'));
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
    ['patch', t('rules.typeOption.patch')],
    ['map_local', t('rules.typeOption.mapLocal')],
    ['map_remote', t('rules.typeOption.mapRemote')],
  ], presetType || 'patch');
  form.appendChild(labeled(t('rules.fieldType'), typeSel, true));

  const common = el('div', 'form-grid');
  const url = input(t('rules.phUrlPattern'));
  common.appendChild(labeled(t('rules.fieldUrlPattern'), url, true));
  form.appendChild(common);

  const body = el('div');
  form.appendChild(body);

  const build = () => {
    body.innerHTML = '';
    const type = typeSel.value;
    if (type === 'patch') {
      const grid = el('div', 'form-grid');
      const path = input(t('rules.phPath'));
      const action = select([
        ['set', t('rules.action.set')],
        ['append', t('rules.action.append')],
        ['insert', t('rules.action.insert')],
        ['remove', t('rules.action.remove')],
        ['unset', t('rules.action.unset')],
      ], 'set');
      const idx = input(t('rules.phIndex'), '');
      idx.type = 'number';
      const protocol = select([['', t('rules.protocol.both')], ['protobuf', 'protobuf'], ['json', 'json']], '');
      grid.appendChild(labeled(t('rules.fieldPath'), path));
      grid.appendChild(labeled(t('rules.fieldAction'), action));
      grid.appendChild(labeled(t('rules.fieldIndex'), idx));
      grid.appendChild(labeled(t('rules.fieldProtocol'), protocol));
      body.appendChild(grid);
      const value = textarea(t('rules.phValue'), '');
      body.appendChild(labeled(t('rules.fieldValue'), value, true));

      const send = async () => {
        if (!url.value.trim()) throw new Error(t('rules.errUrlPattern'));
        if (!path.value.trim()) throw new Error(t('rules.errPath'));
        const rule = { type: 'patch', url_pattern: url.value.trim(), path: path.value.trim() };
        if (action.value !== 'set') rule.action = action.value;
        if ((action.value === 'insert' || action.value === 'remove') && idx.value !== '') {
          rule.index = parseInt(idx.value, 10);
        }
        if (protocol.value) rule.protocol = protocol.value;
        if (action.value !== 'unset' && action.value !== 'remove') {
          if (!value.value.trim() && action.value === 'set') throw new Error(t('rules.errValue'));
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
      const source = select([['data', t('rules.source.data')], ['file', t('rules.source.file')]], 'data');
      const grid = el('div', 'form-grid');
      grid.appendChild(labeled(t('rules.fieldSource'), source));
      const status = input(t('rules.phStatus'), '');
      status.type = 'number';
      grid.appendChild(labeled(t('rules.fieldStatus'), status));
      const desc = input(t('rules.phDesc'));
      const mt = input(t('rules.phMessageType'));
      grid.appendChild(labeled(t('rules.fieldDesc'), desc));
      grid.appendChild(labeled(t('rules.fieldMessageType'), mt));
      body.appendChild(grid);

      const dataBox = textarea(t('rules.phMockData'), '{\n  \n}');
      const fileBox = input(t('rules.phFilePath'));
      const dataWrap = labeled(t('rules.fieldMockData'), dataBox, true);
      const fileWrap = labeled(t('rules.fieldFilePath'), fileBox, true);
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
        if (!url.value.trim()) throw new Error(t('rules.errUrlPattern'));
        const rule = { type: 'map_local', url_pattern: url.value.trim(), source: source.value };
        if (source.value === 'data') {
          try { rule.data = JSON.parse(dataBox.value); }
          catch (e) { throw new Error(t('rules.errMockJson', { msg: e.message })); }
        } else {
          if (!fileBox.value.trim()) throw new Error(t('rules.errFile'));
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
    const replacement = input(t('rules.phReplacement'));
    const regex = document.createElement('input');
    regex.type = 'checkbox';
    const regexWrap = el('label', '', t('rules.regexLabel'));
    regexWrap.prepend(regex);
    regexWrap.style.display = 'flex';
    regexWrap.style.alignItems = 'center';
    regexWrap.style.gap = '6px';
    grid.appendChild(labeled(t('rules.fieldReplacement'), replacement, true));
    body.appendChild(grid);
    body.appendChild(regexWrap);

    return async () => {
      if (!url.value.trim() || !replacement.value.trim()) throw new Error(t('rules.errUrlReplacement'));
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
    title: t('rules.addTitle'),
    body: form,
    footer: [
      { label: t('common.cancel'), onClick: () => ctx.closeModal() },
      {
        label: t('rules.addSubmit'), primary: true,
        onClick: async () => {
          try {
            await submit();
            ctx.closeModal();
            ctx.toast(t('rules.added'));
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
    title: t('rules.editTitle', { file }),
    body: box,
    footer: [
      { label: t('common.cancel'), onClick: () => ctx.closeModal() },
      {
        label: t('common.save'), primary: true,
        onClick: async () => {
          try {
            JSON.parse(box.value);
            await api('/mock-data/' + encodeURIComponent(file), { method: 'PUT', body: { content: box.value } });
            ctx.closeModal();
            ctx.toast(t('rules.mockSaved'));
          } catch (e) {
            ctx.toast(t('rules.invalidJson', { msg: e.message }), true);
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
  const addBtn = el('button', 'btn primary small', t('rules.add'));
  addBtn.addEventListener('click', () => ruleForm(ctx));
  bar.appendChild(addBtn);
  const saveBtn = el('button', 'btn small', t('common.save'));
  saveBtn.addEventListener('click', async () => {
    try { await api('/rules/save', { method: 'POST', body: {} }); ctx.toast(t('rules.saved')); }
    catch (e) { ctx.toast(e.message, true); }
  });
  const reloadBtn = el('button', 'btn small', t('common.reload'));
  reloadBtn.addEventListener('click', async () => {
    try {
      const r = await api('/rules/reload', { method: 'POST', body: {} });
      ctx.toast(t('rules.reloaded', { n: r.reloaded }));
      ctx.refreshRules();
    } catch (e) { ctx.toast(e.message, true); }
  });
  bar.appendChild(saveBtn);
  bar.appendChild(reloadBtn);
  head.appendChild(bar);
  container.appendChild(head);

  if (!rules.length) {
    container.appendChild(el('div', 'body-empty', t('rules.empty')));
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
      toggle.title = r.enabled === false ? t('rules.enable') : t('rules.disable');
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
        edit.title = t('rules.editMock');
        edit.addEventListener('click', () => editMockData(ctx, r.data_file));
        actions.appendChild(edit);
      }
      const del = el('button', 'icon-btn danger', '✕');
      del.title = t('rules.delete');
      del.addEventListener('click', async () => {
        if (!confirm(t('rules.deleteConfirm', { id: r.id }))) return;
        try {
          await api('/rules/' + encodeURIComponent(r.id), { method: 'DELETE' });
          ctx.toast(t('rules.deleted'));
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
  ph.appendChild(el('span', 'title', t('setup.proxy')));
  proxy.appendChild(ph);
  const pb = el('div', 'card-body');
  pb.appendChild(el('div', 'note', t('setup.proxyNote')));
  const row = el('div', 'copy-row');
  const lanHost = info.lanAddresses && info.lanAddresses[0];
  const shownHost = (info.host === '0.0.0.0' || info.host === '::')
    ? (lanHost || t('setup.thisMachineIp'))
    : (info.host || '127.0.0.1');
  const addr = el('code', '', shownHost + ':' + (info.port || ''));
  row.appendChild(addr);
  const copyBtn = el('button', 'btn small', t('common.copy'));
  copyBtn.addEventListener('click', () => ctx.copy(addr.textContent));
  row.appendChild(copyBtn);
  pb.appendChild(row);
  if (info.host === '0.0.0.0' || info.host === '::') {
    pb.appendChild(el('div', 'note', t('setup.lanNote')));
    if (info.lanAddresses && info.lanAddresses.length > 1) {
      pb.appendChild(el('div', 'note', t('setup.otherAddresses', { list: info.lanAddresses.slice(1).join(', ') })));
    }
    if (info.ui && info.ui.lanAccess === false) {
      pb.appendChild(el('div', 'banner warn', t('setup.lanUiDisabled')));
    }
  }
  proxy.appendChild(pb);
  container.appendChild(proxy);

  // Why some connections never reach the flow list — visible without guesswork.
  const px = info.proxy || {};
  const scope = el('div', 'section card');
  const sh = el('div', 'card-head');
  sh.appendChild(el('span', 'title', t('setup.notDecrypted')));
  scope.appendChild(sh);
  const sb = el('div', 'card-body');
  sb.appendChild(el('div', 'note', t('setup.notDecryptedNote')));
  const lines = [];
  lines.push([t('setup.mitm'), px.mitm === false ? t('setup.mitmOff') : t('setup.enabled')]);
  const ports = px.mitmPorts || [];
  lines.push([t('setup.ports'), ports.length ? ports.join(', ') : t('setup.allPorts')]);
  const bypass = px.bypass || [];
  lines.push([t('setup.bypass'), bypass.length ? bypass.join(', ') : t('setup.none')]);
  lines.push([t('setup.tunnelRecords'), px.recordTunnels === false ? t('setup.tunnelRecordsOff') : t('setup.on')]);
  const grid = el('div', 'kv');
  for (const [k, v] of lines) {
    grid.appendChild(el('div', 'k', k));
    grid.appendChild(el('div', 'v', v));
  }
  sb.appendChild(grid);
  scope.appendChild(sb);
  container.appendChild(scope);

  const caCard = el('div', 'section card');
  const ch = el('div', 'card-head');
  ch.appendChild(el('span', 'title', t('setup.ca')));
  caCard.appendChild(ch);
  const cb = el('div', 'card-body');
  if (ca.path) {
    const kv = el('div', 'kv');
    const add = (k, v, cls) => {
      kv.appendChild(el('div', 'k', k));
      kv.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
    };
    add(t('setup.file'), ca.path);
    add(t('setup.subject'), ca.subject || '');
    add(t('setup.sha256'), ca.fingerprint256 || '', 'ca-fingerprint');
    add(t('setup.androidHash'), ca.subjectHashOld || '');
    add(t('setup.valid'), (ca.notBefore || '') + ' → ' + (ca.notAfter || ''));
    cb.appendChild(kv);
    const dl = el('button', 'btn primary small', t('setup.downloadCa'));
    dl.addEventListener('click', () => { window.location.href = '/__pbmockx/api/ca.pem'; });
    const copyPath = el('button', 'btn small', t('setup.copyPath'));
    copyPath.addEventListener('click', () => ctx.copy(ca.path));
    const actions = el('div', 'copy-row');
    actions.appendChild(dl);
    actions.appendChild(copyPath);
    cb.appendChild(actions);
    cb.appendChild(el('div', 'note', t('setup.caTrustNote')));
  } else {
    cb.appendChild(el('div', 'banner warn', t('setup.caMissing')));
  }
  caCard.appendChild(cb);
  container.appendChild(caCard);

  const mac = el('div', 'section card');
  const mh = el('div', 'card-head');
  mh.appendChild(el('span', 'title', t('setup.installCa')));
  mac.appendChild(mh);
  const mb = el('div', 'card-body');
  // Platform names stay untranslated (the macOS details block defaults open).
  // The steps contain authored <code>/<b> markup from the catalogs.
  const details = (title, keys) => {
    const d = document.createElement('details');
    d.open = title.startsWith('macOS');
    const s = document.createElement('summary');
    s.textContent = title;
    s.style.cursor = 'pointer';
    s.style.fontWeight = '600';
    d.appendChild(s);
    const ol = el('ol', 'steps');
    for (const key of keys) {
      const li = document.createElement('li');
      li.innerHTML = t(key);
      ol.appendChild(li);
    }
    d.appendChild(ol);
    return d;
  };
  mb.appendChild(details('macOS', ['setup.stepMac1', 'setup.stepMac2', 'setup.stepMac3']));
  mb.appendChild(details('Windows', ['setup.stepWin1']));
  mb.appendChild(details('Linux', ['setup.stepLinux1', 'setup.stepLinux2']));
  mb.appendChild(details('Android', ['setup.stepAndroid1', 'setup.stepAndroid2', 'setup.stepAndroid3']));
  mac.appendChild(mb);
  container.appendChild(mac);

  const data = el('div', 'section card');
  const dh = el('div', 'card-head');
  dh.appendChild(el('span', 'title', t('setup.dataLimits')));
  data.appendChild(dh);
  const db = el('div', 'card-body');
  const kv = el('div', 'kv');
  const add = (k, v) => { kv.appendChild(el('div', 'k', k)); kv.appendChild(el('div', 'v', v)); };
  add(t('setup.dataDir'), info.dataDir || '');
  add(t('setup.rulesFile'), info.rulesFile || '');
  add(t('setup.mockData'), info.mockDataDir || '');
  const cap = info.capture || {};
  add(t('setup.maxFlows'), String(cap.maxFlows || ''));
  add(t('setup.recordBodyCap'), fmtBytes(cap.maxRecordBodyBytes || 0));
  add(t('setup.totalRecordCap'), fmtBytes(cap.maxTotalRecordBytes || 0));
  add(t('setup.rewriteBodyCap'), fmtBytes(cap.maxRewriteBodyBytes || 0));
  db.appendChild(kv);
  data.appendChild(db);
  container.appendChild(data);
}
