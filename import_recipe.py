#!/usr/bin/env python3
"""Henter oppskrifter fra lenker og legger dem inn i db.json.

Kjøres av GitHub Actions (.github/workflows/import.yml) når appen legger en
bestilling i imports/. Hver bestilling er en JSON-fil: {"recipeId", "url", "replace"}.
Skriptet leser schema.org Recipe-data (application/ld+json) fra siden, tolker
ingredienslinjene til mengde/enhet/ingrediens, og fyller retten. Bestillingene
slettes etterpå. Status skrives på retten som "importStatus".

Bare standardbiblioteket er påkrevd. Pillow (valgfritt) brukes til å skalere
ned bildet; uten Pillow hoppes bildet over.
"""
import html
import io
import json
import os
import random
import re
import string
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(os.environ.get('MATBOKSEN_ROOT', Path(__file__).resolve().parent))
DB = ROOT / 'db.json'
IMPORTS = ROOT / 'imports'
IMAGES = ROOT / 'images'
UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
PLACEHOLDER_TITLE = 'Henter oppskrift'

# Enheter: ord på siden -> enhets-id i db.json
UNIT_WORDS = {
    'g': 'g', 'gr': 'g', 'gram': 'g',
    'kg': 'kg', 'kilo': 'kg',
    'ml': 'ml', 'cl': 'cl', 'dl': 'dl', 'l': 'l', 'liter': 'l',
    'ts': 'ts', 'tsk': 'ts', 'teskje': 'ts', 'teskjeer': 'ts',
    'ss': 'ss', 'ssk': 'ss', 'spiseskje': 'ss', 'spiseskjeer': 'ss',
    'klype': 'klype', 'klyper': 'klype',
    'stk': 'stk', 'stykk': 'stk', 'stykker': 'stk',
    'boks': 'boks', 'bokser': 'boks',
    'pk': 'pk', 'pakke': 'pk', 'pakker': 'pk',
    'fedd': 'fedd', 'bunt': 'bunt', 'bunter': 'bunt',
    'skive': 'skive', 'skiver': 'skive',
    'neve': 'neve', 'never': 'neve',
    'kopp': 'kopp', 'kopper': 'kopp',
}
UNIT_DEFS = {
    'cl': ('cl', 'volum'), 'boks': ('boks', 'antall'), 'pk': ('pk', 'antall'),
    'fedd': ('fedd', 'antall'), 'bunt': ('bunt', 'antall'), 'skive': ('skive', 'antall'),
    'neve': ('neve', 'antall'), 'kopp': ('kopp', 'volum'),
}
VULGAR = {'½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125}


# ---------------------------------------------------------------- hjelpere
def norm(s):
    return re.sub(r'\s+', ' ', str(s or '').strip().lower())


def new_id(name):
    base = unicodedata.normalize('NFKD', norm(name))
    base = ''.join(c for c in base if not unicodedata.combining(c))
    base = base.replace('æ', 'ae').replace('ø', 'o').replace('å', 'a')
    base = re.sub(r'[^a-z0-9]+', '-', base).strip('-')[:40] or 'id'
    return base + '-' + ''.join(random.choices(string.ascii_lowercase + string.digits, k=5))


def find_by_name(items, name):
    n = norm(name)
    for it in items:
        if norm(it.get('name')) == n or any(norm(a) == n for a in it.get('aliases') or []):
            return it
    return None


def ensure(items, name, **extra):
    hit = find_by_name(items, name)
    if hit:
        return hit['id']
    item = {'id': new_id(name), 'name': name.strip(), **extra}
    items.append(item)
    return item['id']


def clean_text(s):
    s = html.unescape(str(s or ''))
    s = re.sub(r'<br\s*/?>', '\n', s, flags=re.I)
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'[ \t\xa0]+', ' ', s).strip()


def first_url(img):
    if isinstance(img, str):
        return img
    if isinstance(img, list) and img:
        return first_url(img[0])
    if isinstance(img, dict):
        return img.get('url') or img.get('contentUrl')
    return None


# ---------------------------------------------------------------- henting
def fetch(url, binary=False, limit=8_000_000):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' if not binary else 'image/*,*/*;q=0.8',
        'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5',
        'Accept-Encoding': 'identity',
    })
    with urllib.request.urlopen(req, timeout=25) as res:
        data = res.read(limit)
        if binary:
            return data
        charset = res.headers.get_content_charset() or 'utf-8'
        return data.decode(charset, errors='replace')


# ---------------------------------------------------------------- JSON-LD
LD_RE = re.compile(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)


def is_recipe(obj):
    t = obj.get('@type') if isinstance(obj, dict) else None
    return t == 'Recipe' or (isinstance(t, list) and 'Recipe' in t)


def walk(obj):
    if isinstance(obj, dict):
        yield obj
        for v in obj.values():
            yield from walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v)


