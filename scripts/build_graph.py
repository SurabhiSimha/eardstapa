#!/usr/bin/env python3
"""Turn the raw OSM snapshot into a routable graph where every street segment
carries "aliveness" scores (nature, water, street life, culture, calm).

Usage: python3 scripts/build_graph.py [city ...]
Writes data/<city>.bin and data/<city>.json
"""
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"
OUT = ROOT / "data"

CITIES = {
    "vancouver": {"label": "Vancouver, BC", "bbox": (49.198, -123.265, 49.317, -123.023), "center": (49.2715, -123.125), "zoom": 13},
    "metro-vancouver": {"label": "Greater Vancouver, BC", "bbox": (49.000, -123.300, 49.400, -122.550), "center": (49.2500, -123.0000), "zoom": 11},
    "guelph": {"label": "Guelph, ON", "bbox": (43.470, -80.330, 43.600, -80.150), "center": (43.5448, -80.2482), "zoom": 14},
}

CELL = 10.0  # metres per raster cell

# edge flag bits
GENERIC = {"Mural", "Sculpture", "Statue", "Public art", "Viewpoint", "Fountain", "Art installation", "Little free library",
           "Street piano", "Give box", "Chess tables", "Ping-pong table", "Bandstand", "Fire pit", "Bird hide",
           "Community garden", "Spring", "Lighthouse", "Obelisk", "Windmill", "Watermill"}
F_WALK, F_BIKE_FWD, F_BIKE_BACK, F_DISMOUNT, F_STEPS = 1, 2, 4, 8, 16

WALK_CALM = {
    "path": 1.0, "footway": 1.0, "pedestrian": 1.0, "steps": 0.95, "track": 1.0, "bridleway": 1.0,
    "cycleway": 0.9, "living_street": 0.9, "residential": 0.8, "service": 0.55, "unclassified": 0.6,
    "tertiary": 0.45, "tertiary_link": 0.45, "secondary": 0.25, "secondary_link": 0.25,
    "primary": 0.1, "primary_link": 0.1, "trunk": 0.0, "road": 0.5,
}
BIKE_CALM = {
    "cycleway": 1.0, "path": 0.9, "track": 0.8, "living_street": 0.85, "residential": 0.7,
    "service": 0.5, "unclassified": 0.55, "tertiary": 0.35, "tertiary_link": 0.35,
    "secondary": 0.15, "secondary_link": 0.15, "primary": 0.05, "primary_link": 0.05,
    "trunk": 0.0, "road": 0.4, "footway": 0.5, "pedestrian": 0.5, "bridleway": 0.5,
}
BIKE_RIDEABLE = {
    "cycleway", "path", "track", "living_street", "residential", "service", "unclassified",
    "tertiary", "tertiary_link", "secondary", "secondary_link", "primary", "primary_link", "road",
}

ROADS = {"living_street", "residential", "service", "unclassified", "tertiary", "tertiary_link", "secondary",
         "secondary_link", "primary", "primary_link", "trunk", "road"}
SAFE_W = {"path": 1, "footway": 1, "pedestrian": 1, "steps": 1, "track": 1, "bridleway": 1, "cycleway": .85,
          "living_street": .95, "residential": .7, "service": .6, "unclassified": .5, "tertiary": .4, "tertiary_link": .4,
          "secondary": .3, "secondary_link": .3, "primary": .2, "primary_link": .2, "trunk": .05, "road": .5}
SAFE_B = {"cycleway": 1, "path": .9, "track": .8, "living_street": .9, "residential": .75, "service": .6,
          "unclassified": .55, "tertiary": .4, "tertiary_link": .4, "secondary": .2, "secondary_link": .2,
          "primary": .08, "primary_link": .08, "trunk": 0, "road": .4, "footway": .7, "pedestrian": .7}
