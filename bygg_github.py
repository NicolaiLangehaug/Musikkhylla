"""Bygger Platesamlingen 2.0 for GitHub Pages: index.html + covers/*.jpg + data/plater.json, med lagring i db."""
import base64, io, json, re, sys
from pathlib import Path
from PIL import Image

S = Path(sys.argv[1])           # scratchpad
OUT = Path(sys.argv[2])
src = (S / 'canvas/project/Rommet.dc.html').read_text()
pk = S / 'pkgs'

# --- mal og logikk fra designet ---
tpl = src.split('<x-dc>')[1].split('</x-dc>')[0]
helmet_css = re.search(r'<helmet>.*?<style>(.*?)</style>', tpl, re.S).group(1)
tpl = re.sub(r'<helmet>.*?</helmet>', '', tpl, flags=re.S)
# HTML-tolkeren kaster ukjente elementer inne i <select>; bruk egne navn og gjør dem om igjen ved tegning
tpl = tpl.replace('<select', '<x-select').replace('</select>', '</x-select>').replace('<option', '<x-option').replace('</option>', '</x-option>')
script = src.split('data-dc-script')[1].split('>', 1)[1].split('</script>')[0]
script = script.replace("""    fetch('/_blob/ac2b314853e73e52fd0eec9c06087790')
      .then((r) => r.json())
      .then((d) => { this.d = d; this.prep(); this.setState({ ready: true }); })
      .catch(() => this.setState({ failed: true }));""",
"""    this.d = window.PLATEDATA; this.prep(); this.setState(Object.assign({ ready: true }, lagret()));""")
assert 'window.PLATEDATA' in script
# coverne: bytt artefakt-adressene mot lokale blob-adresser
blobs = re.findall(r"'/_blob/([0-9a-f]{32})'", script.split('this.ATLAS = [')[1].split('];')[0])
assert len(blobs) == 8, blobs
script = re.sub(r"this\.ATLAS = \[.*?\];", "this.ATLAS = window.ATLAS;", script, count=1, flags=re.S)
script = re.sub(r"this\.FOTOS = \{.*?\};", "this.FOTOS = {};", script, count=1, flags=re.S)
script = script.replace("name: 'Stil F · kveldslys'", "name: 'versjon 2.0'")
script = script.replace("if (r && r.nyImg) return { hasCover: true, noCover: false, src: r.nyImg,", "if (r && r.nyImg && window.omslagSrc(r.nyImg)) return { hasCover: true, noCover: false, src: window.omslagSrc(r.nyImg),")
assert 'window.omslagSrc(r.nyImg)' in script
b0 = '<button type="button" onClick="{{openForm}}"'
assert tpl.count(b0) == 1
tpl = tpl.replace(b0, '<button type="button" onClick="{{openDiscogs}}" style="flex: none; white-space: nowrap; height: 40px; padding: 0 14px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; background: transparent; font-family: \'Archivo\', sans-serif; font-size: 14px; font-weight: 700; {{T.btn}}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="2.5"></circle></svg>Discogs</button>\n' + b0)
o0 = "openForm: set({ form: { s: 'LP', n: 1 }, sel: -1 }),"
assert script.count(o0) == 1
script = script.replace(o0, "openDiscogs: () => { if (window.discogsÅpne) window.discogsÅpne(); }, openSjangre: () => { if (window.sjangreÅpne) window.sjangreÅpne(); }, " + o0)
d0 = '<button type="button" onClick="{{openDiscogs}}"'
assert tpl.count(d0) == 1
tpl = tpl.replace(d0, '<button type="button" onClick="{{openSjangre}}" style="flex: none; white-space: nowrap; height: 40px; padding: 0 14px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; background: transparent; font-family: \'Archivo\', sans-serif; font-size: 14px; font-weight: 700; {{T.btn}}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h6"></path></svg>Sjangre</button>\n' + d0)
# en plate som var fjernet i dataene kan hentes tilbake (gone[i] === false)
a0 = "if (x.r.gone || (this.goneMap || {})[i]) where[i] = 13;"
assert a0 in script
script = script.replace(a0, "if ((x.r.gone && (this.goneMap || {})[i] !== false) || (this.goneMap || {})[i]) where[i] = 13;")
a = "ok({ img: cv.toDataURL('image/jpeg', 0.82), sc: '#' + hx(r) + hx(g) + hx(b) });"
assert a in script
script = script.replace(a, "const sc0 = '#' + hx(r) + hx(g) + hx(b); window.lagreBilde(cv).then((img) => ok({ img, sc: sc0 }), fail);")

