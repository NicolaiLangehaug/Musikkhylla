#!/usr/bin/env python3
"""
Henter cover fra Discogs for hver plate i Platesamling.csv.

Bruk:
    python3 hent_cover.py Platesamling.csv

Krever et personlig Discogs-token (gratis):
    discogs.com > Settings > Developers > "Generate new token"
Tokenet kan settes som miljøvariabel DISCOGS_TOKEN, ellers spør skriptet om det.

Resultat:
    cover/<ReleaseID>.jpg   - ett bilde per plate
    cover_logg.csv          - status per plate (ok / mangler / feil)
    cover.zip               - alt samlet, klar til opplasting

Skriptet kan avbrytes og startes på nytt: bilder som allerede er hentet hoppes over.
Pillow (pip install pillow) er valgfritt; med Pillow skaleres bildene ned til 400 px.
"""
import csv, getpass, json, os, shutil, sys, time, urllib.error, urllib.request
from io import BytesIO

API = os.environ.get("DISCOGS_API", "https://api.discogs.com")
UA = "PlatesamlingCoverHenter/1.0"
MAKS_PX = 400
PAUSE = 1.1  # Discogs tillater ca. 60 kall i minuttet med token

try:
    from PIL import Image
except ImportError:
    Image = None


def hent(url, token, forsok=5):
    """GET med token, User-Agent og ny-forsøk ved 429/5xx/nettverksfeil."""
    for i in range(forsok):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Authorization": f"Discogs token={token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("Discogs avviste tokenet (401). Sjekk at det er riktig.")
            if e.code == 404:
                return None, None
            if e.code == 429 or e.code >= 500:
                vent = 60 if e.code == 429 else 5 * (i + 1)
                print(f"   ... {e.code}, venter {vent} s")
                time.sleep(vent)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"   ... nettverksfeil ({e}), prøver igjen")
            time.sleep(5 * (i + 1))
    raise RuntimeError("ga opp etter flere forsøk")


def lagre_bilde(data, sti):
    if Image:
        try:
            im = Image.open(BytesIO(data)).convert("RGB")
            im.thumbnail((MAKS_PX, MAKS_PX))
            im.save(sti, "JPEG", quality=82, optimize=True)
            return
        except Exception:
            pass  # ukjent bildeformat: lagre originalen
    with open(sti, "wb") as f:
        f.write(data)


def finn_csv():
    """Uten argument: let etter en CSV med 'Release ID' i samme mappe som skriptet."""
    mappe = os.path.dirname(os.path.abspath(__file__))
    kandidater = sorted(f for f in os.listdir(mappe) if f.lower().endswith(".csv")
                        and f != "cover_logg.csv")
    kandidater.sort(key=lambda f: "platesamling" not in f.lower())
    for f in kandidater:
        sti = os.path.join(mappe, f)
        with open(sti, encoding="utf-8-sig", errors="ignore") as fh:
            if "Release ID" in fh.readline():
                return sti
    sys.exit(f"Fant ingen Platesamling.csv i {mappe}. Legg CSV-fila i samme mappe som skriptet.")


def main():
    csv_sti = sys.argv[1] if len(sys.argv) > 1 else finn_csv()
    print(f"Bruker {csv_sti}")
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    token_fil = os.path.join(os.path.dirname(os.path.abspath(__file__)), "token.txt")
    if not token and os.path.exists(token_fil):
        with open(token_fil, encoding="utf-8-sig") as f:
            token = f.read().strip()
        print("Bruker token fra token.txt")
    if not token:
        print("Lim inn Discogs-tokenet (høyreklikk eller Ctrl+V) og trykk Enter:")
        token = input("> ").strip()
    if not token:
        sys.exit("Mangler token.")

    with open(csv_sti, encoding="utf-8-sig", newline="") as f:
        rader = [r for r in csv.DictReader(f) if (r.get("Release ID") or "").strip()]
    if not rader:
        sys.exit("Fant ingen rader med 'Release ID' i CSV-fila.")

    mappe = os.path.join(os.path.dirname(os.path.abspath(csv_sti)), "cover")
    os.makedirs(mappe, exist_ok=True)
    logg = []
    print(f"{len(rader)} plater. {'Skalerer med Pillow.' if Image else 'Pillow mangler – lagrer originalstørrelse.'}")

    for n, r in enumerate(rader, 1):
        rid = r["Release ID"].strip().split(".")[0]
        navn = f"{r.get('Artist','')} – {r.get('Tittel','')}"
        sti = os.path.join(mappe, f"{rid}.jpg")
        if os.path.exists(sti) and os.path.getsize(sti) > 0:
            logg.append((rid, navn, "ok (fantes)"))
            continue
        print(f"[{n}/{len(rader)}] {navn}")
        try:
            data, _ = hent(f"{API}/releases/{rid}", token)
            time.sleep(PAUSE)
            if data is None:
                logg.append((rid, navn, "mangler: release finnes ikke"))
                continue
            bilder = json.loads(data).get("images") or []
            if not bilder:
                logg.append((rid, navn, "mangler: ingen bilder på Discogs"))
                continue
            valgt = next((b for b in bilder if b.get("type") == "primary"), bilder[0])
            url = valgt.get("uri") or valgt.get("resource_url")
            bilde, _ = hent(url, token)
            if not bilde:
                logg.append((rid, navn, "feil: bildet kunne ikke lastes ned"))
                continue
            lagre_bilde(bilde, sti)
            logg.append((rid, navn, "ok"))
        except Exception as e:
            logg.append((rid, navn, f"feil: {e}"))
            print(f"   feil: {e}")

    logg_sti = os.path.join(os.path.dirname(mappe), "cover_logg.csv")
    with open(logg_sti, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Release ID", "Plate", "Status"])
        w.writerows(logg)
    shutil.make_archive(os.path.join(os.path.dirname(mappe), "cover"), "zip", mappe)

    ok = sum(1 for l in logg if l[2].startswith("ok"))
    print(f"\nFerdig: {ok} av {len(rader)} cover hentet.")
    if ok < len(rader):
        print(f"Se {logg_sti} for platene som mangler.")
    print("Last opp cover.zip (og gjerne cover_logg.csv) i samtalen.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(e.code)
    except Exception as e:
        print(f"Uventet feil: {e}")
    # Hold vinduet åpent når skriptet startes med dobbeltklikk
    try:
        input("\nTrykk Enter for å lukke vinduet ...")
    except EOFError:
        pass
