#!/usr/bin/env python3
"""
Henter YouTube-videoene Discogs har lagt inn på hver plate i Platesamling.csv,
så rommet kan sette på riktig album når du trykker «Sett på platespilleren».

Bruk: legg skriptet i samme mappe som Platesamling.csv og token.txt, og dobbeltklikk.
Det tar ca. 15 minutter for 800 plater (Discogs tillater ca. 60 oppslag i minuttet).
Kan avbrytes og startes på nytt: plater som allerede er hentet hoppes over.

Resultat: videoer.json (Release ID -> liste med YouTube-ID-er). Last den opp i samtalen.
"""
import csv, json, os, re, sys, time, urllib.error, urllib.request

API = os.environ.get("DISCOGS_API", "https://api.discogs.com")
UA = "PlatesamlingenVideoer/1.0"
PAUSE = 1.1
MAPPE = os.path.dirname(os.path.abspath(__file__))
UT = os.path.join(MAPPE, "videoer.json")


def hent(url, token, forsok=5):
    for i in range(forsok):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Authorization": f"Discogs token={token}"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401:
                sys.exit("Discogs avviste tokenet (401). Sjekk token.txt.")
            if e.code == 404:
                return None
            if e.code == 429 or e.code >= 500:
                vent = 60 if e.code == 429 else 5 * (i + 1)
                print(f"   ... Discogs svarte {e.code}, venter {vent} s")
                time.sleep(vent)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"   ... nettverksfeil ({e}), prøver igjen")
            time.sleep(5 * (i + 1))
    raise RuntimeError("ga opp etter flere forsøk")


def les_token():
    token = os.environ.get("DISCOGS_TOKEN", "").strip()
    fil = os.path.join(MAPPE, "token.txt")
    if not token and os.path.exists(fil):
        with open(fil, encoding="utf-8-sig") as f:
            token = f.read().strip()
        print("Bruker token fra token.txt")
    if not token:
        print("Lim inn Discogs-tokenet og trykk Enter:")
        token = input("> ").strip()
    if not token:
        sys.exit("Mangler token.")
    return token


def finn_csv():
    if len(sys.argv) > 1:
        return sys.argv[1]
    for f in sorted(os.listdir(MAPPE), key=lambda f: "platesamling" not in f.lower()):
        if f.lower().endswith(".csv"):
            with open(os.path.join(MAPPE, f), encoding="utf-8-sig", errors="ignore") as fh:
                if "Release ID" in fh.readline():
                    return os.path.join(MAPPE, f)
    sys.exit(f"Fant ingen Platesamling.csv i {MAPPE}.")


def main():
    csv_sti = finn_csv()
    print(f"Bruker {csv_sti}")
    token = les_token()
    with open(csv_sti, encoding="utf-8-sig", newline="") as f:
        rids = []
        for r in csv.DictReader(f):
            rid = (r.get("Release ID") or "").strip().split(".")[0]
            if rid and rid not in rids:
                rids.append(rid)
    videoer = {}
    if os.path.exists(UT):
        with open(UT, encoding="utf-8") as f:
            videoer = json.load(f)
    igjen = [r for r in rids if r not in videoer]
    print(f"{len(rids)} utgaver, {len(igjen)} gjenstår. Anslått tid: {round(len(igjen) * PAUSE / 60)} min.")
    print("Starter. Hver plate tar litt over ett sekund ...", flush=True)
    hoppet = 0
    for n, rid in enumerate(igjen, 1):
        try:
            d = hent(f"{API}/releases/{rid}", token) or {}
        except Exception as e:
            # én plate som feiler stopper ikke resten; den hentes neste gang skriptet kjøres
            print(f"   [{n}/{len(igjen)}] {rid}: hoppet over ({e}), prøves igjen ved neste kjøring", flush=True)
            hoppet += 1
            continue
        ids = []
        for v in d.get("videos") or []:
            m = re.search(r"(?:v=|youtu\.be/|embed/)([A-Za-z0-9_-]{11})", v.get("uri") or "")
            if m and m.group(1) not in ids:
                ids.append(m.group(1))
        videoer[rid] = ids
        print(f"   [{n}/{len(igjen)}] {rid}: {len(ids)} video{'er' if len(ids) != 1 else ''}", flush=True)
        if n % 20 == 0 or n == len(igjen):
            with open(UT, "w", encoding="utf-8") as f:
                json.dump(videoer, f)
            med = sum(1 for v in videoer.values() if v)
            print(f"   {n}/{len(igjen)}  ({med} har video så langt)")
        time.sleep(PAUSE)
    with open(UT, "w", encoding="utf-8") as f:
        json.dump(videoer, f)
    med = sum(1 for v in videoer.values() if v)
    print(f"\nFerdig: {med} av {len(videoer)} utgaver har YouTube-video på Discogs.")
    if hoppet:
        print(f"{hoppet} plater feilet på nettet. Kjør skriptet én gang til for å hente dem.")
    print(f"Last opp denne fila i samtalen:\n   {UT}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code not in (None, 0):
            print(e.code)
    except KeyboardInterrupt:
        print("\nAvbrutt. Start på nytt for å fortsette der du slapp.")
    except Exception as e:
        print(f"Uventet feil: {e}")
    try:
        input("\nTrykk Enter for å lukke vinduet ...")
    except EOFError:
        pass