LIT_DEFAULT = {"residential": .75, "living_street": .75, "tertiary": .8, "tertiary_link": .8, "secondary": .85,
               "secondary_link": .85, "primary": .85, "primary_link": .85, "trunk": .8, "unclassified": .6,
               "pedestrian": .75, "service": .45, "cycleway": .45, "footway": .35, "path": .2, "track": .15,
               "steps": .3, "road": .6}
PSEUDO = {"steps": "~the steps", "cycleway": "~a bike path", "footway": "~a footpath", "path": "~a path",
          "pedestrian": "~a pedestrian street", "track": "~a track", "service": "~a service lane",
          "bridleway": "~a trail"}

LIFE_AMENITY = {"cafe": 1, "restaurant": 1, "pub": 1, "bar": 1, "ice_cream": 1, "bakery": 1,
                "marketplace": 3, "biergarten": 1, "food_court": 1.5, "bench": 0.1}
CULTURE_AMENITY = {"library": 1, "theatre": 1.5, "cinema": 1, "arts_centre": 1.5, "fountain": 1,
                   "place_of_worship": 0.7, "community_centre": 0.5}
CULTURE_TOURISM = {"artwork": 1.5, "viewpoint": 2, "attraction": 1, "museum": 1.5, "gallery": 1.5, "picnic_site": 0.5}
GREEN_STRONG = {("leisure", "park"), ("leisure", "garden"), ("leisure", "nature_reserve"), ("leisure", "common"),
                ("leisure", "dog_park"), ("landuse", "forest"), ("landuse", "meadow"), ("landuse", "village_green"),
                ("landuse", "recreation_ground"), ("landuse", "allotments"), ("natural", "wood"), ("natural", "wetland")}
GREEN_WEAK = {("leisure", "playground"), ("landuse", "cemetery"), ("landuse", "grass"), ("natural", "scrub")}


def load(path):
    return json.loads(path.read_text())["elements"] if path.exists() else []


def rings_of(el):
    """Return (list of coordinate lists, is_polygon) for a way or relation."""
    if el["type"] == "way":
        g = el.get("geometry") or []
        pts = [(p["lat"], p["lon"]) for p in g if p]
        closed = len(pts) > 3 and pts[0] == pts[-1]
        return [pts], closed
    if el["type"] == "relation":
        segs = []
        for m in el.get("members", []):
            if m.get("type") == "way" and m.get("role") in ("outer", "") and m.get("geometry"):
                segs.append([(p["lat"], p["lon"]) for p in m["geometry"] if p])
        # stitch outer pieces into rings
        rings = []
        while segs:
            ring = segs.pop()
            changed = True
            while ring[0] != ring[-1] and changed:
                changed = False
                for i, s in enumerate(segs):
                    if s[0] == ring[-1]:
                        ring += s[1:]
                    elif s[-1] == ring[-1]:
                        ring += s[-2::-1]
                    elif s[-1] == ring[0]:
                        ring = s[:-1] + ring
                    elif s[0] == ring[0]:
                        ring = s[:0:-1] + ring
                    else:
                        continue
                    segs.pop(i)
                    changed = True
                    break
            rings.append(ring)
        return rings, True
    return [], False


