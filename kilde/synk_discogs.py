#!/usr/bin/env python3
"""
Synker Platesamlingen (rommet) med Discogs-samlingen din – begge veier.

Slik bruker du det:
  1. I rommet: trykk «Discogs» > «Last ned endringer». Du får fila
     rommet-til-discogs-<dato>.json (vanligvis i Nedlastinger).
  2. Dobbeltklikk synk_discogs.py (legg det gjerne i samme mappe som hent_cover.py
     og token.txt). Skriptet finner den nyeste fila selv, i skriptmappa eller i Nedlastinger.
       - nye plater fra rommet legges til i Discogs (du velger riktig utgave hvis
         rommet ikke vet hvilken det er)
       - plater du har fjernet i rommet fjernes fra Discogs (du bekrefter først)
       - hele samlingen hentes, med omslag for plater rommet ikke har fra før
  3. I rommet: «Discogs» > «Velg discogs-til-rommet.json». Du ser alt som er ulikt
     og velger selv før noe endres.

Tokenet hentes fra DISCOGS_TOKEN, token.txt ved siden av skriptet, eller spørres om.
Pillow (pip install pillow) er valgfritt; med Pillow blir svarfila mindre.
"""
import base64, glob, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone
from io import BytesIO

API = os.environ.get("DISCOGS_API", "https://api.discogs.com")
UA = "PlatesamlingenSynk/1.0"
PAUSE = 1.1  # Discogs tillater ca. 60 kall i minuttet med token
MAPPE = os.path.dirname(os.path.abspath(__file__))

try:
    from PIL import Image
except ImportError:
    Image = None


def kall(metode, sti, token, forsok=5):
    """Kall mot Discogs med token, User-Agent og nye forsøk ved 429/5xx/nettverksfeil."""
    url = sti if sti.startswith("http") else API + sti
    for i in range(forsok):
        req = urllib.request.Request(url, data=(b"" if metode == "POST" else None), method=metode, headers={
            "User-Agent": UA, "Authorization": f"Discogs token={token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                time.sleep(PAUSE)
                return r.status, data
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("Discogs avviste tokenet (401). Sjekk token.txt.")
            if e.code == 404:
                time.sleep(PAUSE)
                return 404, b""
            if e.code == 429 or e.code >= 500:
                vent = 60 if e.code == 429 else 5 * (i + 1)
                print(f"   ... Discogs svarte {e.code}, venter {vent} s")
                time.sleep(vent)
                continue
            raise RuntimeError(f"Discogs svarte {e.code} på {metode} {sti}: {e.read()[:200]!r}")
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"   ... nettverksfeil ({e}), prøver igjen")
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"ga opp etter {forsok} forsøk: {metode} {sti}")


def hent_json(sti, token):
    status, data = kall("GET", sti, token)
    return json.loads(data) if status == 200 and data else None


def les_token():
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    fil = os.path.join(MAPPE, "token.txt")
    if not token and os.path.exists(fil):
        with open(fil, encoding="utf-8-sig") as f:
            token = f.read().strip()
        print("Bruker token fra token.txt")
    if not token:
        print("Lim inn Discogs-tokenet (høyreklikk eller Ctrl+V) og trykk Enter:")
        token = input("> ").strip()
    if not token:
        sys.exit("Mangler token.")
    return token


def finn_eksport():
    if len(sys.argv) > 1:
        return sys.argv[1]
    steder = [MAPPE, os.path.join(os.path.expanduser("~"), "Downloads"), os.path.join(os.path.expanduser("~"), "Nedlastinger")]
    filer = []
    for s in steder:
        filer += glob.glob(os.path.join(s, "rommet-til-discogs*.json"))
    if not filer:
        sys.exit("Fant ingen rommet-til-discogs*.json i skriptmappa eller Nedlastinger.\n"
                 "Trykk «Discogs» > «Last ned endringer» i rommet først.")
    return max(filer, key=os.path.getmtime)


def ja(sporsmal):
    return input(sporsmal + " (j/n) ").strip().lower() in ("j", "ja", "y", "yes")


def rens_artist(navn):
    return re.sub(r"\s*\(\d+\)$", "", (navn or "").strip()).rstrip("*").strip()


def kort_format(formats):
    """Discogs-formater -> rommets s (LP / 10\" / 7\" / CD) og antall n."""
    s, n = "LP", 1
    for f in formats or []:
        navn, besk = f.get("name", ""), " ".join(f.get("descriptions") or [])
        try:
            antall = int(f.get("qty") or 1)
        except ValueError:
            antall = 1
        if navn == "CD":
            return "CD", antall
        if navn == "Vinyl":
            n = antall
            if '7"' in besk:
                s = '7"'
            elif '10"' in besk:
                s = '10"'
            return s, n
    return s, n


