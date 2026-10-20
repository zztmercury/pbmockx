// Interactive renderers for protobuf field trees and JSON values.
// Zero dependencies; children are built lazily to keep large payloads fast.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

function typeLabel(f) {
  if (f.kind === 'any') return 'Any' + (f.anyType ? ' → ' + f.anyType : '');
  if (f.kind === 'repeated') return 'repeated ' + (f.type || '');
  if (f.kind === 'map') return 'map ' + (f.type || '');
  if (f.kind === 'bytes') return 'bytes, ' + (f.rawValue || 0) + 'B';
  if (f.kind === 'enum') return 'enum ' + (f.type || '');
  return f.type || f.kind;
}

function hasChildren(f) {
  return (f.fields && f.fields.length) || (f.items && f.items.length);
}

function childNodes(f) {
  if (f.fields) return f.fields;
  if (f.items) return f.items;
  return [];
}

function renderField(f, depth, initialExpanded) {
  const node = el('div', 'tree-node');
  const row = el('div', 'tree-row');
  const tw = el('span', 'tw');
  row.appendChild(tw);

  const name = el('span', 'fname', f.name);
  row.appendChild(name);
  if (typeof f.name === 'string' && !f.name.startsWith('[')) {
    row.appendChild(el('span', 'fnum', '#' + f.id));
  }
  row.appendChild(el('span', 'ftype', '(' + typeLabel(f) + ')'));

  if (f.kind === 'scalar') {
    if (f.value === null || f.value === undefined) {
      row.appendChild(el('span', 'unset', '(unset)'));
    } else if (typeof f.value === 'string') {
      row.appendChild(el('span', 'fval str', '= ' + JSON.stringify(f.value)));
    } else if (typeof f.value === 'boolean') {
      row.appendChild(el('span', 'fval enum', '= ' + f.value));
    } else {
      row.appendChild(el('span', 'fval num', '= ' + String(f.value)));
    }
  } else if (f.kind === 'enum') {
    if (f.rawValue === null || f.rawValue === undefined) {
      row.appendChild(el('span', 'unset', '(unset)'));
    } else {
      row.appendChild(el('span', 'fval enum', '= ' + f.rawValue + (f.value && f.value !== f.rawValue ? ' (' + f.value + ')' : '')));
    }
  } else if (f.kind === 'bytes') {
    if (!f.value) row.appendChild(el('span', 'unset', '(unset)'));
    else row.appendChild(el('span', 'fval bytes', '= ' + f.value.slice(0, 72) + (f.value.length > 72 ? '…' : '') + ' (' + (f.rawValue || 0) + 'B)'));
  } else if (f.kind === 'message') {
    if (!hasChildren(f)) row.appendChild(el('span', 'unset', '(unset)'));
  } else if (f.kind === 'any') {
    if (!hasChildren(f)) row.appendChild(el('span', 'unset', '(unset)'));
  } else if (f.kind === 'repeated' || f.kind === 'map') {
    const n = (f.items || []).length;
    row.appendChild(el('span', 'fval num', '= ' + n + (f.kind === 'map' ? ' entries' : ' items')));
  }

  node.appendChild(row);
  const children = childNodes(f);
  if (children.length) {
    node.classList.add('expandable');
    const box = el('div', 'tree-children');
    node.appendChild(box);
    let built = false;
    const setOpen = (open) => {
      node.classList.toggle('expanded', open);
      node.classList.toggle('collapsed', !open);
      if (open && !built) {
        built = true;
        for (const c of children) box.appendChild(renderField(c, depth + 1, false));
      }
    };
    // Auto-expand at the top level, but not enormous lists: keep first paint
    // cheap and let the user expand a 10k-item array explicitly.
    setOpen(initialExpanded && children.length <= 100);
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!node.classList.contains('expanded'));
    });
  } else {
    node.classList.add('leaf');
  }
  return node;
}

export function renderPbTree(container, tree) {
  container.innerHTML = '';
  const wrap = el('div', 'tree');
  const trees = Array.isArray(tree) ? tree : [tree];
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    if (!t) continue;
    wrap.appendChild(el('div', 'msg-head', t.messageType || (Array.isArray(tree) ? 'message[' + i + ']' : 'message')));
    const fields = t.fields || [];
    if (!fields.length) {
      wrap.appendChild(el('div', 'body-empty', 'empty message'));
      continue;
    }
    for (const f of fields) wrap.appendChild(renderField(f, 0, true));
  }
  container.appendChild(wrap);
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function primitiveSpan(v) {
  if (v === null) return el('span', 'jnull', 'null');
  if (typeof v === 'string') return el('span', 'jstr', JSON.stringify(v));
  if (typeof v === 'number') return el('span', 'jnum', String(v));
  if (typeof v === 'boolean') return el('span', 'jbool', String(v));
  return el('span', '', String(v));
}

function renderJsonNode(key, value, depth, initialExpanded) {
  const node = el('div', 'json-tree');
  const row = el('div', 'jrow');
  const tw = el('span', 'tw');
  row.appendChild(tw);
  if (key !== null) {
    row.appendChild(el('span', 'jkey', Array.isArray(value) ? key + ': ' : key + ': '));
  }
  const isObj = value && typeof value === 'object';
  if (!isObj) {
    row.appendChild(primitiveSpan(value));
  } else if (Array.isArray(value)) {
    row.appendChild(el('span', 'jnull', '[' + value.length + ']'));
  } else {
    const keys = Object.keys(value);
    row.appendChild(el('span', 'jnull', '{' + keys.length + '}'));
  }
  node.appendChild(row);

  if (isObj) {
    node.classList.add('expandable');
    const box = el('div', 'jchildren');
    node.appendChild(box);
    let built = false;
    const setOpen = (open) => {
      node.classList.toggle('jexpanded', open);
      node.classList.toggle('jcollapsed', !open);
      if (open && !built) {
        built = true;
        const entries = Array.isArray(value)
          ? value.map((v, i) => [String(i), v])
          : Object.entries(value);
        for (const [k, v] of entries) box.appendChild(renderJsonNode(k, v, depth + 1, depth < 1));
      }
    };
    const entryCount = Array.isArray(value) ? value.length : Object.keys(value).length;
    setOpen(initialExpanded && entryCount <= 100);
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!node.classList.contains('jexpanded'));
    });
  }
  return node;
}

export function renderJsonTree(container, value) {
  container.innerHTML = '';
  if (value === null || value === undefined) {
    container.appendChild(el('div', 'body-empty', '(empty)'));
    return;
  }
  if (typeof value !== 'object') {
    container.appendChild(primitiveSpan(value));
    return;
  }
  const wrap = el('div', 'json-tree');
  wrap.appendChild(renderJsonNode(null, value, 0, true));
  container.appendChild(wrap);
}