runtime = r"""
// ---------- liten motor som tolker designets mal ({{hull}}, sc-for, sc-if, hendelser) ----------
(function () {
  const LAGRE = 'platesamlingen.side.v1';
  const NOKLER = ['moved', 'placed', 'gone', 'extra', 'wish', 'np', 'discogs'];
  const STD = { moved: {}, placed: {}, gone: {}, extra: [], np: -1 };
  // kanonisk JSON (sorterte nøkler), så lokale og lagrede utgaver kan sammenlignes
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
  const utdrag = (st) => { const o = {}; NOKLER.forEach((k) => { if (st[k] !== undefined) o[k] = st[k]; }); return o; };
  window.lagret = function () { try { return Object.assign({}, STD, JSON.parse(localStorage.getItem(LAGRE) || '{}')); } catch (e) { return Object.assign({}, STD); } };
  // ---------- lagring i GitHub-prosjektet: data/tilstand.json (+ omslag/<nid>.jpg for nye plater) ----------
  // Alle kan se rommet. Bare den som har lagt inn en GitHub-nøkkel på enheten sin, kan lagre endringer.
  const GH = (() => {
    const h = location.hostname, deler = location.pathname.split('/').filter(Boolean);
    return {
      eier: h.endsWith('.github.io') ? h.split('.')[0] : 'NicolaiLangehaug',
      repo: h.endsWith('.github.io') && deler[0] && !/\.html?$/.test(deler[0]) ? deler[0] : 'Musikkhylla',
      fil: 'data/tilstand.json',
    };
  })();
  const NOKKEL = 'platesamlingen.nokkel', ULAGRET = 'platesamlingen.ulagret';
  // endringer som ennå ikke er bekreftet lagret i GitHub, tas vare på lokalt til de er det (også over omlasting)
  const settUlagret = (s) => { try { if (s) localStorage.setItem(ULAGRET, s); else localStorage.removeItem(ULAGRET); } catch (e) {} };
  const lesUlagret = () => { try { return localStorage.getItem(ULAGRET) || ''; } catch (e) { return ''; } };
  const lesNokkel = () => { try { return localStorage.getItem(NOKKEL) || ''; } catch (e) { return ''; } };
  let nokkel = lesNokkel(), sha = null, fjernKlar = false, sistLagret = '', tidtaker = null, skriver = false, status = 'laster';
  const tilB64 = (str) => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const fraB64 = (b64) => { const bin = atob(b64.replace(/\s/g, '')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new TextDecoder().decode(u); };
  const api = (sti, opt) => fetch('https://api.github.com/repos/' + GH.eier + '/' + GH.repo + '/contents/' + sti, Object.assign({ cache: 'no-store' }, opt || {}, {
    headers: Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, nokkel ? { Authorization: 'Bearer ' + nokkel } : {}),
  }));

  // ---- omslag på nye plater: egne bildefiler i prosjektet, tilstanden har bare 'gh:<nid>' ----
  const OMSLAG = {}, LASTET = {}, OL = 'platesamlingen.omslag.';
  async function lastOppOmslag(nid, dataUrl) {
    if (LASTET[nid] || !nokkel) return;
    LASTET[nid] = true;
    try {
      const sti = 'omslag/' + nid + '.jpg', fra = await api(sti);
      const body = { message: 'Omslag til ny plate', content: dataUrl.split(',')[1], branch: 'main' };
      if (fra.ok) body.sha = (await fra.json()).sha;
      const r = await api(sti, { method: 'PUT', body: JSON.stringify(body) });
      if (!r.ok) LASTET[nid] = false;
    } catch (e) { LASTET[nid] = false; }
  }
  function skill(o) {
    if (!o.extra) return o;
    return Object.assign({}, o, { extra: o.extra.map((x) => {
      if (x.nyImg && x.nyImg.indexOf('data:') === 0) {
        OMSLAG[x.nid] = x.nyImg; try { localStorage.setItem(OL + x.nid, x.nyImg); } catch (e) {}
        lastOppOmslag(x.nid, x.nyImg);
        return Object.assign({}, x, { nyImg: 'gh:' + x.nid });
      }
      return x;
    }) });
  }
  window.omslagSrc = (v) => {
    if (!v || v.indexOf('gh:') !== 0) return v && v.indexOf('/_blob/') !== 0 && v.indexOf('db:') !== 0 ? v : '';
    const id = v.slice(3);
    if (OMSLAG[id]) return OMSLAG[id];
    try { const l = localStorage.getItem(OL + id); if (l) { OMSLAG[id] = l; return l; } } catch (e) {}
    return 'https://raw.githubusercontent.com/' + GH.eier + '/' + GH.repo + '/main/omslag/' + id + '.jpg';
  };
  window.lagreBilde = (cv) => Promise.resolve(cv.toDataURL('image/jpeg', 0.82));

  // ---- lese og skrive tilstanden ----
  async function hentTilstand() {
    if (nokkel) {
      const r = await api(GH.fil + '?ref=main');
      if (r.status === 401 || r.status === 403) throw new Error('nøkkel');
      if (r.status === 404) { sha = null; return null; }
      if (!r.ok) throw new Error('svar ' + r.status);
      const j = await r.json(); sha = j.sha;
      return JSON.parse(fraB64(j.content));
    }
    const r = await fetch('data/tilstand.json?t=' + Date.now(), { cache: 'no-store' });
    return r.ok ? r.json() : null;
  }
  async function skriv(s, forsok) {
    skriver = true; settStatus('lagrer');
    try {
      const r = await api(GH.fil, { method: 'PUT', body: JSON.stringify({ message: 'Endringer i rommet', content: tilB64(JSON.stringify(JSON.parse(s), null, 1)), branch: 'main', sha: sha || undefined }) });
      if ((r.status === 409 || r.status === 422) && !forsok) { await hentTilstand().catch(() => {}); return skriv(s, true); }
      if (r.status === 401 || r.status === 403) { settStatus('nøkkel'); return; }
      if (!r.ok) { settStatus('feil'); planleggNyttForsok(); return; }
      sha = (await r.json()).content.sha; sistLagret = s;
      if (lesUlagret() === s) settUlagret('');
      settStatus(lesUlagret() ? 'venter' : 'lagret');
    } catch (e) { settStatus('feil'); planleggNyttForsok(); }
    finally { skriver = false; }
  }
  let forsokTid = null;
  function planleggNyttForsok() {
    clearTimeout(forsokTid);
    forsokTid = setTimeout(() => { const u = lesUlagret(); if (u && nokkel) skriv(u); }, 10000);
  }
  function lagre(st) {
    const o = skill(utdrag(st)), s = canon(o);
    try { localStorage.setItem(LAGRE, JSON.stringify(o)); } catch (e) {}
    if (!fjernKlar || s === sistLagret) return;
    if (!nokkel) { settStatus('ulokal'); return; }
    settUlagret(s);
    clearTimeout(tidtaker);
    settStatus('venter');
    tidtaker = setTimeout(() => { tidtaker = null; skriv(s); }, 1200);
  }
  // går du ut av rommet før lagringen er sendt, sendes den med en gang
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && tidtaker && nokkel) { clearTimeout(tidtaker); tidtaker = null; const u = lesUlagret(); if (u) skriv(u); }
  });
  async function synk() {
    if (skriver || tidtaker) return;
    try {
      const d = await hentTilstand();
      fjernKlar = true;
      const ulagret = nokkel ? lesUlagret() : '';
      if (ulagret) {
        // endringer herfra som ikke kom fram: behold dem og send dem nå, i stedet for å overskrive dem
        if (d) sistLagret = canon(d);
        if (komp && canon(skill(utdrag(komp.state || {}))) !== ulagret) komp.setState(Object.assign({}, STD, JSON.parse(ulagret)));
        skriv(ulagret);
        return;
      }
      if (!d) { settStatus(nokkel ? 'lagret' : 'visning'); if (nokkel) lagre((komp && komp.state) || {}); return; }
      const s = canon(d);
      if (s !== sistLagret) { sistLagret = s; if (komp) komp.setState(Object.assign({}, STD, d)); }
      settStatus(nokkel ? 'lagret' : 'visning');
    } catch (e) { settStatus(e.message === 'nøkkel' ? 'nøkkel' : 'feil'); }
  }
  function koble() {
    synk();
    // når du kommer tilbake til rommet (f.eks. etter å ha brukt det på en annen enhet), hentes siste versjon
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') synk(); });
  }

  // ---- statusmerke og nøkkel ----
  const TEKST = {
    laster: 'Henter …', visning: 'Bare visning', venter: 'Ulagret …', lagrer: 'Lagrer …', lagret: 'Lagret i GitHub',
    feil: 'Fikk ikke lagret – prøver igjen', 'nøkkel': 'Nøkkelen virker ikke – trykk her',
    ulokal: 'Lagres ikke – trykk for å legge inn nøkkel',
  };
  function settStatus(s) {
    status = s;
    let el = document.getElementById('gh-status');
    if (!el) {
      el = document.createElement('button'); el.id = 'gh-status'; el.type = 'button';
      el.addEventListener('click', visNokkel); document.body.appendChild(el);
    }
    el.textContent = TEKST[s] || s;
    el.className = 'gh-status gh-' + s;
    el.setAttribute('aria-label', (TEKST[s] || s) + '. Trykk for å legge inn eller endre GitHub-nøkkel.');
  }
  function visNokkel() {
    let d = document.getElementById('gh-dialog');
    if (!d) {
      d = document.createElement('div'); d.id = 'gh-dialog'; document.body.appendChild(d);
      d.addEventListener('click', (e) => { if (e.target === d || e.target.dataset.lukk) d.hidden = true; });
    }
    d.hidden = false;
    d.innerHTML = '<div class="gh-kort" role="dialog" aria-modal="true" aria-labelledby="gh-t"><h2 id="gh-t">Lagring</h2>' +
      '<p>Alle med lenka kan se rommet og spille plater. For å lagre endringer på denne enheten trenger du en GitHub-nøkkel som bare gjelder prosjektet <b>' + GH.eier + '/' + GH.repo + '</b>.</p>' +
      '<p class="gh-mono">STATUS: ' + (TEKST[status] || status).toUpperCase() + (nokkel ? ' · NØKKEL LAGT INN' : ' · INGEN NØKKEL') + '</p>' +
      '<label class="gh-felt">GitHub-nøkkel<input type="password" id="gh-inn" autocomplete="off" placeholder="github_pat_…"></label>' +
      '<div class="gh-knapper">' + (nokkel ? '<button type="button" class="gh-sek" id="gh-fjern">Fjern nøkkel</button>' : '') +
      '<button type="button" class="gh-sek" data-lukk="1">Lukk</button><button type="button" class="gh-prim" id="gh-lagre">Lagre nøkkel</button></div></div>';
    d.querySelector('#gh-lagre').onclick = () => {
      const v = d.querySelector('#gh-inn').value.trim(); if (!v) return;
      nokkel = v; try { localStorage.setItem(NOKKEL, v); } catch (e) {}
      d.hidden = true; settStatus('laster'); sha = null; synk();
    };
    const f = d.querySelector('#gh-fjern');
    if (f) f.onclick = () => { nokkel = ''; try { localStorage.removeItem(NOKKEL); } catch (e) {} d.hidden = true; synk(); };
    setTimeout(() => d.querySelector('#gh-inn').focus(), 50);
  }

  // ---- rommets egen YouTube-spiller: liten og synlig nede i hjørnet ----
  let spiller = null, spillerKlar = false, venterPa = null;
  function lagSpiller() {
    const boks = document.createElement('div');
    boks.id = 'spiller'; boks.className = 'spiller skjult';
    boks.innerHTML = '<div class="spiller-topp"><span class="spiller-tittel">Platespilleren</span>' +
      '<button type="button" class="spiller-knapp" id="spiller-min" aria-label="Gjør spilleren mindre">–</button>' +
      '<button type="button" class="spiller-knapp" id="spiller-stopp" aria-label="Løft armen">×</button></div><div id="spiller-yt"></div>';
    document.body.appendChild(boks);
    boks.querySelector('#spiller-min').onclick = () => boks.classList.toggle('liten');
    boks.querySelector('#spiller-stopp').onclick = () => { window.stoppAv(); const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Løft armen'); if (b) b.click(); };
    const lag = () => {
      spiller = new YT.Player('spiller-yt', {
        width: '340', height: '191', playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: { onReady: () => { spillerKlar = true; if (venterPa) { const v = venterPa; venterPa = null; startListe(v); } } },
      });
    };
    if (window.YT && window.YT.Player) lag(); else window.onYouTubeIframeAPIReady = lag;
  }
  function startListe(ids) {
    const boks = document.getElementById('spiller');
    boks.classList.remove('skjult');
    if (!spillerKlar) { venterPa = ids; return; }
    if (ids && ids.liste) { spiller.loadPlaylist({ list: ids.liste, listType: 'playlist', index: 0 }); return; }
    spiller.loadPlaylist(ids.slice(0, 200), 0, 0);
  }
  window.spillAv = (r, reserveUrl) => {
    if (r.ytListe) { startListe({ liste: r.ytListe }); return true; }
    if (r.yt && r.yt.length) { startListe(r.yt); return true; }
    // ingen videoer fra Discogs: åpne YouTube-søket i ny fane
    try { return !!window.open(reserveUrl, '_blank'); } catch (e) { return false; }
  };
  window.stoppAv = () => {
    try { if (spiller && spillerKlar) spiller.stopVideo(); } catch (e) {}
    const b = document.getElementById('spiller'); if (b) b.classList.add('skjult');
  };
  window.ATLAS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => 'covers/cover' + i + '.jpg');

  const MAL = new DOMParser().parseFromString('<div id="m">' + document.getElementById('mal').textContent + '</div>', 'text/html').getElementById('m');
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function look(path, scope) {
    path = path.trim();
    if (path === 'true') return true; if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    let v = scope;
    for (const k of path.split('.')) { if (v == null) return undefined; v = v[k]; }
    return v;
  }
  const whole = (s) => { const m = /^\{\{([^}]+)\}\}$/.exec(s.trim()); return m ? m[1] : null; };
  const interp = (s, scope) => s.replace(/\{\{([^}]+)\}\}/g, (_, p) => { const v = look(p, scope); return v == null ? '' : v; });
  let H = [];
  const VOID = { img: 1, input: 1, br: 1, hr: 1, meta: 1, link: 1 };
  function render(node, scope) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(interp(n.nodeValue, scope)); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'sc-for') {
        const list = look(whole(n.getAttribute('list')), scope) || [];
        const as = n.getAttribute('as');
        list.forEach((it, i) => { const sc = Object.create(scope); sc[as] = it; sc.$index = i; out += render(n, sc); });
        continue;
      }
      if (tag === 'sc-if') { if (look(whole(n.getAttribute('value')), scope)) out += render(n, scope); continue; }
      let name = n.namespaceURI === 'http://www.w3.org/2000/svg' ? n.localName : tag;
      if (name === 'x-select') name = 'select'; else if (name === 'x-option') name = 'option';
      let a = '';
      for (const at of n.attributes) {
        if (at.name.indexOf('hint-') === 0) continue;
        if (/^on[a-z]+$/i.test(at.name)) {
          const fn = look(whole(at.value) || '', scope);
          if (typeof fn === 'function') { H.push(fn); a += ' data-on-' + at.name.slice(2).toLowerCase() + '="' + (H.length - 1) + '"'; }
          continue;
        }
        if (name === 'select' && at.name === 'value') { a += ' data-value="' + esc(interp(at.value, scope)) + '"'; continue; }
        a += ' ' + at.name + '="' + esc(interp(at.value, scope)) + '"';
      }
      out += '<' + name + a + '>';
      if (!VOID[name]) out += render(n, scope) + '</' + name + '>';
    }
    return out;
  }

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = undefined; }
    setState(s) { this.state = Object.assign({}, this.state || {}, s); planlegg(); }
    forceUpdate() { planlegg(); }
  }
  window.DCLogic = DCLogic;
  let komp, rot, ventende = false;
  function planlegg() { if (!ventende) { ventende = true; requestAnimationFrame(tegn); } }
  function tegn() {
    ventende = false;
    H = [];
    const html = '<div id="app">' + render(MAL, komp.renderVals()) + '</div>';
    morphdom(rot, html, {
      onBeforeElUpdated: (from, to) => { if (from.tagName === 'INPUT') { if (from.type === 'file') return false; to.value = from.value; } return true; },
    });
    rot.querySelectorAll('select[data-value]').forEach((s) => { if (s.value !== s.getAttribute('data-value')) s.value = s.getAttribute('data-value'); });
    lagre(komp.state || {});
    if (window.etterTegning) window.etterTegning();
  }
  // sveip på omslagene i Bla: mot venstre = neste plate, mot høyre = forrige
  let sv = null, stoppKlikk = false;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest && e.target.closest('[data-sveip]');
    sv = el ? { el, x: e.clientX, y: e.clientY, dx: 0 } : null;
  });
  document.addEventListener('pointermove', (e) => {
    if (!sv) return;
    sv.dx = e.clientX - sv.x;
    if (Math.abs(sv.dx) > 8 && Math.abs(sv.dx) > Math.abs(e.clientY - sv.y)) { sv.el.style.transition = 'none'; sv.el.style.transform = 'translateX(' + sv.dx * 0.5 + 'px) rotate(' + sv.dx * 0.02 + 'deg)'; }
  });
  const sveipSlutt = (e) => {
    if (!sv) return;
    const { el, x, y } = sv, dx = e.clientX - x, dy = e.clientY - y; sv = null;
    el.style.transition = 'transform 180ms ease-out'; el.style.transform = '';
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      stoppKlikk = true; setTimeout(() => { stoppKlikk = false; }, 400);
      const b = document.querySelector('button[aria-label="' + (dx < 0 ? 'Neste plate' : 'Forrige plate') + '"]');
      if (b) b.click();
    }
  };
  document.addEventListener('pointerup', sveipSlutt);
  document.addEventListener('pointercancel', () => { if (sv) { sv.el.style.transform = ''; sv = null; } });
  document.addEventListener('click', (e) => { if (stoppKlikk && e.target.closest && e.target.closest('[data-sveip]')) { e.stopPropagation(); e.preventDefault(); stoppKlikk = false; } }, true);
  ['click', 'input', 'change', 'dragstart', 'dragover', 'drop'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      const el = e.target.closest && e.target.closest('[data-on-' + ev + ']');
      if (!el) return;
      const fn = H[+el.getAttribute('data-on-' + ev)];
      if (fn) fn(e);
    });
  });
  // Høyden er alltid 1024 logiske px; bredden fyller vinduet når det er bredere enn 4:3.
  function skaler() {
    const iw = window.innerWidth, ih = window.innerHeight;
    let s, W;
    if (iw / ih >= 1366 / 1024) { s = ih / 1024; W = iw / s; } else { s = iw / 1366; W = 1366; }
    const sc = document.getElementById('scene');
    sc.style.transform = 'scale(' + s + ')'; sc.style.width = W + 'px';
    document.documentElement.style.setProperty('--topp', Math.round(56 * s + 10) + 'px');  // statusmerket rett under toppen
    document.getElementById('ramme').style.width = W * s + 'px';
    document.getElementById('ramme').style.height = 1024 * s + 'px';
    if (komp) { komp.props.bredde = Math.round(W); planlegg(); }
  }
  window.addEventListener('resize', skaler);
__PANEL__
  function start() {
    skaler();
    rot = document.getElementById('app');
    try {
      window.PLATEDATA = JSON.parse(document.getElementById('platedata').textContent);
      if (typeof morphdom !== 'function') throw new Error('tegnemotoren lastet ikke');
      komp = new Component({ stil: 'kveld' });
      skaler(); planlegg();
      if (komp.componentDidMount) komp.componentDidMount();
      koble();
      lagSpiller();
    } catch (e) { rot.style.cssText = 'padding:40px;color:#F1E9DF;font:16px system-ui'; rot.textContent = 'Rommet startet ikke: ' + (e && e.message ? e.message : e); }
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start); else start();
})();
"""

