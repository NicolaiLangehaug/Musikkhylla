# Rommet – kildekode og overlevering

Nettside: https://nicolailangehaug.github.io/Musikkhylla/  ·  Prosjekt: github.com/NicolaiLangehaug/Musikkhylla

## Bygge
Fra prosjektets rot (Python 3 + Pillow):

    python3 kilde/standalone/bygg_github.py kilde index.html

Skriver `index.html` og `covers/`. `data/tilstand.json` (endringene fra rommet) røres aldri.
Etter bygging: last opp `index.html` (og `kilde/` hvis kilden er endret). Ikke last opp `data/`.

## Filer
- `canvas/project/Rommet.dc.html` – selve rommet: mal ({{hull}}, sc-for, sc-if) + klassen Component (logikk)
- `standalone/bygg_github.py` – bygger siden: liten malmotor + morphdom, setter inn panelene og CSS
- `standalone/github_lagring.js` – lagring til GitHub (data/tilstand.json via nøkkel i nettleseren), statusmerke, YouTube-spiller
- `standalone/sjanger_panel.js` – Sjangre-knappen: oversikt, markering i hylla, flytting av spilleren
- `standalone/discogs_panel.js` – Discogs-panelet (eksport/innlesing for synk_discogs.py)
- `standalone/github.css` – stil for alt utenfor rommet
- `build/plater2.json` – 793 plater + sjangre (navn, fam, farge); `build/videoer.json` – YouTube-ID-er fra Discogs
- `build/atlas/` – omslag, 8 ark à 10×10 (300 px celler)
- `skript/` – hent_cover.py, hent_videoer.py, synk_discogs.py (kjøres på PC, Discogs-token i token.txt)

## Beslutninger (Nico)
- Stil: kveldslys. Alt heter «celle». Celle 1–6 langvegg (2 og 5 er smale), 7–8 kasser på kortveggen. Nye plater står mot den oransje stolen («Ny i hus»).
- Sjangerrekkefølge i hylla: Pønk, Hardt-lett, Hardt-kaos, Hardt-seigt, Rock-bøtta, Rock-proggy, Post-rock, Ambient/minimalisme, Jazz rock, Jazz-gammel, Jazz-ny, Rocksteady, Lav Gitar/Folk, Electro, HipHop/TripHop, Indie/Pop, Uplassert.
- Familier: Hardt (lett/kaos/seigt), Rock (bøtta/proggy), Jazz (Jazz rock/gammel/ny). Post-rock og Ambient er IKKE samme familie. Navn: «Rocksteady», «Lav Gitar/Folk», «Jazz rock».
- Oversikt: bare familier + lyslist i familiens farge under hylla; undersjangre når du trykker deg inn; Sjangre-knapp med liste og markering.
- Musikk: spiller i rommet (YouTube), videoer fra Discogs eller lenke lagt inn på ny plate.

## Backlog
- YouTube-lenke på eksisterende plater (via platekortet)
- Fotovisning gjort bedre; vise hvor i cellen plata står; eksport av ønskeliste/endringer
