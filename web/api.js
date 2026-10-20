// Fetch helpers for the pbmockx control API.

export async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch('/__pbmockx/api' + path, opts);
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {}
    throw new Error(msg);
  }
  if (type.includes('application/json')) return res.json();
  return res.text();
}

export function download(path, filename) {
  const a = document.createElement('a');
  a.href = '/__pbmockx/api' + path;
  a.download = filename || '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
