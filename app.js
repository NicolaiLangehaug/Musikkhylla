import { load, save, uploadImage, imageUrl, settings, saveSettings, hasToken, testConnection, requestImport } from './store.js';
import { downscale } from './image.js';
import {
  byId, newId, parseAmount, formatAmount, safeUrl, upsertRecipe, deleteRecipe,
  mergeIngredients, filterRecipes, LIST_KINDS, usage, addItem, renameItem, deleteItem,
} from './model.js';

export const VERSION = '0.5.6';

const app = document.getElementById('app');
document.getElementById('version').textContent = `Matboksen ${VERSION}`;
const nav = document.getElementById('nav');
let db = null;
const filters = { q: '', cuisine: '', tags: [], maxTime: '', ingredient: '' };
const emptyFilters = () => ({ q: '', cuisine: '', tags: [], maxTime: '', ingredient: '' });
const filterHref = (kind, id) => `#/filter/${kind}/${encodeURIComponent(id)}`;

// Sett ett filter (og nullstill de andre), vis listen.
function applyFilterRoute(kind, rawId) {
  const id = decodeURIComponent(rawId || '');
  Object.assign(filters, emptyFilters());
  if (kind === 'kjokken' && byId(db.cuisines, id)) filters.cuisine = id;
  if (kind === 'merkelapp' && byId(db.tags, id)) filters.tags = [id];
  if (kind === 'ingrediens') { const i = byId(db.ingredients, id); if (i) filters.ingredient = i.name; }
  history.replaceState(null, '', '#/');
  renderNav();
  renderList();
}

// ---------- små hjelpere ----------
// Bygger DOM uten innerHTML, så tekst fra data aldri tolkes som HTML.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (value !== undefined) el.value = value;
  return el;
}

function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), isError ? 7000 : 3000);
}

const nameOf = (arr, id) => (byId(arr, id) || {}).name || '';

function datalist(id, items) {
  return h('datalist', { id }, items.map((i) => h('option', { value: i.name })));
}

function renderNav() {
  nav.replaceChildren(
    h('a', { href: '#/ny' }, 'Ny oppskrift'),
    h('a', { href: '#/lister' }, 'Lister'),
    h('a', { href: '#/innstillinger' }, 'Innstillinger'),
  );
}

function setImage(img, path) {
  imageUrl(path).then((u) => { if (u) img.src = u; });
}

// ---------- ruting ----------
let pollTimer = null;
async function route() {
  clearTimeout(pollTimer);
  renderNav();
  const [, page, id, extra] = (location.hash || '#/').split('/');
  try {
    if (page === 'innstillinger') return renderSettings();
    if (!db) db = await load();
    if (page === 'filter') return applyFilterRoute(id, extra);
    if (page === 'oppskrift') return renderRecipe(id);
    if (page === 'ny') return renderForm(null);
    if (page === 'rediger') return renderForm(id);
    if (page === 'lister' || page === 'ingredienser') return renderLists();
    return renderList();
  } catch (e) {
    app.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, 'Fikk ikke lastet data'),
        h('p', {}, e.message),
        h('p', {}, h('a', { href: '#/innstillinger' }, 'Gå til innstillinger'))),
    );
  }
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

