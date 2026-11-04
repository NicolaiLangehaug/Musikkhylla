// Lagring: data/db.json i GitHub-repoet. Skriving går via GitHubs API med en
// personlig nøkkel som bare ligger i denne nettleseren (localStorage).

const API = 'https://api.github.com';
const DB_PATH = 'db.json';
const SETTINGS_KEY = 'matboksen.settings';

const DEFAULTS = { owner: 'NicolaiLangehaug', repo: 'Matboksen', branch: 'main', token: '', login: '' };

export function settings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* privat modus o.l. */ }
  return next;
}

export const hasToken = () => !!settings().token;

// ---------- base64 <-> UTF-8 / bytes ----------
function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
const textToB64 = (s) => bytesToB64(new TextEncoder().encode(s));
const b64ToText = (b64) => {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

// ---------- GitHub API ----------
export class StoreError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function gh(path, { method = 'GET', body, accept } = {}) {
  const s = settings();
  const res = await fetch(`${API}/repos/${s.owner}/${s.repo}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Accept: accept || 'application/vnd.github+json',
      Authorization: `Bearer ${s.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

const WRITE_HELP = 'Nøkkelen har ikke lov til å lagre i Matboksen. Rediger nøkkelen på GitHub: velg «Only select repositories» → Matboksen, og sett Contents til «Read and write».';

function explain(res, writing = false) {
  if (res.status === 401) return 'Nøkkelen er ugyldig eller utløpt. Lag en ny og lim den inn under Innstillinger.';
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return 'GitHub sin grense for antall forespørsler er nådd. Vent litt og prøv igjen.';
  }
  if (res.status === 403) return writing ? WRITE_HELP : 'Nøkkelen har ikke tilgang til Matboksen. ' + WRITE_HELP;
  if (res.status === 404) return writing ? WRITE_HELP : 'Fant ikke repoet eller filen. Sjekk eier, repo og gren i Innstillinger, og at nøkkelen gjelder Matboksen.';
  return `GitHub svarte ${res.status}.`;
}

async function readRemote() {
  const s = settings();
  const res = await gh(`/contents/${DB_PATH}?ref=${encodeURIComponent(s.branch)}`);
  if (!res.ok) throw new StoreError(explain(res), res.status);
  const meta = await res.json();
  let text;
  if (meta.content) {
    text = b64ToText(meta.content);
  } else {
    // Filer over 1 MB kommer uten innhold; hent rått.
    const raw = await gh(`/contents/${DB_PATH}?ref=${encodeURIComponent(s.branch)}`, { accept: 'application/vnd.github.raw+json' });
    if (!raw.ok) throw new StoreError(explain(raw), raw.status);
    text = await raw.text();
  }
  return { db: normalize(JSON.parse(text)), sha: meta.sha };
}

function normalize(db) {
  for (const k of ['units', 'ingredients', 'cuisines', 'tags', 'recipes']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  return db;
}

// Les databasen. Med nøkkel: fersk fra API. Uten: filen publisert på GitHub Pages.
export async function load() {
  if (hasToken()) return (await readRemote()).db;
  const res = await fetch(DB_PATH, { cache: 'no-store' });
  if (!res.ok) throw new StoreError('Fant ikke data. Legg inn nøkkel under Innstillinger.', res.status);
  return normalize(await res.json());
}

// Lagre ved å kjøre `mutate` på den nyeste versjonen. Hvis noen andre lagret
// i mellomtiden (sha-konflikt), hentes ny versjon og endringen gjøres på nytt.
export async function save(mutate, message) {
  const s = settings();
  if (!s.token) throw new StoreError('Du må legge inn en nøkkel under Innstillinger for å lagre.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const { db, sha } = await readRemote();
    const result = mutate(db);
    const res = await gh(`/contents/${DB_PATH}`, {
      method: 'PUT',
      body: {
        message: `${message}${s.login ? ` (${s.login})` : ''}`,
        content: textToB64(JSON.stringify(db, null, 2) + '\n'),
        sha,
        branch: s.branch,
      },
    });
    if (res.ok) return { db, result };
    if (res.status === 409 || res.status === 422) {
      await new Promise((r) => setTimeout(r, 300 + attempt * 400));
      continue;
    }
    throw new StoreError(explain(res, true), res.status);
  }
  throw new StoreError('Klarte ikke å lagre etter flere forsøk. Prøv igjen om litt.');
}

export async function uploadImage(path, blob) {
  const s = settings();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const res = await gh(`/contents/${path}`, {
    method: 'PUT',
    body: { message: `Bilde: ${path}`, content: bytesToB64(bytes), branch: s.branch },
  });
  if (!res.ok) throw new StoreError(explain(res, true), res.status);
  return path;
}

// Bestill henting av oppskrift fra lenke. GitHub Actions (import.yml) plukker
// opp filen, henter siden og fyller retten i db.json.
export async function requestImport(recipeId, url, replace = false) {
  const s = settings();
  const path = `imports/${recipeId}-${Date.now()}.json`;
  const res = await gh(`/contents/${path}`, {
    method: 'PUT',
    body: {
      message: `Hent oppskrift fra lenke: ${url}`,
      content: textToB64(JSON.stringify({ recipeId, url, replace, requestedBy: s.login || '' }, null, 2) + '\n'),
      branch: s.branch,
    },
  });
  if (!res.ok) throw new StoreError(explain(res, true), res.status);
}

// Bilde-URL. Med nøkkel hentes bildet via API (fungerer også for privat repo
// og før Pages har publisert det). Uten nøkkel: relativ sti på Pages.
const imageCache = new Map();
export async function imageUrl(path) {
  if (!path) return null;
  if (!hasToken()) return path;
  if (imageCache.has(path)) return imageCache.get(path);
  const s = settings();
  const res = await gh(`/contents/${path}?ref=${encodeURIComponent(s.branch)}`, { accept: 'application/vnd.github.raw+json' });
  if (!res.ok) return path;
  const url = URL.createObjectURL(await res.blob());
  imageCache.set(path, url);
  return url;
}

export async function testConnection() {
  const s = settings();
  const res = await fetch(`${API}/user`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new StoreError(explain(res), res.status);
  const user = await res.json();
  const repo = await gh('');
  if (!repo.ok) throw new StoreError(explain(repo), repo.status);
  await repo.json();
  // Sjekk om NØKKELEN kan skrive, uten å endre noe: et skriveforsøk med feil
  // sha avvises med 409/422 hvis nøkkelen har skrivetilgang, og med 403/404 hvis ikke.
  const probe = await gh(`/contents/${DB_PATH}`, {
    method: 'PUT',
    body: { message: 'tilgangssjekk', content: '', sha: '0000000000000000000000000000000000000000', branch: s.branch },
  });
  const canWrite = probe.status === 409 || probe.status === 422 ? true
    : probe.status === 403 || probe.status === 404 ? false : null;
  saveSettings({ login: user.login });
  return { login: user.login, canWrite };
}