(OUT.parent / 'covers').mkdir(parents=True, exist_ok=True)
for i in range(8):
    Image.open(S / f'build/atlas/cover{i}.jpg').resize((2000, 2000), Image.LANCZOS).save(OUT.parent / f'covers/cover{i}.jpg', 'JPEG', quality=74, optimize=True, progressive=True)
_pd = json.loads((S / 'build/plater2.json').read_text())
_vf = S / 'build/videoer.json'
if _vf.exists():
    _v = json.loads(_vf.read_text()); _n = 0
    for _r in _pd['recs']:
        _ids = _v.get(str(_r.get('id') or '').split('.')[0])
        if _ids: _r['yt'] = _ids; _n += 1
    print('videoer lagt inn på', _n, 'plater')
PLATEDATA_JSON = json.dumps(_pd, ensure_ascii=False, separators=(',', ':'))
html = f"""<!doctype html>
<html lang="nb">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Rommet">
<meta name="theme-color" content="#151310">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="manifest" href="manifest.webmanifest">
<title>Platesamlingen</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
/* Platesamlingen 1.0 – kveldslys. Bevisst ett mørkt uttrykk, som rommet om kvelden. */
:root{{--bunn:#151310;color-scheme:dark}}
html,body{{height:100%;overflow:hidden}}
body{{margin:0;background:var(--bunn);color:#F1E9DF;font-family:'Archivo',system-ui,sans-serif}}
#ramme{{margin:0 auto;position:relative;overflow:hidden}}
#scene{{width:1366px;height:1024px;transform-origin:0 0;position:absolute;left:0;top:0}}
button,select,input{{font:inherit}}
button:focus-visible,select:focus-visible,input:focus-visible,li:focus-visible{{outline:2px solid #FF7A59;outline-offset:2px}}
#dg{{position:fixed;inset:0;z-index:100;background:rgba(10,8,6,0.62);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:max(24px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 24px max(16px,env(safe-area-inset-left,0px));box-sizing:border-box}}
#dg[hidden]{{display:none}}
.dg-kort{{width:100%;max-width:620px;background:#211C17;color:#F1E9DF;border:1px solid #3A322A;border-radius:8px;padding:22px 26px 26px;box-shadow:0 20px 60px rgba(0,0,0,0.5);font-size:15px;line-height:1.5}}
.dg-topp{{display:flex;justify-content:space-between;align-items:center}}
.dg-kort h2{{margin:0;font-size:28px;font-weight:800;font-stretch:75%;letter-spacing:0.01em}}
.dg-kort h3{{margin:20px 0 8px;font-size:16px;font-weight:700}}
.dg-mono{{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px;letter-spacing:0.06em;color:#BFB2A3}}
.dg-x{{width:40px;height:40px;border-radius:9999px;border:1px solid #3A322A;background:transparent;color:#F1E9DF;font-size:22px;cursor:pointer}}
.dg-steg{{padding-left:22px;display:flex;flex-direction:column;gap:16px;margin:16px 0 4px}}
.dg-steg li::marker{{font-family:'IBM Plex Mono',monospace;color:#FF7A59}}
.dg-prim,.dg-sek{{display:inline-flex;align-items:center;height:42px;padding:0 16px;border-radius:4px;font:700 14px 'Archivo',sans-serif;cursor:pointer;margin-top:8px}}
.dg-prim{{background:#FF7A59;color:#2A0F07;border:0}}
.dg-prim[disabled]{{opacity:0.6;cursor:wait}}
.dg-sek{{background:transparent;color:#F1E9DF;border:1px solid #574B3F}}
.dg-fil input{{position:absolute;width:1px;height:1px;opacity:0}}
.dg-fil:focus-within{{outline:2px solid #FF7A59;outline-offset:2px}}
.dg-liste{{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}}
.dg-liste li{{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between;padding:8px;border-radius:4px;background:#2A241E}}
.dg-plate{{display:flex;gap:10px;align-items:center;min-width:0;flex:1 1 240px}}
.dg-plate img,.dg-tom{{width:44px;height:44px;object-fit:cover;border-radius:2px;flex:none;background:#3A322A}}
.dg-liste select{{height:38px;max-width:100%;border-radius:4px;background:#151310;color:#F1E9DF;border:1px solid #574B3F;font:14px 'Archivo',sans-serif;padding:0 6px}}
.dg-knapper{{display:flex;gap:10px;justify-content:flex-end;margin-top:18px;flex-wrap:wrap}}
.dg-kopi{{width:100%;height:180px;box-sizing:border-box;background:#151310;color:#F1E9DF;border:1px solid #574B3F;border-radius:4px;font:12px 'IBM Plex Mono',monospace}}
.dg-melding{{margin:16px 0 0;padding:10px 12px;border-left:3px solid #FF7A59;background:#2A241E}}
{helmet_css}
{open(S / 'standalone/github.css').read()}
</style>
<script src="https://www.youtube.com/iframe_api" async></script>
</head>
<body>
<script>{(S / 'pkgs/morphdom-2.7.4/package/dist/morphdom-umd.min.js').read_text()}</script>
<script type="application/json" id="platedata">{PLATEDATA_JSON.replace('</', '<\\/')}</script>
<div id="ramme"><div id="scene"><div id="app"></div></div></div>
<script type="text/plain" id="mal">{tpl.replace('</script', '<\\/script')}</script>
<script>{runtime}</script>
<script>
{script}
</script>
</body>
</html>
"""
html = html.replace('__PANEL__', ((S / 'standalone/discogs_panel.js').read_text() + (S / 'standalone/sjanger_panel.js').read_text()).replace("try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }", "dl = { save: ({ filename, data }) => { const a = document.createElement('a'); a.href = URL.createObjectURL(data); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); return Promise.resolve(); } };"))
OUT.write_text(html)
print('skrev', OUT, round(OUT.stat().st_size / 1e6, 1), 'MB')
