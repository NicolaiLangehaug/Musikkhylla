  // ---------- Discogs: send endringer ut som fil, les inn svaret fra synk_discogs.py ----------
  const DG = { open: false, steg: 'start', melding: '', valg: [], svar: null, nyeKort: 0, laster: false };
  const hEsc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const idag = () => { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
  const MND = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
  const pen = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? iso : d.getDate() + '. ' + MND[d.getMonth()] + ' ' + d.getFullYear(); };

  // alle plater i rommet med indeks, slik komponenten teller dem (grunnlista + nye)
  function alle() {
    const st = komp.state || {}, R = komp.d.recs, ex = st.extra || [], gone = st.gone || {};
    return R.concat(ex).map((r, i) => ({ r, i, ny: i >= R.length, borte: (r.gone && gone[i] !== false) || !!gone[i], rid: String(r.id || '').trim() }));
  }
  function iKo() {
    const st = komp.state || {}, ds = st.discogs || {}, kjent = ds.rids ? new Set(ds.rids) : null, leggTil = ds.leggTil || {};
    const nye = [], fjernet = [];
    alle().forEach((p) => {
      if (p.borte) {
        if (p.rid && (!kjent || kjent.has(p.rid)) && !(ds.ignorert || {})[p.rid]) fjernet.push({ rid: p.rid, a: p.r.a, t: p.r.t });
      } else if (p.ny && !p.r.iDiscogs) {
        nye.push({ nid: p.r.nid, a: p.r.a, t: p.r.t, y: p.r.y || 0, s: p.r.s, n: p.r.n || 1, rid: p.rid });
      } else if (p.rid && leggTil[p.rid]) {
        nye.push({ nid: null, a: p.r.a, t: p.r.t, y: p.r.y || 0, s: p.r.s, n: p.r.n || 1, rid: p.rid });
      }
    });
    return { nye, fjernet };
  }

  async function lastNed() {
    const v = iKo();
    const fil = { type: 'rommet-til-discogs', versjon: 1, laget: new Date().toISOString(), nye: v.nye, fjernet: v.fjernet,
      kjente: Array.from(new Set(alle().map((p) => p.rid).filter(Boolean))) };
    const tekst = JSON.stringify(fil, null, 1), navn = 'rommet-til-discogs-' + idag() + '.json';
    let dl = null;
    try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
    if (dl) {
      try { await dl.save({ filename: navn, data: new Blob([tekst], { type: 'application/json' }) }); DG.melding = 'Fila ' + navn + ' er lastet ned. Kjør synk_discogs.py på PC-en.'; }
      catch (e) { DG.melding = 'Nedlastingen ble ikke fullført' + (e && e.code ? ' (' + e.code + ')' : '') + '.'; }
    } else {
      DG.steg = 'kopier'; DG.kopi = tekst; DG.kopiNavn = navn;
    }
    tegnDG();
  }

  // ---- innlesing og gjennomgang ----
  function lesSvar(fil) {
    const fr = new FileReader();
    fr.onload = () => {
      let d;
      try { d = JSON.parse(fr.result); } catch (e) { DG.melding = 'Fila er ikke gyldig JSON.'; return tegnDG(); }
      if (!d || d.type !== 'discogs-til-rommet' || !Array.isArray(d.plater)) { DG.melding = 'Dette er ikke en svarfil fra synk_discogs.py (discogs-til-rommet …json).'; return tegnDG(); }
      DG.svar = d; DG.valg = gjennomgang(d); DG.steg = 'gjennomgang'; DG.melding = '';
      tegnDG();
    };
    fr.readAsText(fil);
  }
  function gjennomgang(d) {
    const st = komp.state || {}, ds = st.discogs || {}, ign = ds.ignorert || {};
    const koblet = d.koblet || {};
    const P = alle().map((p) => { if (p.ny && !p.rid && koblet[p.r.nid]) p.rid = String(koblet[p.r.nid]); return p; });
    const disc = new Map(); d.plater.forEach((x) => { if (!disc.has(String(x.rid))) disc.set(String(x.rid), x); });
    const aktiv = new Set(P.filter((p) => !p.borte && p.rid).map((p) => p.rid)), borte = new Set(P.filter((p) => p.borte && p.rid).map((p) => p.rid));
    const v = [];
    disc.forEach((x, rid) => {
      if (aktiv.has(rid)) return;
      if (borte.has(rid)) {
        if (ign[rid]) return;
        v.push({ type: 'borte-her', rid, a: x.a, t: x.t, y: x.y, valg: 'fjernDiscogs',
          alt: [['fjernDiscogs', 'Fjern fra Discogs ved neste synk'], ['tilbake', 'Ta den tilbake i rommet'], ['ignorer', 'La være som det er']] });
      } else if (!ign[rid]) {
        v.push({ type: 'ny-discogs', rid, a: x.a, t: x.t, y: x.y, fmt: x.fmt, bilde: x.bilde, x, valg: 'leggInn',
          alt: [['leggInn', 'Legg den i «Ny i hus»'], ['ignorer', 'Ikke i rommet']] });
      }
    });
    const sett = new Set();
    P.forEach((p) => {
      if (p.borte || !p.rid || disc.has(p.rid) || sett.has(p.rid) || ign[p.rid]) return;
      sett.add(p.rid);
      v.push({ type: 'mangler-discogs', rid: p.rid, a: p.r.a, t: p.r.t, y: p.r.y, i: p.i, valg: 'leggTil',
        alt: [['leggTil', 'Legg den til i Discogs ved neste synk'], ['fjern', 'Fjern den fra rommet'], ['ignorer', 'Behold bare i rommet']] });
    });
    return v;
  }

  // nedskalering av omslag fra Discogs til 300 px + rygg-farge
  function lagOmslag(src) {
    return new Promise((ok) => {
      if (!src) return ok({ img: '', sc: '#8A7F72' });
      const im = new Image();
      im.onload = () => {
        try {
          const S = 300, cv = document.createElement('canvas'); cv.width = S; cv.height = S;
          const x = cv.getContext('2d'), m = Math.min(im.width, im.height);
          x.drawImage(im, (im.width - m) / 2, (im.height - m) / 2, m, m, 0, 0, S, S);
          const px = x.getImageData(0, 0, S, S).data; let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < px.length; i += 4 * 97) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
          const hx = (v) => ('0' + Math.round(v / n).toString(16)).slice(-2);
          ok({ img: cv.toDataURL('image/jpeg', 0.82), sc: '#' + hx(r) + hx(g) + hx(b) });
        } catch (e) { ok({ img: '', sc: '#8A7F72' }); }
      };
      im.onerror = () => ok({ img: '', sc: '#8A7F72' });
      im.src = src;
    });
  }

  async function brukValg() {
    if (DG.laster) return;
    DG.laster = true; tegnDG();
    const st = komp.state || {}, R = komp.d.recs, d = DG.svar, koblet = d.koblet || {};
    const ds = Object.assign({ ignorert: {}, leggTil: {} }, st.discogs || {});
    ds.ignorert = Object.assign({}, ds.ignorert); ds.leggTil = Object.assign({}, ds.leggTil);
    const discSet = new Set(d.plater.map((x) => String(x.rid)));
    // nye plater som skriptet fant i Discogs: lagre release-ID og merk dem som sendt
    let extra = (st.extra || []).map((x) => {
      const rid = String(x.id || koblet[x.nid] || '');
      const yt = (d.videoer || {})[rid];
      return rid ? Object.assign({}, x, { id: rid, url: x.url || 'https://www.discogs.com/release/' + rid, iDiscogs: discSet.has(rid) }, yt && yt.length ? { yt } : {}) : x;
    });
    const gone = Object.assign({}, st.gone || {});
    Object.keys(ds.leggTil).forEach((rid) => { if (discSet.has(rid)) delete ds.leggTil[rid]; });
    const uplassert = komp.d.genres.findIndex((G) => G.name === 'Uplassert');
    let nid = Date.now(), lagtInn = 0;
    for (const v of DG.valg) {
      if (v.valg === 'ignorer') { ds.ignorert[v.rid] = true; continue; }
      if (v.type === 'ny-discogs' && v.valg === 'leggInn') {
        const x = v.x, om = await lagOmslag(x.bilde);
        let sug = komp.suggest(x.a);
        if (sug < 0) { const k = komp.norm(x.a), f = extra.find((e) => komp.norm(e.a) === k && e.g !== uplassert); if (f) sug = f.g; }
        const s = x.s || 'LP', n = x.n || 1;
        extra = extra.concat([{
          a: x.a, t: x.t, g: sug >= 0 ? sug : uplassert, y: x.y || 0, s, n, fmt: x.fmt || ((n > 1 ? n + ' x ' : '') + (s === 'CD' ? 'CD' : 'Vinyl ' + s)),
          st: 0, r: '', lb: x.lb || '', cat: x.cat || '', c: '', kj: 'Fra Discogs ' + pen(x.lagt || d.laget), w: komp.wishFor(x.a), id: String(x.rid),
          url: 'https://www.discogs.com/release/' + x.rid, re: false, cv: null, sc: om.sc, nyImg: om.img, ny: true, homed: false, nid: nid++, iDiscogs: true, yt: x.yt || [],
        }]);
        lagtInn++;
      }
      if (v.type === 'borte-her' && v.valg === 'tilbake') {
        alle().forEach((p) => { if (p.borte && p.rid === v.rid) gone[p.i] = false; });
      }
      if (v.type === 'mangler-discogs') {
        if (v.valg === 'leggTil') ds.leggTil[v.rid] = true;
        if (v.valg === 'fjern') { alle().forEach((p) => { if (!p.borte && p.rid === v.rid) gone[p.i] = true; }); }
      }
    }
    ds.rids = Array.from(discSet); ds.sist = d.laget || new Date().toISOString(); ds.bruker = d.bruker || ds.bruker || '';
    const endr = { extra, gone, discogs: ds };
    if (lagtInn) Object.assign(endr, { panel: true, cont: 11, gsel: -1, idx: 0, sel: -1 });
    komp.setState(endr);
    DG.laster = false; DG.steg = 'start'; DG.svar = null; DG.valg = [];
    DG.melding = 'Ferdig. ' + (lagtInn ? lagtInn + ' ' + (lagtInn === 1 ? 'plate står' : 'plater står') + ' nå i «Ny i hus».' : 'Rommet og Discogs er avstemt.');
    tegnDG();
  }

  // ---- tegning av panelet (eget lag over rommet, i vanlige skjermpiksler) ----
  function tegnDG() {
    let el = document.getElementById('dg');
    if (!el) { el = document.createElement('div'); el.id = 'dg'; document.body.appendChild(el); }
    el.hidden = !DG.open;
    if (!DG.open || !komp || !komp.d) return;
    const st = komp.state || {}, ds = st.discogs || {}, v = iKo();
    const uten = v.nye.filter((x) => !x.rid).length;
    let h = '<div class="dg-kort" role="dialog" aria-modal="true" aria-labelledby="dg-t">';
    h += '<div class="dg-topp"><h2 id="dg-t">Discogs</h2><button type="button" class="dg-x" data-dg="lukk" aria-label="Lukk">×</button></div>';
    if (DG.steg === 'gjennomgang') {
      const n = DG.valg.length, svar = DG.svar;
      h += '<p class="dg-mono">SVAR FRA DISCOGS · ' + hEsc(pen(svar.laget)) + (svar.bruker ? ' · ' + hEsc(svar.bruker) : '') + ' · ' + svar.plater.length + ' PLATER</p>';
      if (!n) h += '<p>Ingenting å avklare. Trykk «Bruk» for å lagre at rommet og Discogs er avstemt.</p>';
      const grupper = [['ny-discogs', 'Nye i Discogs'], ['borte-her', 'Fjernet i rommet, men finnes i Discogs'], ['mangler-discogs', 'I rommet, men ikke i Discogs']];
      grupper.forEach(([t, navn]) => {
        const g = DG.valg.map((x, i) => [x, i]).filter(([x]) => x.type === t);
        if (!g.length) return;
        h += '<h3>' + navn + ' <span class="dg-mono">' + g.length + '</span></h3><ul class="dg-liste">';
        g.forEach(([x, i]) => {
          h += '<li><div class="dg-plate">' + (x.bilde ? '<img src="' + hEsc(x.bilde) + '" alt="">' : '<span class="dg-tom"></span>') + '<div><b>' + hEsc(x.a) + '</b><br>' + hEsc(x.t) + (x.y ? ' <span class="dg-mono">' + x.y + '</span>' : '') + '</div></div>';
          h += '<select data-dg-valg="' + i + '" aria-label="Hva skal skje med ' + hEsc(x.a + ' – ' + x.t) + '">' + x.alt.map(([k, tx]) => '<option value="' + k + '"' + (x.valg === k ? ' selected' : '') + '>' + tx + '</option>').join('') + '</select></li>';
        });
        h += '</ul>';
      });
      h += '<div class="dg-knapper"><button type="button" data-dg="avbryt" class="dg-sek">Avbryt</button><button type="button" data-dg="bruk" class="dg-prim"' + (DG.laster ? ' disabled' : '') + '>' + (DG.laster ? 'Lagrer …' : 'Bruk') + '</button></div>';
    } else if (DG.steg === 'kopier') {
      h += '<p>Nedlasting er ikke tilgjengelig her. Kopier teksten og lagre den som <b>' + hEsc(DG.kopiNavn) + '</b> i samme mappe som synk_discogs.py.</p>';
      h += '<textarea class="dg-kopi" readonly>' + hEsc(DG.kopi) + '</textarea>';
      h += '<div class="dg-knapper"><button type="button" data-dg="tilbake" class="dg-sek">Tilbake</button><button type="button" data-dg="kopier" class="dg-prim">Kopier</button></div>';
    } else {
      h += '<p class="dg-mono">' + (ds.sist ? 'SIST AVSTEMT ' + hEsc(pen(ds.sist).toUpperCase()) + (ds.bruker ? ' · ' + hEsc(ds.bruker) : '') : 'IKKE AVSTEMT ENNÅ') + '</p>';
      h += '<ol class="dg-steg">';
      h += '<li><b>Send endringene fra rommet.</b> Venter: ' + v.nye.length + ' ' + (v.nye.length === 1 ? 'ny plate' : 'nye plater') + (uten ? ' (' + uten + ' uten Discogs-lenke, skriptet søker dem opp)' : '') + ' og ' + v.fjernet.length + ' ' + (v.fjernet.length === 1 ? 'fjernet' : 'fjernede') + '.' + (ds.sist ? '' : ' Første gang kommer alle plater du har fjernet i rommet med, også de som allerede er borte fra Discogs. Skriptet hopper over dem.') + '<br><button type="button" data-dg="last" class="dg-prim">Last ned endringer</button></li>';
      h += '<li><b>Kjør synk_discogs.py på PC-en.</b> Det legger til og fjerner i Discogs (og spør deg underveis), henter hele samlingen og lager <span class="dg-mono">discogs-til-rommet.json</span>.</li>';
      h += '<li><b>Les inn svaret.</b> Du får se alt som er ulikt og velger selv før noe endres.<br><label class="dg-prim dg-fil">Velg discogs-til-rommet.json<input type="file" accept=".json,application/json" data-dg-fil></label></li>';
      h += '</ol>';
    }
    if (DG.melding) h += '<p class="dg-melding" role="status">' + hEsc(DG.melding) + '</p>';
    h += '</div>';
    el.innerHTML = h;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-dg]');
    if (e.target.id === 'dg') { DG.open = false; return tegnDG(); }
    if (!b) return;
    const a = b.getAttribute('data-dg');
    if (a === 'lukk') { DG.open = false; DG.melding = ''; }
    if (a === 'last') { lastNed(); return; }
    if (a === 'avbryt' || a === 'tilbake') { DG.steg = 'start'; DG.svar = null; DG.valg = []; DG.melding = ''; }
    if (a === 'bruk') { brukValg(); return; }
    if (a === 'kopier') {
      const ta = document.querySelector('.dg-kopi');
      const ok = () => { DG.melding = 'Kopiert.'; tegnDG(); };
      try { navigator.clipboard.writeText(DG.kopi).then(ok, () => { ta.select(); }); } catch (er) { ta.select(); }
      return;
    }
    tegnDG();
  });
  document.addEventListener('change', (e) => {
    if (e.target.matches && e.target.matches('[data-dg-valg]')) { DG.valg[+e.target.getAttribute('data-dg-valg')].valg = e.target.value; }
    if (e.target.matches && e.target.matches('[data-dg-fil]') && e.target.files[0]) lesSvar(e.target.files[0]);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && DG.open) { DG.open = false; tegnDG(); } });
  window.discogsÅpne = () => { DG.open = true; DG.melding = ''; tegnDG(); };
  window.__dg = DG;