def find_recipe(page_html):
    for block in LD_RE.findall(page_html):
        try:
            data = json.loads(block.strip(), strict=False)
        except json.JSONDecodeError:
            try:
                data = json.loads(html.unescape(block.strip()), strict=False)
            except json.JSONDecodeError:
                continue
        for obj in walk(data):
            if is_recipe(obj):
                return obj
    return None


def parse_duration(s):
    """ISO 8601 (PT1H30M, P0DT0H40M) -> minutter."""
    if not isinstance(s, str):
        return None
    m = re.fullmatch(r'P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?', s.strip(), re.I)
    if not m or not any(m.groups()):
        return None
    d, h, mi = (int(x or 0) for x in m.groups())
    total = d * 1440 + h * 60 + mi
    return total or None


def parse_yield(y):
    if isinstance(y, list):
        for v in y:
            n = parse_yield(v)
            if n:
                return n
        return None
    m = re.search(r'\d+', str(y or ''))
    return int(m.group()) if m else None


def parse_steps(ins):
    steps = []
    def add(x):
        if isinstance(x, str):
            for part in re.split(r'\n+', clean_text(x)):
                part = re.sub(r'^\s*\d+[.)]\s*', '', part).strip()
                if part:
                    steps.append(part)
        elif isinstance(x, list):
            for v in x:
                add(v)
        elif isinstance(x, dict):
            if 'itemListElement' in x:      # HowToSection
                add(x['itemListElement'])
            else:                            # HowToStep
                add(x.get('text') or x.get('name') or '')
    add(ins)
    return steps


# ---------------------------------------------------------------- ingredienser
NUM = r'(?:\d+[.,]\d+|\d+\s+\d+/\d+|\d+/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+)'
LINE_RE = re.compile(
    r'^\s*(?:ca\.?|cirka|omtrent|ca)?\s*'
    r'(?P<amt>' + NUM + r')(?:\s*[-–]\s*(?P<amt2>' + NUM + r'))?\s*'
    r'(?P<rest>.*)$', re.I)


def to_number(s):
    s = s.strip().replace(',', '.')
    for ch, v in VULGAR.items():
        if ch in s:
            whole = s.replace(ch, '').strip()
            return (float(whole) if whole else 0) + v
    m = re.fullmatch(r'(\d+)\s+(\d+)/(\d+)', s)
    if m:
        return int(m.group(1)) + int(m.group(2)) / int(m.group(3))
    m = re.fullmatch(r'(\d+)/(\d+)', s)
    if m:
        return int(m.group(1)) / int(m.group(2)) if int(m.group(2)) else None
    return float(s)


def tidy_amount(x):
    if x is None:
        return None
    x = round(x, 3)
    return int(x) if x == int(x) else x


def parse_ingredient(raw):
    """'2 ss smør, romtemperert' -> {amount: 2, unit: 'ss', name: 'Smør', note: 'romtemperert'}"""
    text = clean_text(raw)
    amount, unit, note_parts = None, None, []
    rest = text
    m = LINE_RE.match(text)
    if m and m.group('rest') is not None:
        try:
            amount = to_number(m.group('amt'))
        except (ValueError, ZeroDivisionError):
            amount = None
        if amount is not None:
            rest = m.group('rest')
            if m.group('amt2'):
                note_parts.append(f"{m.group('amt')}–{m.group('amt2')}".replace('.', ','))
            w = re.match(r'([A-Za-zæøåÆØÅ]+)\.?(?=\s|$)', rest)
            if w and w.group(1).lower() in UNIT_WORDS:
                unit = UNIT_WORDS[w.group(1).lower()]
                rest = rest[w.end():]
    # merknad i parentes og etter komma
    for p in re.findall(r'\(([^)]*)\)', rest):
        if p.strip():
            note_parts.append(p.strip())
    rest = re.sub(r'\([^)]*\)', '', rest)
    if ',' in rest:
        rest, after = rest.split(',', 1)
        if after.strip():
            note_parts.append(after.strip())
    name = re.sub(r'\s+', ' ', rest).strip(' .-–:')
    if not name:
        name, amount, unit, note_parts = text, None, None, []
    name = name[0].upper() + name[1:]
    return {'amount': tidy_amount(amount), 'unit': unit, 'name': name, 'note': ', '.join(note_parts)}


# ---------------------------------------------------------------- bilde
def save_image(url, recipe_id):
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None
    data = fetch(url, binary=True)
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im).convert('RGB')
    im.thumbnail((1600, 1600))
    IMAGES.mkdir(exist_ok=True)
    name = f'images/{recipe_id}-import.webp'
    im.save(ROOT / name, 'WEBP', quality=80)
    return name


