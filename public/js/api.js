// REST client + session token (kept in localStorage; the server only stores its hash).
const KEY = 'voicely:token';
export const session = {
  get token() { return localStorage.getItem(KEY); },
  set(token) { localStorage.setItem(KEY, token); },
  clear() { localStorage.removeItem(KEY); },
};

export async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return data;
}
