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