# ---------------------------------------------------------------- inn i db
def apply(db, recipe, req, data, now):
    replace = bool(req.get('replace'))
    filled = []
    title = clean_text(data.get('name'))
    if title and (replace or not recipe.get('title') or recipe['title'].startswith(PLACEHOLDER_TITLE)):
        recipe['title'] = title
    desc = clean_text(data.get('description'))
    if desc and (replace or not recipe.get('description')):
        recipe['description'] = desc[:300]
    servings = parse_yield(data.get('recipeYield'))
    if servings and (replace or not recipe.get('servings')):
        recipe['servings'] = servings
    minutes = parse_duration(data.get('totalTime')) or (
        (parse_duration(data.get('prepTime')) or 0) + (parse_duration(data.get('cookTime')) or 0)) or None
    if minutes and (replace or not recipe.get('timeMinutes')):
        recipe['timeMinutes'] = minutes

    raw_ings = data.get('recipeIngredient') or data.get('ingredients') or []
    if isinstance(raw_ings, str):
        raw_ings = [raw_ings]
    if raw_ings and (replace or not recipe.get('lines')):
        lines = []
        for raw in raw_ings:
            p = parse_ingredient(raw)
            if not p['name']:
                continue
            if p['unit'] and not any(u['id'] == p['unit'] for u in db['units']):
                uname, utype = UNIT_DEFS.get(p['unit'], (p['unit'], 'antall'))
                db['units'].append({'id': p['unit'], 'name': uname, 'type': utype})
            lines.append({
                'ingredientId': ensure(db['ingredients'], p['name'], aliases=[]),
                'amount': p['amount'], 'unitId': p['unit'], 'note': p['note'], 'group': '',
            })
        recipe['lines'] = lines
        filled.append(f"{len(lines)} {'ingrediens' if len(lines) == 1 else 'ingredienser'}")

    steps = parse_steps(data.get('recipeInstructions'))
    if steps and (replace or not recipe.get('steps')):
        recipe['steps'] = steps
        filled.append(f'{len(steps)} steg')

    img = first_url(data.get('image'))
    if img and (replace or not recipe.get('image')):
        try:
            path = save_image(img, recipe['id'])
            if path:
                recipe['image'] = path
                filled.append('bilde')
        except Exception as e:  # bilde er ikke kritisk
            print(f'  bilde feilet: {e}', file=sys.stderr)

    if recipe.get('title', '').startswith(PLACEHOLDER_TITLE):
        recipe['title'] = 'Uten navn'
    recipe['updatedAt'] = now
    return filled


def process(req, db, now):
    rid, url = req.get('recipeId'), req.get('url')
    recipe = next((r for r in db['recipes'] if r['id'] == rid), None)
    if not recipe:
        print(f'  fant ikke rett {rid}; hopper over', file=sys.stderr)
        return
    site = re.sub(r'^www\.', '', urllib.parse.urlparse(url).hostname or '')
    recipe['source'] = {'type': 'url', 'url': url, 'site': site, 'fetchedAt': now[:10]}
    try:
        page = fetch(url)
        data = find_recipe(page)
        if not data:
            raise ValueError(f'Fant ingen oppskriftsdata på {site}. Siden støtter trolig ikke automatisk henting; legg inn ingrediensene selv.')
        filled = apply(db, recipe, req, data, now)
        if not filled:
            raise ValueError('Fant oppskriften, men ingen ingredienser eller fremgangsmåte å legge inn.')
        recipe['importStatus'] = {'state': 'ok', 'at': now, 'message': f"Hentet {', '.join(filled)} fra {site}."}
    except Exception as e:
        msg = str(e)
        if 'HTTP Error 403' in msg or 'HTTP Error 429' in msg:
            msg = f'{site} stengte for automatisk henting. Legg inn ingrediensene selv.'
        elif 'HTTP Error 404' in msg:
            msg = 'Fant ikke siden (404). Sjekk lenken.'
        elif 'timed out' in msg or 'urlopen error' in msg:
            msg = f'Fikk ikke kontakt med {site}. Prøv igjen senere.'
        if recipe.get('title', '').startswith(PLACEHOLDER_TITLE):
            recipe['title'] = 'Uten navn'
        recipe['importStatus'] = {'state': 'feil', 'at': now, 'message': msg}
    print(f"  {rid}: {recipe['importStatus']['state']} – {recipe['importStatus']['message']}")


def main():
    reqs = sorted(IMPORTS.glob('*.json')) if IMPORTS.exists() else []
    if not reqs:
        print('Ingen bestillinger.')
        return 0
    db = json.loads(DB.read_text(encoding='utf-8'))
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for f in reqs:
        print(f'Bestilling {f.name}')
        try:
            req = json.loads(f.read_text(encoding='utf-8'))
            process(req, db, now)
        except Exception as e:
            print(f'  ugyldig bestilling: {e}', file=sys.stderr)
        f.unlink()
    DB.write_text(json.dumps(db, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    sys.exit(main())