def tekst_format(formats):
    deler = []
    for f in formats or []:
        q = f.get("qty") or "1"
        deler.append(("" if str(q) == "1" else f"{q} x ") + ", ".join([f.get("name", "")] + list(f.get("descriptions") or [])))
    return "; ".join(deler)


def finnes_i_samling(bruker, rid, token):
    d = hent_json(f"/users/{urllib.parse.quote(bruker)}/collection/releases/{rid}", token)
    return (d or {}).get("releases") or []


def velg_utgave(p, token):
    """Søker opp en plate uten release-ID og lar deg velge. Returnerer ID eller None."""
    sok = {"artist": p["a"], "release_title": p["t"], "type": "release", "per_page": 10}
    if p.get("s") == "CD":
        sok["format"] = "CD"
    elif p.get("s"):
        sok["format"] = "Vinyl"
    d = hent_json("/database/search?" + urllib.parse.urlencode(sok), token) or {}
    treff = d.get("results") or []
    if not treff:
        d = hent_json("/database/search?" + urllib.parse.urlencode({"q": f'{p["a"]} {p["t"]}', "type": "release", "per_page": 10}), token) or {}
        treff = d.get("results") or []
    print(f'\n  {p["a"]} – {p["t"]}' + (f' ({p["y"]})' if p.get("y") else "") + f' · {p.get("s") or ""}')
    for i, t in enumerate(treff, 1):
        fmt = ", ".join(t.get("format") or [])
        print(f'   {i:2}) {t.get("title")} · {t.get("year") or "?"} · {t.get("country") or "?"} · {fmt} · {", ".join((t.get("label") or [])[:1])} {t.get("catno") or ""}  [id {t.get("id")}]')
    if not treff:
        print("   Fant ingen treff.")
    while True:
        svar = input("   Velg nummer, lim inn Discogs-lenke/ID, eller Enter for å hoppe over: ").strip()
        if not svar:
            return None
        m = re.search(r"release/(\d+)", svar) or re.fullmatch(r"\[?r?(\d{3,})\]?", svar)
        if m:
            return m.group(1)
        if svar.isdigit() and 1 <= int(svar) <= len(treff):
            return str(treff[int(svar) - 1]["id"])
        print("   Forstod ikke svaret, prøv igjen.")


def hent_videoer(rid, token):
    """YouTube-ID-ene Discogs har lagt inn på utgaven, i rekkefølgen de står der."""
    d = hent_json(f"/releases/{rid}", token) or {}
    ids = []
    for v in d.get("videos") or []:
        m = re.search(r"(?:v=|youtu\.be/|embed/)([A-Za-z0-9_-]{11})", v.get("uri") or "")
        if m and m.group(1) not in ids:
            ids.append(m.group(1))
    return ids


def hent_omslag(url, token):
    if not url or url.endswith("spacer.gif"):
        return ""
    try:
        status, data = kall("GET", url, token)
    except Exception as e:
        print(f"   (omslag feilet: {e})")
        return ""
    if status != 200 or not data:
        return ""
    if Image:
        try:
            im = Image.open(BytesIO(data)).convert("RGB")
            im.thumbnail((300, 300))
            b = BytesIO()
            im.save(b, "JPEG", quality=82, optimize=True)
            data = b.getvalue()
        except Exception:
            pass
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