// ---------- liste og filtre ----------
function renderList() {
  // Fjern filtre som peker på slettede kjøkken/merkelapper.
  if (filters.cuisine && !byId(db.cuisines, filters.cuisine)) filters.cuisine = '';
  filters.tags = filters.tags.filter((t) => byId(db.tags, t));
  const results = h('div', { class: 'toc' });
  const count = h('p', { class: 'muted count' });

  function row(r) {
    const meta = r.timeMinutes ? `${r.timeMinutes} min` : '';
    return h('a', { class: 'toc-row', href: `#/oppskrift/${encodeURIComponent(r.id)}` },
      h('span', { class: 'toc-title' }, r.title,
        r.tagIds.length ? h('span', { class: 'toc-tags' }, r.tagIds.map((t) => nameOf(db.tags, t)).join(' · ')) : null),
      h('span', { class: 'toc-leader', 'aria-hidden': 'true' }),
      h('span', { class: 'toc-meta' }, meta));
  }

  const active = h('div', { class: 'active-filters', 'aria-live': 'polite' });
  function renderActive() {
    const items = [];
    const chip = (label, clear) => h('button', {
      type: 'button', class: 'chip active', 'aria-label': `Fjern filter: ${label}`,
      onclick: () => { clear(); renderList(); },
    }, label, h('span', { class: 'x', 'aria-hidden': 'true' }, '×'));
    if (filters.q) items.push(chip(`Søk: «${filters.q}»`, () => (filters.q = '')));
    if (filters.cuisine) items.push(chip(`Kjøkken: ${nameOf(db.cuisines, filters.cuisine)}`, () => (filters.cuisine = '')));
    for (const t of filters.tags) items.push(chip(`Merkelapp: ${nameOf(db.tags, t)}`, () => (filters.tags = filters.tags.filter((x) => x !== t))));
    if (filters.ingredient) items.push(chip(`Ingrediens: ${filters.ingredient}`, () => (filters.ingredient = '')));
    active.replaceChildren(...(items.length ? [h('span', { class: 'label' }, 'Viser kun:'), ...items] : []));
  }

  function update() {
    renderActive();
    const list = filterRecipes(db, filters);
    count.textContent = `${list.length} av ${db.recipes.length} oppskrifter`;
    if (!list.length) {
      results.replaceChildren(db.recipes.length
        ? h('p', {}, 'Ingen oppskrifter passer filtrene. ',
            h('button', { type: 'button', class: 'link', onclick: () => { Object.assign(filters, emptyFilters()); renderList(); } }, 'Vis alle'))
        : h('p', {}, 'Ingen oppskrifter ennå. ', h('a', { href: '#/ny' }, 'Legg til den første')));
      return;
    }
    // Grupper på kjøkken, alfabetisk; retter uten kjøkken til slutt under «Annet».
    const groups = new Map();
    for (const r of list) {
      const key = nameOf(db.cuisines, r.cuisineId) || 'Annet';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const keys = [...groups.keys()].sort((a, b) => (a === 'Annet') - (b === 'Annet') || a.localeCompare(b, 'nb'));
    results.replaceChildren(...keys.map((k) => h('section', { class: 'toc-group' },
      h('h2', {}, k === 'Annet' || filters.cuisine ? k
        : h('a', { href: filterHref('kjokken', groups.get(k)[0].cuisineId), 'aria-label': `Vis bare ${k}` }, k)),
      groups.get(k).map(row))));
  }

  const tagChips = h('div', { class: 'chips' }, db.tags
    .slice().sort((a, b) => a.name.localeCompare(b.name, 'nb'))
    .map((t) => h('button', {
      type: 'button',
      class: 'chip toggle' + (filters.tags.includes(t.id) ? ' on' : ''),
      'aria-pressed': String(filters.tags.includes(t.id)),
      onclick: (e) => {
        const on = filters.tags.includes(t.id);
        filters.tags = on ? filters.tags.filter((x) => x !== t.id) : [...filters.tags, t.id];
        e.currentTarget.classList.toggle('on', !on);
        e.currentTarget.setAttribute('aria-pressed', String(!on));
        update();
      },
    }, t.name)));

  const panel = h('section', { class: 'filters card' },
    h('label', {}, 'Søk', h('input', { type: 'search', value: filters.q, oninput: (e) => { filters.q = e.target.value; update(); } })),
    h('label', {}, 'Kjøkken',
      h('select', { value: filters.cuisine, onchange: (e) => { filters.cuisine = e.target.value; update(); } },
        h('option', { value: '' }, 'Alle'),
        db.cuisines.slice().sort((a, b) => a.name.localeCompare(b.name, 'nb')).map((c) => h('option', { value: c.id }, c.name)))),
    db.tags.length ? h('div', {}, h('span', { class: 'label' }, 'Merkelapper (alle må passe)'), tagChips) : null,
    h('button', {
      type: 'button', class: 'link',
      onclick: () => { Object.assign(filters, emptyFilters()); renderList(); },
    }, 'Nullstill filtre'),
  );

  app.replaceChildren(panel, active, count, results);
  update();
}

// ---------- vis oppskrift ----------
function renderRecipe(id) {
  const r = byId(db.recipes, decodeURIComponent(id || ''));
  if (!r) { app.replaceChildren(h('p', {}, 'Fant ikke oppskriften.')); return; }

  const groups = new Map();
  for (const l of r.lines) {
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group).push(l);
  }
  const unitName = (u) => nameOf(db.units, u);
  const src = r.source && r.source.type === 'url' ? safeUrl(r.source.url) : null;
  let photo = null;
  if (r.image) {
    const img = h('img', { alt: r.title });
    setImage(img, r.image);
    photo = h('figure', { class: 'polaroid' }, h('span', { class: 'tape', 'aria-hidden': 'true' }), img);
  }

  const editHref = `#/rediger/${encodeURIComponent(r.id)}`;
  const site = (r.source && r.source.site) || 'nettsiden';
  const st = r.importStatus;
  const hasContent = r.lines.length || r.steps.length;

  async function startImport() {
    if (hasContent && !confirm(`Erstatte ingredienser og fremgangsmåte med det som står på ${site}?`)) return;
    try {
      const at = new Date().toISOString();
      const res = await save((d) => { const x = byId(d.recipes, r.id); if (x) x.importStatus = { state: 'venter', at }; }, `Henter oppskrift: ${r.title}`);
      db = res.db;
      await requestImport(r.id, src, !!hasContent);
      renderRecipe(r.id);
    } catch (err) { toast(err.message, true); }
  }

  let banner = null;
  if (st && st.state === 'venter') {
    const waited = Date.now() - Date.parse(st.at);
    banner = h('div', { class: 'banner wait', role: 'status' },
      waited > 4 * 60 * 1000
        ? [h('strong', {}, 'Dette tar lang tid. '), 'Sjekk under «Actions» i repoet på GitHub at «Hent oppskrift fra lenke» har kjørt. ',
           h('button', { type: 'button', class: 'link', onclick: () => route() }, 'Sjekk igjen')]
        : [h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Henter ingredienser og fremgangsmåte fra ${site} … Det tar vanligvis under ett minutt.`]);
    if (hasToken() && waited <= 4 * 60 * 1000) {
      pollTimer = setTimeout(async () => {
        if (!location.hash.startsWith(`#/oppskrift/${encodeURIComponent(r.id)}`)) return;
        try { db = await load(); } catch { /* prøv igjen neste runde */ }
        renderRecipe(r.id);
      }, 5000);
    }
  } else if (st && st.state === 'feil') {
    banner = h('div', { class: 'banner error', role: 'alert' }, h('strong', {}, 'Klarte ikke å hente oppskriften. '), st.message || '',
      ' ', src && hasToken() ? h('button', { type: 'button', class: 'link', onclick: startImport }, 'Prøv igjen') : null);
  } else if (st && st.state === 'ok') {
    banner = h('div', { class: 'banner ok', role: 'status' }, st.message || 'Oppskriften er hentet.',
      ' Se over at ingrediensene ble riktige, og trykk ', h('a', { href: editHref }, 'Rediger'), ' for å rette.');
  }

  app.replaceChildren(
    h('div', { class: 'pagebar' },
      h('a', { href: '#/' }, '← Alle retter'),
      h('a', { class: 'button', href: editHref }, 'Rediger')),
    banner,
    h('article', { class: 'card recipe' },
    photo,
    r.tagIds.length ? h('div', { class: 'stamps' }, r.tagIds.map((t) => h('a', { class: 'stamp', href: filterHref('merkelapp', t), 'aria-label': `Alle retter merket ${nameOf(db.tags, t)}` }, nameOf(db.tags, t)))) : null,
    h('h1', {}, r.title),
    h('p', { class: 'muted meta' },
      [
        r.cuisineId && byId(db.cuisines, r.cuisineId)
          ? h('a', { href: filterHref('kjokken', r.cuisineId), 'aria-label': `Alle retter fra ${nameOf(db.cuisines, r.cuisineId)} kjøkken` }, nameOf(db.cuisines, r.cuisineId))
          : null,
        r.timeMinutes ? `${r.timeMinutes} min` : null,
        r.servings ? `${r.servings} porsjoner` : null,
      ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
    r.description ? h('p', { class: 'note' }, r.description) : null,
    h('h2', {}, 'Ingredienser'),
    r.lines.length ? null : h('p', { class: 'muted' }, 'Ikke lagt inn ennå.'),
    [...groups.entries()].map(([g, lines]) => [
      g ? h('h3', {}, g) : null,
      h('ul', { class: 'ingredients' }, lines.map((l) => h('li', {},
        h('span', { class: 'amt' }, [formatAmount(l.amount), unitName(l.unitId)].filter(Boolean).join(' ')),
        ' ', nameOf(db.ingredients, l.ingredientId),
        l.note ? h('span', { class: 'muted' }, `, ${l.note}`) : null))),
    ]),
    h('h2', {}, 'Slik gjør du'),
    r.steps.length ? h('ol', { class: 'steps' }, r.steps.map((s) => h('li', {}, s))) : h('p', { class: 'muted' }, 'Ikke lagt inn ennå.'),
    src ? h('p', { class: 'muted source' }, 'Kilde: ', h('a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, r.source.site || src),
      hasToken() && !(st && st.state === 'venter') ? [' · ', h('button', { type: 'button', class: 'link', onclick: startImport }, hasContent ? 'Hent på nytt fra lenken' : 'Hent fra lenken')] : null) : null,
    ),
  );
}

// ---------- skjema ----------
function renderForm(id) {
  if (!hasToken()) {
    app.replaceChildren(h('section', { class: 'card' },
      h('h1', {}, 'Du trenger en nøkkel for å redigere'),
      h('p', {}, 'Alle kan lese oppskriftene, men for å legge til og endre må appen få lov til å lagre i GitHub. Det gjør du én gang per telefon eller PC:'),
      h('ol', {},
        h('li', {}, 'Lag en nøkkel på GitHub: ', h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener noreferrer' }, 'Ny fine-grained token'), '. Velg kun repoet Matboksen, og gi Contents: Read and write.'),
        h('li', {}, 'Kopier nøkkelen og lim den inn under ', h('a', { href: '#/innstillinger' }, 'Innstillinger'), '.')),
      h('div', { class: 'actions' },
        h('a', { class: 'button', href: '#/innstillinger' }, 'Gå til innstillinger'),
        h('a', { href: id ? `#/oppskrift/${id}` : '#/' }, 'Tilbake'))));
    return;
  }
  const existing = id ? byId(db.recipes, decodeURIComponent(id)) : null;
  if (id && !existing) { app.replaceChildren(h('p', {}, 'Fant ikke oppskriften.')); return; }

  const recipeId = existing ? existing.id : null;
  const selectedTags = new Set(existing ? existing.tagIds : []);
  let imageFile = null;

  const title = h('input', { value: existing && !existing.title.startsWith('Henter oppskrift') ? existing.title : '', placeholder: 'Fylles ut fra lenken hvis tom' });
  const description = h('textarea', { rows: 2, value: existing?.description || '' });
  const servings = h('input', { type: 'number', min: 1, inputmode: 'numeric', value: existing?.servings ?? '' });
  const time = h('input', { type: 'number', min: 1, inputmode: 'numeric', value: existing?.timeMinutes ?? '' });
  const cuisine = h('input', { list: 'dl-cuisine', value: existing ? nameOf(db.cuisines, existing.cuisineId) : '' });
  const newTags = h('input', { placeholder: 'f.eks. hverdag, sunn' });
  const steps = h('textarea', { rows: 8, value: existing ? existing.steps.join('\n') : '' });
  const sourceUrl = h('input', { type: 'url', placeholder: 'https://…', value: existing?.source?.url || '' });
  const imageInput = h('input', { type: 'file', accept: 'image/*', onchange: (e) => { imageFile = e.target.files[0] || null; } });

  const linesBox = h('div', { class: 'lines' });
  function addLine(l = {}) {
    const row = h('div', { class: 'line' },
      h('input', { class: 'amount', inputmode: 'decimal', placeholder: 'Mengde', 'aria-label': 'Mengde', value: formatAmount(l.amount) }),
      h('select', { class: 'unit', 'aria-label': 'Enhet', value: l.unitId || '' },
        h('option', { value: '' }, '–'),
        db.units.map((u) => h('option', { value: u.id }, u.name))),
      h('input', { class: 'name', list: 'dl-ing', placeholder: 'Ingrediens', 'aria-label': 'Ingrediens', value: l.ingredientId ? nameOf(db.ingredients, l.ingredientId) : '' }),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Fjern linje', onclick: () => row.remove() }, '×'),
    );
    row.dataset.note = l.note || '';
    row.dataset.group = l.group || '';
    linesBox.append(row);
  }
  (existing && existing.lines.length ? existing.lines : [{}, {}, {}]).forEach(addLine);

  const tagBox = h('div', { class: 'chips' }, db.tags
    .slice().sort((a, b) => a.name.localeCompare(b.name, 'nb'))
    .map((t) => h('label', { class: 'chip check' },
      h('input', { type: 'checkbox', checked: selectedTags.has(t.id), onchange: (e) => (e.target.checked ? selectedTags.add(t.id) : selectedTags.delete(t.id)) }),
      t.name)));

  const saveBtn = h('button', { type: 'submit' }, 'Lagre');

  async function onSubmit(e) {
    e.preventDefault();
    const lines = [];
    for (const row of linesBox.querySelectorAll('.line')) {
      const name = row.querySelector('.name').value.trim();
      const rawAmt = row.querySelector('.amount').value;
      if (!name) {
        if (rawAmt.trim()) return toast('En linje har mengde, men mangler ingrediens.', true);
        continue;
      }
      const amount = parseAmount(rawAmt);
      if (Number.isNaN(amount)) return toast(`Forstår ikke mengden «${rawAmt}» for ${name}.`, true);
      lines.push({
        name, amount,
        unitId: row.querySelector('.unit').value,
        // Merknad og gruppe er skjult i skjemaet foreløpig; eksisterende verdier beholdes.
        note: row.dataset.note || '',
        group: row.dataset.group || '',
      });
    }
    const url = safeUrl(sourceUrl.value.trim());
    if (sourceUrl.value.trim() && !url) return toast('Lenken må starte med http:// eller https://', true);
    if (!title.value.trim() && !url) return toast('Skriv en tittel, eller lim inn en lenke til oppskriften.', true);
    const stepList = steps.value.split('\n').map((x) => x.trim()).filter(Boolean);
    // Lenke + ingen ingredienser og ingen fremgangsmåte => hent automatisk fra lenken.
    const autoImport = !!url && !lines.length && !stepList.length;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Lagrer …';
    try {
      const id = recipeId || newId(title.value);
      const form = {
        id,
        title: title.value,
        description: description.value,
        servings: Number(servings.value) || null,
        timeMinutes: Number(time.value) || null,
        cuisine: cuisine.value,
        tagIds: [...selectedTags],
        newTags: newTags.value.split(','),
        lines,
        steps: steps.value.split('\n'),
        sourceUrl: sourceUrl.value,
        importStatus: autoImport ? { state: 'venter', at: new Date().toISOString() } : undefined,
      };
      if (imageFile) {
        const { blob, ext } = await downscale(imageFile);
        form.image = await uploadImage(`images/${id}-${Date.now()}.${ext}`, blob);
      }
      const s = settings();
      const res = await save((d) => upsertRecipe(d, form, new Date().toISOString(), s.login), `${recipeId ? 'Endret' : 'Ny'} oppskrift: ${form.title.trim()}`);
      db = res.db;
      if (autoImport) {
        try { await requestImport(id, url, false); toast('Lagret. Henter fra lenken …'); }
        catch (err) {
          await save((d) => { const x = byId(d.recipes, id); if (x) x.importStatus = { state: 'feil', at: new Date().toISOString(), message: err.message }; }, 'Henting feilet').then((r2) => { db = r2.db; }).catch(() => {});
          toast(err.message, true);
        }
      } else toast('Lagret.');
      location.hash = `#/oppskrift/${encodeURIComponent(id)}`;
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Lagre';
    }
  }

  async function onDelete() {
    if (!confirm(`Slette «${existing.title}»?`)) return;
    try {
      const res = await save((d) => deleteRecipe(d, existing.id), `Slettet oppskrift: ${existing.title}`);
      db = res.db;
      toast('Slettet.');
      location.hash = '#/';
    } catch (err) { toast(err.message, true); }
  }

  app.replaceChildren(
    h('form', { class: 'card form', onsubmit: onSubmit },
    h('h1', {}, existing ? 'Rediger oppskrift' : 'Ny oppskrift'),
    h('label', {}, 'Lenke til oppskriften (valgfritt)', sourceUrl,
      h('span', { class: 'hint' }, 'Er ingrediensene og fremgangsmåten tomme, hentes de fra lenken når du lagrer.')),
    h('label', {}, 'Tittel', title),
    h('label', {}, 'Kort beskrivelse', description),
    h('div', { class: 'row' },
      h('label', {}, 'Porsjoner', servings),
      h('label', {}, 'Tid (min)', time),
      h('label', {}, 'Kjøkken', cuisine)),
    datalist('dl-cuisine', db.cuisines),
    h('fieldset', {}, h('legend', {}, 'Ingredienser'),
      h('p', { class: 'muted' }, 'Velg fra listen eller skriv en ny ingrediens. Mengde kan være 1,5 eller 1/2.'),
      linesBox,
      h('button', { type: 'button', class: 'secondary', onclick: () => addLine() }, '+ Legg til linje'),
      datalist('dl-ing', db.ingredients)),
    h('label', {}, 'Fremgangsmåte (ett steg per linje)', steps),
    h('fieldset', {}, h('legend', {}, 'Merkelapper'),
      tagBox,
      h('label', {}, 'Nye merkelapper (kommaseparert)', newTags)),
    h('label', {}, existing?.image ? 'Bytt bilde' : 'Bilde', imageInput),
    h('div', { class: 'actions sticky-actions' },
      saveBtn,
      h('a', { href: existing ? `#/oppskrift/${encodeURIComponent(existing.id)}` : '#/' }, 'Avbryt'),
      existing ? h('button', { type: 'button', class: 'danger', onclick: onDelete }, 'Slett') : null),
  ));
}

// ---------- lister: kjøkken, merkelapper, ingredienser ----------
const LIST_TITLES = {
  cuisines: ['Kjøkken', 'kjøkken', 'Nytt kjøkken'],
  tags: ['Merkelapper', 'merkelapp', 'Ny merkelapp'],
  ingredients: ['Ingredienser', 'ingrediens', 'Ny ingrediens'],
};

async function runSave(mutate, message, okMsg) {
  try {
    const res = await save(mutate, message);
    db = res.db;
    toast(okMsg);
    renderLists();
  } catch (err) { toast(err.message, true); }
}

function listSection(kind) {
  const [title, noun, newLabel] = LIST_TITLES[kind];
  const items = db[kind].slice().sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  const canEdit = hasToken();
  const addInput = h('input', { 'aria-label': newLabel, placeholder: newLabel });

  let merge = null;
  if (kind === 'ingredients' && canEdit && items.length > 1) {
    const from = h('select', { 'aria-label': 'Slå sammen denne' }, items.map((i) => h('option', { value: i.id }, i.name)));
    const into = h('select', { 'aria-label': 'Inn i denne' }, items.map((i) => h('option', { value: i.id }, i.name)));
    merge = h('div', { class: 'merge' },
      h('h3', {}, 'Slå sammen duplikater'),
      h('div', { class: 'row' }, from, h('span', {}, 'inn i'), into),
      h('button', {
        type: 'button',
        onclick: () => {
          if (from.value === into.value) return toast('Velg to ulike ingredienser.', true);
          const a = nameOf(db.ingredients, from.value);
          const b = nameOf(db.ingredients, into.value);
          if (!confirm(`Slå sammen «${a}» inn i «${b}»? Alle oppskrifter oppdateres.`)) return;
          runSave((d) => mergeIngredients(d, from.value, into.value), `Slo sammen ingrediens: ${a} → ${b}`, 'Slått sammen.');
        },
      }, 'Slå sammen'));
  }

  return h('section', { class: 'card', id: `liste-${kind}` },
    h('h2', {}, title),
    canEdit ? h('form', {
      class: 'row add',
      onsubmit: (e) => {
        e.preventDefault();
        const name = addInput.value.trim();
        if (!name) return;
        runSave((d) => addItem(d, kind, name), `${newLabel}: ${name}`, 'Lagt til.');
      },
    }, addInput, h('button', { type: 'submit' }, 'Legg til')) : null,
    merge,
    items.length
      ? h('ul', { class: 'plain items' }, items.map((i) => {
          const n = usage(db, kind, i.id);
          return h('li', {},
            h('span', { class: 'item-name' },
              n ? h('a', { href: filterHref({ cuisines: 'kjokken', tags: 'merkelapp', ingredients: 'ingrediens' }[kind], i.id), 'aria-label': `Vis retter med ${i.name}` }, i.name) : i.name,
              i.aliases && i.aliases.length ? h('span', { class: 'muted' }, ` (også: ${i.aliases.join(', ')})`) : null,
              h('span', { class: 'muted' }, ` · ${n} oppskrift${n === 1 ? '' : 'er'}`)),
            canEdit ? h('span', { class: 'item-actions' },
              h('button', {
                type: 'button', class: 'secondary small', 'aria-label': `Endre navn på ${i.name}`,
                onclick: () => {
                  const name = prompt(`Nytt navn på «${i.name}»:`, i.name);
                  if (name == null || name.trim() === i.name) return;
                  runSave((d) => renameItem(d, kind, i.id, name), `Endret ${noun}: ${i.name} → ${name.trim()}`, 'Endret.');
                },
              }, 'Endre'),
              h('button', {
                type: 'button', class: 'danger small', 'aria-label': `Slett ${i.name}`,
                onclick: () => {
                  if (kind === 'ingredients' && n) return toast(`«${i.name}» brukes i ${n} oppskrift(er). Slå den sammen med en annen i stedet.`, true);
                  const warn = n ? ` Den fjernes fra ${n} oppskrift${n === 1 ? '' : 'er'}.` : '';
                  if (!confirm(`Slette «${i.name}»?${warn}`)) return;
                  runSave((d) => deleteItem(d, kind, i.id), `Slettet ${noun}: ${i.name}`, 'Slettet.');
                },
              }, 'Slett')) : null);
        }))
      : h('p', { class: 'muted' }, `Ingen ${title.toLowerCase()} ennå.`),
  );
}

function renderLists() {
  app.replaceChildren(
    h('h1', {}, 'Lister'),
    h('nav', { class: 'chips' },
      LIST_KINDS.map((k) => h('a', { class: 'chip', href: `#/lister`, onclick: (e) => { e.preventDefault(); document.getElementById(`liste-${k}`).scrollIntoView(); } }, LIST_TITLES[k][0]))),
    ...LIST_KINDS.map(listSection),
  );
}

// ---------- innstillinger ----------
function renderSettings() {
  const s = settings();
  const token = h('input', { type: 'password', autocomplete: 'off', value: s.token });
  const owner = h('input', { value: s.owner });
  const repo = h('input', { value: s.repo });
  const branch = h('input', { value: s.branch });
  const status = h('p', { class: 'muted' }, s.login ? `Innlogget som ${s.login}.` : '');

  async function onSave(e) {
    e.preventDefault();
    saveSettings({ token: token.value.trim(), owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', login: '' });
    db = null;
    if (!token.value.trim()) { status.textContent = 'Nøkkel fjernet. Du kan lese, men ikke lagre.'; renderNav(); return; }
    status.textContent = 'Sjekker …';
    try {
      const { login, canWrite } = await testConnection();
      status.replaceChildren(
        canWrite === true ? `Innlogget som ${login}. Nøkkelen kan lagre. `
          : canWrite === false ? `Innlogget som ${login}, men nøkkelen kan bare lese. Rediger nøkkelen på GitHub: velg «Only select repositories» → Matboksen, og sett Contents til «Read and write». `
          : `Innlogget som ${login}. Fikk ikke sjekket om nøkkelen kan lagre; prøv å lagre noe. `,
        h('a', { href: '#/' }, 'Til oppskriftene →'));
    } catch (err) { status.textContent = err.message; }
    renderNav();
  }

  app.replaceChildren(h('form', { class: 'card form', onsubmit: onSave },
    h('h1', {}, 'Innstillinger'),
    h('p', {}, 'Nøkkelen lagres bare i denne nettleseren. Se README i repoet for hvordan du lager en.'),
    h('label', {}, 'GitHub-nøkkel (fine-grained token)', token),
    h('div', { class: 'row' },
      h('label', {}, 'Eier', owner),
      h('label', {}, 'Repo', repo),
      h('label', {}, 'Gren', branch)),
    h('div', { class: 'actions' }, h('button', { type: 'submit' }, 'Lagre og test')),
    status,
  ));
}

route();
