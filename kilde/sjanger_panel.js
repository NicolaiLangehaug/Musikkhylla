  // ---------- Sjangeroversikt: familier og undersjangre med antall og plass; velg for å lyse dem opp i hylla ----------
  const SJ = { open: false };
  const famAv = (G) => (G.fam === 'Ambient/Post-rock' ? G.name : G.fam);
  function sjData() {
    const d = komp.d, L = komp.lastL, G = d.genres, PL = komp.PL;
    if (!L) return [];
    const per = G.map(() => ({ n: 0, celler: new Set() }));
    for (let i = 0; i < L.where.length; i++) {
      if (L.where[i] === 13 || L.where[i] === 10) continue;  // CD-ene har ingen sjanger, bare alfabet
      const g = L.g(i); if (g === undefined || !per[g]) continue;
      per[g].n++; per[g].celler.add(L.where[i]);
    }
    const orden = G.map((g, gi) => gi).filter((gi) => per[gi].n).sort((a, b) => komp.rank[a] - komp.rank[b]);
    const fam = [];
    orden.forEach((gi) => {
      const f = famAv(G[gi]); let F = fam.find((x) => x.f === f);
      if (!F) { F = { f, gs: [], n: 0, col: G[gi].col }; fam.push(F); }
      F.gs.push(gi); F.n += per[gi].n;
      if (G[gi].name.indexOf(f + '-') === 0 && !F.egen) { F.col = G[gi].col; F.egen = true; }
    });
    const celleNavn = (set) => [...set].sort((a, b) => a - b).map((k) => (k <= 7 ? String(k + 1) : PL[k].name.toLowerCase())).join(', ');
    return fam.map((F) => Object.assign(F, {
      subs: F.gs.map((gi) => ({ gi, name: G[gi].name, n: per[gi].n, celler: celleNavn(per[gi].celler), forste: Math.min(...per[gi].celler) })),
      celler: celleNavn(new Set(F.gs.flatMap((gi) => [...per[gi].celler]))),
    }));
  }
  function sjMarker(gs, navn) {
    SJ.open = false; tegnSJ();
    komp.setState({ hl: gs, hlNavn: navn, panel: false, sel: -1, q: '' });
    // rull hylla dit sjangeren står
    setTimeout(() => {
      const el = document.getElementById('romboks'), L = komp.lastL, g = komp.turnGeo;
      if (!el || !L || !g) return;
      const celler = []; for (let i = 0; i < L.where.length; i++) if (gs.indexOf(L.g(i)) >= 0 && L.where[i] <= 7) celler.push(L.where[i]);
      if (!celler.length) return;
      const ks = [...new Set(celler)], k0 = Math.min(...ks), k1 = Math.max(...ks.filter((k) => k < 6).concat([k0]));
      if (k0 >= 6) { el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }); return; }
      // midt på cellene der sjangeren står, men innenfor langveggen (før rommet begynner å dreie)
      const midt = (komp.PL[k0].x + komp.PL[k1].x + komp.PL[k1].w) / 2 + 32;
      el.scrollTo({ left: Math.max(0, Math.min(g.p1, midt - g.V / 2)) * g.S2, behavior: 'smooth' });
    }, 80);
  }
  function tegnSJ() {
    let el = document.getElementById('sj');
    if (!el) { el = document.createElement('div'); el.id = 'sj'; document.body.appendChild(el); }
    el.hidden = !SJ.open;
    if (!SJ.open || !komp || !komp.d) return;
    const data = sjData(), tot = data.reduce((s, F) => s + F.n, 0), maks = Math.max(...data.map((F) => F.n));
    let h = '<div class="sj-kort" role="dialog" aria-modal="true" aria-labelledby="sj-t"><div class="sj-topp"><h2 id="sj-t">Sjangre</h2><span class="sj-mono"></span><button type="button" class="dg-x" data-sj="lukk" aria-label="Lukk">×</button></div>';
    h += '<p class="sj-hjelp">Velg en familie eller sjanger for å lyse den opp i hylla.</p><ul class="sj-liste">';
    data.forEach((F, fi) => {
      h += '<li><button type="button" class="sj-fam" data-sj-fam="' + fi + '"><span class="sj-prikk" style="background:' + F.col + ';box-shadow:0 0 8px ' + F.col + '"></span><span class="sj-navn">' + hEsc(F.f) + '</span>' +
        '</button>';
      if (F.subs.length > 1) {
        h += '<ul class="sj-sub">';
        F.subs.forEach((S, si) => {
          const kort = S.name.indexOf(F.f + '-') === 0 ? S.name.slice(F.f.length + 1) : S.name.indexOf('-') > 0 ? S.name.slice(S.name.indexOf('-') + 1) : S.name;
          h += '<li><button type="button" class="sj-und" data-sj-sub="' + fi + ':' + si + '"><span class="sj-navn">' + hEsc(kort) + '</span></button></li>';
        });
        h += '</ul>';
      }
      h += '</li>';
    });
    // andre steder i rommet (ikke sortert etter sjanger)
    const ST = [[9, 'Boksene'], [10, 'CD-mappene'], [8, 'Stativet · 7" og 10"']];
    h += '<li class="sj-andre"><span class="sj-mono">ANDRE STEDER</span></li>';
    ST.forEach(([k, navn]) => {
      const n = (komp.lastL.lists[k] || []).length;
      h += '<li><button type="button" class="sj-fam" data-sj-sted="' + k + '"><span class="sj-prikk" style="background:#F1E9DF"></span><span class="sj-navn">' + hEsc(navn) + '</span></button></li>';
    });
    h += '</ul></div>';
    el.innerHTML = h;
    el._data = data;
  }
  // merkelapp under toppen når noe er markert, med kryss for å vise alt igjen
  function tegnMerke() {
    let m = document.getElementById('sj-merke');
    const st = (komp && komp.state) || {}, vis = st.hl && st.hl.length && !st.q;
    if (!vis) { if (m) m.hidden = true; return; }
    if (!m) { m = document.createElement('button'); m.id = 'sj-merke'; m.type = 'button'; document.body.appendChild(m); m.onclick = () => komp.setState({ hl: null, hlNavn: '' }); }
    m.hidden = false;
    m.innerHTML = 'Viser: <b>' + hEsc(st.hlNavn || '') + '</b><span aria-hidden="true">×</span>';
    m.setAttribute('aria-label', 'Viser ' + (st.hlNavn || '') + '. Trykk for å vise alle plater.');
  }
  // spilleren flytter seg til venstre når et sidepanel (ny plate, platekort) ligger til høyre, så den ikke dekker knappene
  window.etterTegning = () => {
    tegnMerke();
    const sp = document.getElementById('spiller');
    if (sp) sp.classList.toggle('venstre', !!document.querySelector('#app aside'));
  };
  document.addEventListener('click', (e) => {
    const el = document.getElementById('sj'); if (!el || el.hidden) return;
    if (e.target === el || (e.target.closest && e.target.closest('[data-sj="lukk"]'))) { SJ.open = false; return tegnSJ(); }
    const f = e.target.closest && e.target.closest('[data-sj-fam]'), u = e.target.closest && e.target.closest('[data-sj-sub]');
    if (f) { const F = el._data[+f.dataset.sjFam]; sjMarker(F.gs, F.f); }
    const sted = e.target.closest && e.target.closest('[data-sj-sted]');
    if (sted) { SJ.open = false; tegnSJ(); komp.setState({ panel: true, cont: +sted.dataset.sjSted, gsel: -1, idx: 0, sel: -1, hl: null, q: '' }); }
    if (u) { const [fi, si] = u.dataset.sjSub.split(':').map(Number), S = el._data[fi].subs[si]; sjMarker([S.gi], S.name); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (SJ.open) { SJ.open = false; tegnSJ(); } else if (komp && komp.state && komp.state.hl) komp.setState({ hl: null, hlNavn: '' });
  });
  window.sjangreÅpne = () => { SJ.open = true; tegnSJ(); };