def main():
    eksport = finn_eksport()
    print(f"Bruker {eksport}")
    with open(eksport, encoding="utf-8-sig") as f:
        inn = json.load(f)
    if inn.get("type") != "rommet-til-discogs":
        sys.exit("Fila er ikke en eksport fra rommet.")
    token = les_token()
    bruker = (hent_json("/oauth/identity", token) or {}).get("username")
    if not bruker:
        sys.exit("Fikk ikke brukernavnet fra Discogs.")
    print(f"Innlogget som {bruker}.")

    koblet, lagt_til, fjernet = {}, [], []

    # ---- 1. nye plater fra rommet ----
    nye = inn.get("nye") or []
    if nye:
        print(f"\n=== {len(nye)} nye plater fra rommet ===")
    for p in nye:
        rid = (p.get("rid") or "").strip() or velg_utgave(p, token)
        if not rid:
            print("   Hoppet over (står fortsatt som ventende i rommet).")
            continue
        if p.get("nid") is not None:
            koblet[str(p["nid"])] = rid
        if finnes_i_samling(bruker, rid, token):
            print(f'   {p["a"]} – {p["t"]}: finnes allerede i Discogs-samlingen.')
            continue
        status, _ = kall("POST", f"/users/{urllib.parse.quote(bruker)}/collection/folders/1/releases/{rid}", token)
        if status in (200, 201):
            lagt_til.append(f'{p["a"]} – {p["t"]}')
            print(f'   Lagt til: {p["a"]} – {p["t"]}  [id {rid}]')
        else:
            print(f'   Klarte ikke å legge til {p["a"]} – {p["t"]} (svar {status}).')

    # ---- 2. plater fjernet i rommet ----
    borte = []
    for p in inn.get("fjernet") or []:
        inst = finnes_i_samling(bruker, p["rid"], token)
        if inst:
            borte.append((p, inst))
    if borte:
        print(f"\n=== {len(borte)} plater er fjernet i rommet, men finnes i Discogs ===")
        for p, inst in borte:
            print(f'   - {p["a"]} – {p["t"]}' + (f'  ({len(inst)} eksemplarer i Discogs, ett fjernes)' if len(inst) > 1 else ""))
        valg = input("Fjerne fra Discogs? a = alle, n = ingen, v = velg en og en: ").strip().lower()
        for p, inst in borte:
            if valg == "a" or (valg == "v" and ja(f'   Fjerne {p["a"]} – {p["t"]}?')):
                i = inst[0]
                status, _ = kall("DELETE", f'/users/{urllib.parse.quote(bruker)}/collection/folders/{i["folder_id"]}/releases/{p["rid"]}/instances/{i["instance_id"]}', token)
                if status in (200, 204):
                    fjernet.append(f'{p["a"]} – {p["t"]}')
                    print(f'   Fjernet: {p["a"]} – {p["t"]}')
                else:
                    print(f'   Klarte ikke å fjerne {p["a"]} – {p["t"]} (svar {status}).')

    # ---- 3. hele samlingen ----
    print("\nHenter samlingen fra Discogs ...")
    plater, side, sider = [], 1, 1
    while side <= sider:
        d = hent_json(f"/users/{urllib.parse.quote(bruker)}/collection/folders/0/releases?per_page=100&page={side}&sort=added&sort_order=desc", token) or {}
        sider = (d.get("pagination") or {}).get("pages") or 1
        for r in d.get("releases") or []:
            b = r.get("basic_information") or {}
            s, n = kort_format(b.get("formats"))
            lab = (b.get("labels") or [{}])[0]
            plater.append({
                "rid": str(b.get("id") or r.get("id")), "iid": r.get("instance_id"),
                "a": " & ".join(rens_artist(a.get("name")) for a in b.get("artists") or []) or "Ukjent",
                "t": b.get("title") or "", "y": b.get("year") or 0, "s": s, "n": n,
                "fmt": tekst_format(b.get("formats")), "lb": lab.get("name", ""), "cat": lab.get("catno", ""),
                "lagt": r.get("date_added") or "", "_bilde": b.get("cover_image") or b.get("thumb") or "",
            })
        print(f"   side {side} av {sider}")
        side += 1

    kjente = set(str(x) for x in inn.get("kjente") or []) | set(koblet.values())
    ukjente = [p for p in plater if p["rid"] not in kjente]
    if ukjente:
        print(f"\nHenter omslag for {len(ukjente)} plater rommet ikke har fra før ...")
    for n, p in enumerate(ukjente, 1):
        print(f"   [{n}/{len(ukjente)}] {p['a']} – {p['t']}")
        p["bilde"] = hent_omslag(p["_bilde"], token)
        p["yt"] = hent_videoer(p["rid"], token)
    # YouTube-lister også for plater fra rommet som nettopp fikk Discogs-ID
    videoer = {}
    for rid in set(koblet.values()):
        videoer[rid] = hent_videoer(rid, token)
    for p in plater:
        p.pop("_bilde", None)

    ut = {"type": "discogs-til-rommet", "versjon": 1, "laget": datetime.now(timezone.utc).isoformat(timespec="seconds"),
          "bruker": bruker, "koblet": koblet, "videoer": videoer, "plater": plater}
    sti = os.path.join(os.path.dirname(os.path.abspath(eksport)), "discogs-til-rommet.json")
    with open(sti, "w", encoding="utf-8") as f:
        json.dump(ut, f, ensure_ascii=False)

    print("\n=== Ferdig ===")
    print(f"Lagt til i Discogs: {len(lagt_til)}   Fjernet fra Discogs: {len(fjernet)}   Plater i Discogs nå: {len(plater)}")
    print(f"Svarfila er lagret her:\n   {sti}")
    print("Gå til rommet > «Discogs» > «Velg discogs-til-rommet.json».")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(e.code)
    except KeyboardInterrupt:
        print("\nAvbrutt. Ingenting mer ble endret i Discogs.")
    except Exception as e:
        print(f"Uventet feil: {e}")
    try:
        input("\nTrykk Enter for å lukke vinduet ...")
    except EOFError:
        pass