def build(city):
    cfg = CITIES[city]
    south, west, north, east = cfg["bbox"]
    lat0 = (south + north) / 2
    mx = 111320.0 * math.cos(math.radians(lat0))
    my = 110540.0
    W = int((east - west) * mx / CELL) + 1
    H = int((north - south) * my / CELL) + 1
    print(f"{city}: raster {W}x{H}")

    def px(lat, lon):
        return ((lon - west) * mx / CELL, (north - lat) * my / CELL)

    # ------------------------------------------------------------ rasters
    layers = {k: Image.new("L", (W, H), 0) for k in
              ("green", "green_weak", "water", "road_big", "road_primary", "road_secondary", "rail", "industrial", "parking")}
    draw = {k: ImageDraw.Draw(v) for k, v in layers.items()}
    pts_acc = {k: np.zeros((H, W), np.float32) for k in ("life", "culture", "trees", "lamps")}

    def add_point(layer, lat, lon, w):
        x, y = px(lat, lon)
        xi, yi = int(x), int(y)
        if 0 <= xi < W and 0 <= yi < H:
            pts_acc[layer][yi, xi] += w

    def paint(layer, rings, polygon, width=1):
        for r in rings:
            p = [px(a, b) for a, b in r]
            if len(p) < 2:
                continue
            if polygon and len(p) >= 3:
                draw[layer].polygon(p, fill=255)
            else:
                draw[layer].line(p, fill=255, width=width)

    pois = []      # [kind, name]
    poi_pts = []   # [poi index, lat, lon]

    def add_poi(kind, name, el, rings):
        idx = len(pois)
        pois.append([kind, name])
        if el["type"] == "node":
            poi_pts.append([idx, el["lat"], el["lon"]])
            return
        allp = [p for r in rings for p in r]
        if not allp:
            pois.pop()
            return
        clat = sum(p[0] for p in allp) / len(allp)
        clon = sum(p[1] for p in allp) / len(allp)
        poi_pts.append([idx, clat, clon])
        if kind in ("park", "water"):
            # sample the outline so that skirting a big park still counts
            last = None
            for r in rings:
                for a, b in r:
                    if last is None or abs(a - last[0]) * my + abs(b - last[1]) * mx > 90:
                        poi_pts.append([idx, a, b])
                        last = (a, b)

    for el in load(RAW / f"{city}_features.json"):
        t = el.get("tags") or {}
        if el["type"] == "node":
            rings, poly = [], False
            lat, lon = el["lat"], el["lon"]
        else:
            rings, poly = rings_of(el)
            allp = [p for r in rings for p in r]
            if not allp:
                continue
            lat = sum(p[0] for p in allp) / len(allp)
            lon = sum(p[1] for p in allp) / len(allp)
        name = t.get("name")
        hw, rw, ww = t.get("highway"), t.get("railway"), t.get("waterway")

        if hw in ("motorway", "trunk"):
            paint("road_big", rings, False, 2)
            continue
        if hw == "primary":
            paint("road_primary", rings, False, 2)
            continue
        if rw == "rail":
            if t.get("tunnel") != "yes":
                paint("rail", rings, False, 1)
            continue
        if hw:
            continue

        kv = {(k, t.get(k)) for k in ("leisure", "landuse", "natural")}
        if kv & GREEN_STRONG and el["type"] != "node":
            paint("green", rings, poly)
        elif kv & GREEN_WEAK and el["type"] != "node":
            paint("green_weak", rings, poly)
        nat = t.get("natural")
        if nat in ("water", "beach", "coastline", "wetland") and el["type"] != "node":
            paint("water", rings, poly and nat != "coastline", 2)
        if ww and t.get("tunnel") not in ("yes", "culvert"):
            paint("water", rings, False, 2)
        if nat == "tree" and el["type"] == "node":
            add_point("trees", lat, lon, 1)
        if nat == "tree_row":
            for r in rings:
                for a, b in r:
                    add_point("trees", a, b, 1)
        lu = t.get("landuse")
        if lu in ("industrial", "railway") and el["type"] != "node":
            paint("industrial", rings, poly)
        am = t.get("amenity")
        if am == "parking" and el["type"] != "node" and t.get("parking") not in ("underground", "multi-storey"):
            paint("parking", rings, poly)

        life = LIFE_AMENITY.get(am, 0) + (1 if t.get("shop") else 0)
        if life:
            add_point("life", lat, lon, life)
        tour = t.get("tourism")
        cult = CULTURE_AMENITY.get(am, 0) + CULTURE_TOURISM.get(tour, 0)
        if (t.get("historic") or t.get("heritage")) and not cult:
            cult = 1
        if cult:
            add_point("culture", lat, lon, cult)

        # ---- points of interest shown along the route
        kind = None
        if tour == "artwork":
            kind = "art"
            name = name or {"mural": "Mural", "sculpture": "Sculpture", "statue": "Statue",
                            "installation": "Art installation"}.get(t.get("artwork_type"), "Public art")
        elif tour == "viewpoint":
            kind, name = "view", name or "Viewpoint"
        elif am == "fountain":
            kind, name = "fountain", name or "Fountain"
        elif not name:
            kind = None
        elif t.get("leisure") in ("park", "garden", "nature_reserve") or lu == "forest" or nat == "wood":
            kind = "park"
        elif nat in ("water", "beach") or ww:
            kind = "water"
        elif am in ("cafe", "ice_cream", "bakery") or t.get("shop") in ("bakery", "coffee", "tea", "pastry", "chocolate"):
            kind = "cafe"
        elif am in ("restaurant", "pub", "bar", "biergarten", "food_court"):
            kind = "food"
        elif am == "marketplace" or t.get("shop") in ("farm", "greengrocer"):
            kind = "market"
        elif am == "library" or t.get("shop") in ("books", "second_hand", "antiques", "music"):
            kind = "books"
        elif tour in ("museum", "gallery", "attraction") or am in ("theatre", "arts_centre", "cinema") or t.get("shop") in ("art", "craft"):
            kind = "culture"
        elif t.get("historic") or t.get("heritage"):
            kind = "historic"
        if kind and name:
            add_poi(kind, name, el, rings)

    # ------------------------------------------------------------ extras: lamps + curiosities
    known = {n.lower() for _, n in pois if n}

    def add_spot(kind, name, lat, lon):
        if name.lower() in known and kind == "notable":
            return
        known.add(name.lower())
        poi_pts.append([len(pois), lat, lon])
        pois.append([kind, name])

    for el in load(RAW / f"{city}_extra.json"):
        t = el.get("tags") or {}
        c = el if el["type"] == "node" else el.get("center")
        if not c:
            continue
        lat, lon = c["lat"], c["lon"]
        if t.get("highway") == "street_lamp":
            add_point("lamps", lat, lon, 1)
            continue
        if t.get("highway") or t.get("man_made") in ("utility_pole", "surveillance", "bridge"):
            continue
        am, le, sport, craft, name = t.get("amenity"), t.get("leisure"), t.get("sport") or "", t.get("craft"), t.get("name")
        if t.get("outdoor_seating") == "yes" or le == "outdoor_seating":
            add_point("life", lat, lon, 1)
        kind = None
        if am == "public_bookcase":
            kind, name = "odd", name or "Little free library"
        elif am == "piano":
            kind, name = "odd", name or "Street piano"
        elif am == "give_box":
            kind, name = "odd", name or "Give box"
        elif am == "clock" and name:
            kind = "odd"
        elif "chess" in sport:
            kind, name = "odd", name or "Chess tables"
        elif "table_tennis" in sport:
            kind, name = "odd", name or "Ping-pong table"
        elif le in ("bandstand", "firepit", "bird_hide"):
            kind, name = "odd", name or {"bandstand": "Bandstand", "firepit": "Fire pit", "bird_hide": "Bird hide"}[le]
        elif t.get("garden:type") == "community":
            kind, name = "odd", name or "Community garden"
        elif t.get("natural") == "spring" or t.get("man_made") in ("lighthouse", "obelisk", "windmill", "watermill"):
            kind, name = "odd", name or (t.get("man_made") or "spring").capitalize()
        elif am in ("music_venue", "stage") or t.get("live_music") == "yes":
            kind = "music" if name else None
            add_point("life", lat, lon, 1)
        elif craft or am == "studio":
            kind = "maker" if name else None
        elif t.get("wikipedia") and name and am != "social_centre":
            kind = "notable"
        if kind and name:
            add_point("culture", lat, lon, 1.5 if kind in ("odd", "music") else 1)
            add_spot(kind, name, lat, lon)
    lamps_csv = RAW / f"{city}_lamps.csv"
    if lamps_csv.exists():
        for line in lamps_csv.read_text().splitlines()[1:]:
            try:
                a, b = (float(v) for v in line.strip('"').split(","))
            except ValueError:
                continue
            add_point("lamps", a, b, 1)

    # ------------------------------------------------------------ ways
    nodes = {}
    ways = []
    bike_route_ids = set()
    for src, bike_only in ((f"{city}_ways.json", False), (f"{city}_bike.json", True)):
        for el in load(RAW / src):
            if el["type"] == "node":
                nodes[el["id"]] = (el["lat"], el["lon"])
            elif el["type"] == "way":
                if "nodes" in el:
                    ways.append((el, bike_only))
                else:
                    bike_route_ids.add(el["id"])

    # secondary roads add a little noise too
    for el, _ in ways:
        if (el.get("tags") or {}).get("highway") == "secondary":
            p = [px(*nodes[n]) for n in el["nodes"] if n in nodes]
            if len(p) > 1:
                draw["road_secondary"].line(p, fill=255, width=1)

    def dist_field(layer, scale_m):
        mask = np.asarray(layers[layer]) > 0
        if not mask.any():
            return np.zeros((H, W), np.float32)
        d = ndimage.distance_transform_edt(~mask) * CELL
        return np.exp(-d / scale_m).astype(np.float32)

    def density(layer, sigma_cells, half):
        v = ndimage.gaussian_filter(pts_acc[layer], sigma_cells) * (2 * math.pi * sigma_cells ** 2)
        return (1 - np.exp(-v / half)).astype(np.float32)

    green = np.maximum(dist_field("green", 35), 0.45 * dist_field("green_weak", 35))
    trees = density("trees", 2.5, 6)
    f_nature = np.clip(np.maximum(green, 0.6 * trees) + 0.25 * trees * (1 - green), 0, 1)
    f_water = dist_field("water", 70)
    f_life = density("life", 4, 3)
    f_culture = density("culture", 5, 1.5)
    f_lamps = density("lamps", 2.5, 1.0)
    f_noise = np.maximum.reduce([
        dist_field("road_big", 60), 0.8 * dist_field("road_primary", 35), 0.5 * dist_field("road_secondary", 25),
        0.6 * dist_field("rail", 40), 0.7 * dist_field("industrial", 30), 0.4 * dist_field("parking", 15),
    ])

    # ------------------------------------------------------------ edges
    idx = {}
    lat_l, lon_l = [], []

    def nid(osm):
        i = idx.get(osm)
        if i is None:
            i = idx[osm] = len(lat_l)
            a, b = nodes[osm]
            lat_l.append(a)
            lon_l.append(b)
        return i

    ea, eb, eflag, ecw, ecb = [], [], [], [], []
    esw, esb, elt, elitno, enm, eside, eroad = [], [], [], [], [], [], []
    names, name_idx = [], {}

    def name_id(nm):
        i = name_idx.get(nm)
        if i is None:
            i = name_idx[nm] = len(names)
            names.append(nm)
        return i
    seen = set()
    street_nodes = defaultdict(list)
    for el, bike_only in ways:
        t = el.get("tags") or {}
        hw = t.get("highway")
        foot, bic = t.get("foot"), t.get("bicycle")
        sidewalk = t.get("sidewalk") or t.get("sidewalk:both") or ""

        walk = not bike_only
        if hw == "trunk" and not (foot in ("yes", "designated") or sidewalk in ("both", "left", "right", "yes")):
            walk = False
        if hw == "cycleway" and foot in ("no", "private"):
            walk = False

        flags = F_WALK if walk else 0
        if hw == "steps":
            flags |= F_STEPS
            ride = dismount = False
        else:
            ride = hw in BIKE_RIDEABLE or bic in ("yes", "designated", "permissive")
            if bic in ("no", "private", "dismount") or (hw == "trunk" and bic not in ("yes", "designated")):
                ride = False
            if hw == "path" and bic is None and t.get("surface") in ("ground", "dirt", "mud", "sand", "rock"):
                ride = False
            dismount = (not ride) and walk
        ow = t.get("oneway")
        if t.get("junction") in ("roundabout", "circular") and ow is None:
            ow = "yes"
        contra = (t.get("oneway:bicycle") == "no" or "opposite" in (t.get("cycleway") or "")
                  or "opposite" in (t.get("cycleway:left") or "") or "opposite" in (t.get("cycleway:right") or ""))
        if ride:
            if ow in ("yes", "true", "1") and not contra:
                flags |= F_BIKE_FWD
            elif ow in ("-1", "reverse") and not contra:
                flags |= F_BIKE_BACK
            else:
                flags |= F_BIKE_FWD | F_BIKE_BACK
        elif dismount:
            flags |= F_BIKE_FWD | F_BIKE_BACK | F_DISMOUNT
        if not flags & (F_WALK | F_BIKE_FWD | F_BIKE_BACK):
            continue

        cw = WALK_CALM.get(hw, 0.5)
        if hw == "footway" and t.get("footway") in ("sidewalk", "crossing"):
            cw = 0.85
        cb = BIKE_CALM.get(hw, 0.4)
        lane = " ".join(str(t.get(k) or "") for k in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"))
        if "track" in lane or "separate" in lane:
            cb = max(cb, 0.8)
        elif "lane" in lane:
            cb = min(1.0, cb + 0.3)
        elif "shared" in lane:
            cb = min(1.0, cb + 0.1)
        if el["id"] in bike_route_ids or bic == "designated":
            cb = min(1.0, cb + 0.2)
        if dismount:
            cb = 0.3

        # ---- safety from traffic
        try:
            spd = int((t.get("maxspeed") or "").split()[0])
        except (ValueError, IndexError):
            spd = None
        has_sw = sidewalk in ("both", "left", "right", "yes", "separate") or \
            (t.get("sidewalk:left") or t.get("sidewalk:right")) in ("yes", "separate")
        sw = SAFE_W.get(hw, 0.5)
        sbk = SAFE_B.get(hw, 0.4)
        is_side = hw == "footway" and t.get("footway") == "sidewalk"
        if hw == "footway" and t.get("footway") == "crossing":
            signals = t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes"
            sw = 0.95 if signals else 0.6 if t.get("crossing") in ("unmarked", "uncontrolled", "no") else 0.8
        elif is_side:
            sw = 0.9
        elif hw in ROADS:
            if has_sw:
                sw += 0.25
            elif sidewalk in ("no", "none"):
                sw -= 0.05 if hw in ("residential", "living_street", "service") else 0.2
            if spd:
                adj = 0.1 if spd <= 30 else -0.15 if spd >= 60 else 0
                sw += adj
                sbk += adj
        if "track" in lane or "separate" in lane:
            sbk = max(sbk, 0.85)
        elif "lane" in lane:
            sbk += 0.3
        if el["id"] in bike_route_ids:
            sbk += 0.1
        if dismount:
            sbk = 0.7
        sw, sbk = min(1.0, max(0.0, sw)), min(1.0, max(0.0, sbk))
        lit_tag = t.get("lit")
        lt = 1.0 if lit_tag in ("yes", "24/7", "automatic", "sunset-sunrise") else \
            0.75 if hw == "footway" and t.get("footway") in ("sidewalk", "crossing") else LIT_DEFAULT.get(hw, 0.4)
        # ---- name used in written directions ("~" marks a description, not a name)
        nm = t.get("name")
        if not nm:
            if hw == "footway" and t.get("footway") == "crossing":
                nm = "~crossing"
            elif is_side:
                nm = "~the sidewalk"
            elif hw == "service" and t.get("service") == "alley":
                nm = "~an alley"
            else:
                nm = PSEUDO.get(hw, "~an unnamed road")
        nmi = name_id(nm)
        is_road = bool(t.get("name")) and hw in ROADS

        ns = [n for n in el["nodes"] if n in nodes]
        if t.get("name") and hw not in ("footway", "path", "steps", "service", "cycleway"):
            street_nodes[t["name"]].extend(ns)
        for a, b in zip(ns, ns[1:]):
            if a == b:
                continue
            key = (a, b) if a < b else (b, a)
            if key in seen:
                continue
            seen.add(key)
            ea.append(nid(a))
            eb.append(nid(b))
            eflag.append(flags)
            ecw.append(cw)
            ecb.append(cb)
            esw.append(sw)
            esb.append(sbk)
            elt.append(lt)
            elitno.append(lit_tag == "no")
            enm.append(nmi)
            eside.append(is_side and not t.get("name"))
            eroad.append(is_road)

    lat = np.array(lat_l)
    lon = np.array(lon_l)
    ea = np.array(ea, np.int64)
    eb = np.array(eb, np.int64)
    eflag = np.array(eflag, np.uint8)
    ecw = np.array(ecw, np.float32)
    ecb = np.array(ecb, np.float32)
    N = len(lat)
    esw, esb, elt = np.array(esw, np.float32), np.array(esb, np.float32), np.array(elt, np.float32)
    elitno, enm = np.array(elitno, bool), np.array(enm, np.int64)
    eside, eroad = np.array(eside, bool), np.array(eroad, bool)

    # sidewalks mapped as their own lines take the name of the street they run along
    if eside.any() and eroad.any():
        kx = 111320.0 * math.cos(math.radians(lat0))
        ra, rb = ea[eroad], eb[eroad]
        rlen = np.hypot((lon[rb] - lon[ra]) * kx, (lat[rb] - lat[ra]) * 110540.0)
        cnt = np.maximum(1, np.ceil(rlen / 12).astype(int))
        rep_i = np.repeat(np.arange(len(ra)), cnt)
        first = np.cumsum(cnt) - cnt
        tt = (np.arange(len(rep_i)) - first[rep_i] + 0.5) / cnt[rep_i]
        px_ = (lon[ra][rep_i] + (lon[rb] - lon[ra])[rep_i] * tt) * kx
        py_ = (lat[ra][rep_i] + (lat[rb] - lat[ra])[rep_i] * tt) * 110540.0
        tree = cKDTree(np.column_stack([px_, py_]))
        sa, sb_ = ea[eside], eb[eside]
        d, j = tree.query(np.column_stack([(lon[sa] + lon[sb_]) / 2 * kx, (lat[sa] + lat[sb_]) / 2 * 110540.0]),
                          distance_upper_bound=30)
        ok = np.isfinite(d)
        side_idx = np.flatnonzero(eside)
        enm[side_idx[ok]] = enm[eroad][rep_i[j[ok]]]

    # main connected component per mode
    def main_comp(mask):
        g = coo_matrix((np.ones(mask.sum(), np.int8), (ea[mask], eb[mask])), shape=(N, N))
        _, lab = connected_components(g, directed=False)
        used = np.zeros(N, bool)
        used[ea[mask]] = True
        used[eb[mask]] = True
        counts = np.bincount(lab[used])
        return (lab == counts.argmax()) & used

    walk_ok = main_comp((eflag & F_WALK) > 0)
    bike_ok = main_comp((eflag & (F_BIKE_FWD | F_BIKE_BACK)) > 0)
    keep = walk_ok | bike_ok
    # drop edges whose mode is cut off from that mode's main network
    w_e = ((eflag & F_WALK) > 0) & walk_ok[ea] & walk_ok[eb]
    b_e = ((eflag & (F_BIKE_FWD | F_BIKE_BACK)) > 0) & bike_ok[ea] & bike_ok[eb]
    eflag = np.where(w_e, eflag, eflag & ~np.uint8(F_WALK)).astype(np.uint8)
    eflag = np.where(b_e, eflag, eflag & ~np.uint8(F_BIKE_FWD | F_BIKE_BACK | F_DISMOUNT)).astype(np.uint8)
    ekeep = (eflag & (F_WALK | F_BIKE_FWD | F_BIKE_BACK)) > 0
    remap = np.cumsum(keep) - 1
    ea, eb, eflag, ecw, ecb = remap[ea[ekeep]], remap[eb[ekeep]], eflag[ekeep], ecw[ekeep], ecb[ekeep]
    esw, esb, elt, elitno, enm = esw[ekeep], esb[ekeep], elt[ekeep], elitno[ekeep], enm[ekeep]
    old_to_new = np.where(keep, remap, -1)
    lat, lon = lat[keep], lon[keep]
    nflag = (walk_ok[keep] * 1 + bike_ok[keep] * 2).astype(np.uint8)
    N, E = len(lat), len(ea)

    dx = (lon[eb] - lon[ea]) * 111320.0 * np.cos(np.radians((lat[ea] + lat[eb]) / 2))
    dy = (lat[eb] - lat[ea]) * 110540.0
    elen = np.hypot(dx, dy).astype(np.float32)

    def sample(field):
        acc = np.zeros(E, np.float32)
        for tt in (0.2, 0.5, 0.8):
            la = lat[ea] + (lat[eb] - lat[ea]) * tt
            lo = lon[ea] + (lon[eb] - lon[ea]) * tt
            x = np.clip(((lo - west) * mx / CELL).astype(int), 0, W - 1)
            y = np.clip(((north - la) * my / CELL).astype(int), 0, H - 1)
            acc += field[y, x]
        return acc / 3

    noise = sample(f_noise)
    cols = {
        "nature": sample(f_nature),
        "water": sample(f_water),
        "life": sample(f_life),
        "culture": sample(f_culture),
        "calmW": ecw * (1 - 0.75 * noise),
        "calmB": ecb * (1 - 0.5 * noise),
        "safeW": esw,
        "safeB": esb,
    }
    lamp = sample(f_lamps)
    cols["lit"] = np.where(elitno, 0.05, np.maximum(elt, 0.95 * lamp)) * (0.85 + 0.15 * cols["life"])
    assert len(names) < 65536
    for k, v in cols.items():
        print(f"  {k:8s} mean {np.average(v, weights=elen):.3f}  p90 {np.percentile(v, 90):.3f}")

    def u8(v):
        return np.clip(np.round(v * 255), 0, 255).astype(np.uint8)

    OUT.mkdir(exist_ok=True)
    parts = [
        np.round(lat * 1e7).astype("<i4"), np.round(lon * 1e7).astype("<i4"),
        ea.astype("<u4"), eb.astype("<u4"), elen.astype("<f4"),
        nflag, eflag, *[u8(cols[k]) for k in ("nature", "water", "life", "culture", "calmW", "calmB", "safeW", "safeB", "lit")],
        enm.astype("<u2"),
    ]
    (OUT / f"{city}.bin").write_bytes(b"".join(p.tobytes() for p in parts))

    # searchable places: named POIs + streets
    places = []
    first_pt = {}
    for i, a, b in poi_pts:
        first_pt.setdefault(i, (a, b))
    for i, (kind, name) in enumerate(pois):
        if name and i in first_pt and name not in GENERIC:
            places.append([name, round(first_pt[i][0], 5), round(first_pt[i][1], 5), kind])
    for name, ns in street_nodes.items():
        ns = [n for n in ns if n in idx and old_to_new[idx[n]] >= 0]
        if ns:
            a, b = nodes[ns[len(ns) // 2]]
            places.append([name, round(a, 5), round(b, 5), "street"])

    meta = {
        "id": city, "label": cfg["label"], "bbox": cfg["bbox"], "center": cfg["center"], "zoom": cfg["zoom"],
        "nodes": int(N), "edges": int(E),
        "names": names,
        "pois": pois,
        "poiPts": [[i, round(a, 5), round(b, 5)] for i, a, b in poi_pts],
        "places": places,
    }
    (OUT / f"{city}.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    print(f"  {N} nodes, {E} edges, {len(pois)} POIs, {len(places)} places, "
          f"bin {(OUT / f'{city}.bin').stat().st_size/1e6:.1f} MB")


if __name__ == "__main__":
    for c in sys.argv[1:] or CITIES:
        build(c)
