// Rene funksjoner for datamodellen (ingen DOM, ingen nettverk).

export const norm = (s) => String(s || '').trim().toLocaleLowerCase('nb').replace(/\s+/g, ' ');

export function newId(name) {
  const base = norm(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'id';
  const rand = Math.random().toString(36).slice(2, 7);
  return `${base}-${rand}`;
}

export const byId = (arr, id) => arr.find((x) => x.id === id);

export function findByName(arr, name) {
  const n = norm(name);
  if (!n) return null;
  return arr.find((x) => norm(x.name) === n || (x.aliases || []).some((a) => norm(a) === n)) || null;
}

// Finn eller opprett et element med dette navnet (ingrediens, kjøkken, merkelapp).
export function ensure(arr, name, extra = {}) {
  const existing = findByName(arr, name);
  if (existing) return existing.id;
  const item = { id: newId(name), name: String(name).trim(), ...extra };
  arr.push(item);
  return item.id;
}

export function parseAmount(raw) {
  const s = String(raw || '').trim().replace(',', '.');
  if (!s) return null;
  const frac = s.match(/^(\d+)?\s*(\d+)\/(\d+)$/);
  if (frac) {
    const whole = frac[1] ? Number(frac[1]) : 0;
    const d = Number(frac[3]);
    if (!d) return NaN;
    return whole + Number(frac[2]) / d;
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

const nf = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 });
export const formatAmount = (n) => (n == null ? '' : nf.format(n));

export function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function siteOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Lagre (opprett eller oppdater) en oppskrift fra skjemadata. Kjøres på fersk db.
export function upsertRecipe(db, form, now = new Date().toISOString(), login = '') {
  const cuisineId = form.cuisine && form.cuisine.trim() ? ensure(db.cuisines, form.cuisine) : null;
  const tagIds = [];
  for (const id of form.tagIds || []) if (byId(db.tags, id) && !tagIds.includes(id)) tagIds.push(id);
  for (const name of form.newTags || []) {
    if (!name.trim()) continue;
    const id = ensure(db.tags, name);
    if (!tagIds.includes(id)) tagIds.push(id);
  }
  const lines = (form.lines || []).filter((l) => l.name && l.name.trim()).map((l) => ({
    ingredientId: ensure(db.ingredients, l.name, { aliases: [] }),
    amount: l.amount ?? null,
    unitId: l.unitId || null,
    note: (l.note || '').trim(),
    group: (l.group || '').trim(),
  }));
  const idx = db.recipes.findIndex((r) => r.id === form.id);
  const prev = idx >= 0 ? db.recipes[idx] : null;
  const url = safeUrl(form.sourceUrl);
  const rec = {
    id: form.id,
    title: form.title.trim() || (url ? 'Henter oppskrift …' : 'Uten navn'),
    description: (form.description || '').trim(),
    servings: form.servings || null,
    timeMinutes: form.timeMinutes || null,
    cuisineId,
    tagIds,
    lines,
    steps: (form.steps || []).map((s) => s.trim()).filter(Boolean),
    image: form.image !== undefined ? form.image : prev ? prev.image : null,
    source: url
      ? { type: 'url', url, site: siteOf(url), fetchedAt: prev?.source?.url === url ? prev.source.fetchedAt : now.slice(0, 10) }
      : { type: 'egen' },
    createdBy: prev ? prev.createdBy : login,
    importStatus: form.importStatus || undefined,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
  };
  if (idx >= 0) db.recipes[idx] = rec;
  else db.recipes.push(rec);
  return rec;
}

export function deleteRecipe(db, id) {
  db.recipes = db.recipes.filter((r) => r.id !== id);
}

// Slå sammen ingrediens `fromId` inn i `intoId`. Navnet blir et alternativt navn.
export function mergeIngredients(db, fromId, intoId) {
  if (fromId === intoId) return;
  const from = byId(db.ingredients, fromId);
  const into = byId(db.ingredients, intoId);
  if (!from || !into) return;
  into.aliases = [...new Set([...(into.aliases || []), from.name, ...(from.aliases || [])])];
  for (const r of db.recipes) for (const l of r.lines) if (l.ingredientId === fromId) l.ingredientId = intoId;
  db.ingredients = db.ingredients.filter((i) => i.id !== fromId);
}

export function usageCount(db, ingredientId) {
  return db.recipes.filter((r) => r.lines.some((l) => l.ingredientId === ingredientId)).length;
}

// ---------- lister: kjøkken, merkelapper, ingredienser ----------
export const LIST_KINDS = ['cuisines', 'tags', 'ingredients'];

export function usage(db, kind, id) {
  if (kind === 'cuisines') return db.recipes.filter((r) => r.cuisineId === id).length;
  if (kind === 'tags') return db.recipes.filter((r) => r.tagIds.includes(id)).length;
  return usageCount(db, id);
}

export function addItem(db, kind, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Navnet kan ikke være tomt.');
  if (findByName(db[kind], n)) throw new Error(`«${n}» finnes allerede.`);
  return ensure(db[kind], n, kind === 'ingredients' ? { aliases: [] } : {});
}

export function renameItem(db, kind, id, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('Navnet kan ikke være tomt.');
  const item = byId(db[kind], id);
  if (!item) throw new Error('Finnes ikke lenger. Noen kan ha slettet den.');
  const dup = findByName(db[kind], n);
  if (dup && dup.id !== id) throw new Error(`«${n}» finnes allerede. Slå sammen i stedet.`);
  item.name = n;
}

export function deleteItem(db, kind, id) {
  if (!byId(db[kind], id)) return;
  if (kind === 'ingredients') {
    const n = usageCount(db, id);
    if (n) throw new Error(`Ingrediensen brukes i ${n} oppskrift(er). Slå den sammen med en annen i stedet.`);
  }
  if (kind === 'cuisines') for (const r of db.recipes) if (r.cuisineId === id) r.cuisineId = null;
  if (kind === 'tags') for (const r of db.recipes) r.tagIds = r.tagIds.filter((t) => t !== id);
  db[kind] = db[kind].filter((x) => x.id !== id);
}

export function filterRecipes(db, f) {
  const q = norm(f.q);
  const ing = f.ingredient ? findByName(db.ingredients, f.ingredient) : null;
  return db.recipes
    .filter((r) => {
      if (q && !norm(r.title + ' ' + r.description).includes(q)) return false;
      if (f.cuisine && r.cuisineId !== f.cuisine) return false;
      for (const t of f.tags || []) if (!r.tagIds.includes(t)) return false;
      if (f.maxTime && !(r.timeMinutes && r.timeMinutes <= Number(f.maxTime))) return false;
      if (f.ingredient) {
        if (!ing) return false;
        if (!r.lines.some((l) => l.ingredientId === ing.id)) return false;
      }
      return true;
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'nb'));
}
