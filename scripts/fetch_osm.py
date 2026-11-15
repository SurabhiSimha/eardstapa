#!/usr/bin/env python3
"""Download a fixed OpenStreetMap snapshot for each city via the Overpass API.

Usage: python3 scripts/fetch_osm.py [city ...]
Writes raw/<city>_ways.json and raw/<city>_features.json
"""
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "raw"

# south, west, north, east
CITIES = {
    "vancouver": (49.198, -123.265, 49.317, -123.023),
    "guelph": (43.470, -80.330, 43.600, -80.150),
    "metro-vancouver": (49.000, -123.300, 49.400, -122.550),
}
# big areas are fetched in tiles x tiles pieces
TILES = {"metro-vancouver": 4}

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

WAYS_Q = """
[out:json][timeout:300][bbox:{bbox}];
way[highway][highway!~"^(motorway|motorway_link|trunk_link|construction|proposed|raceway|bus_guideway|corridor|elevator|platform|rest_area|services|abandoned|razed)$"]
   [area!=yes][access!~"^(private|no)$"][foot!~"^(no|private)$"];
out body;
>;
out skel qt;
"""

# Bike-only ways (foot=no) that the walking query skips, plus the ids of every
# way that belongs to a signed cycling route.
BIKE_Q = """
[out:json][timeout:300][bbox:{bbox}];
way[highway][foot~"^(no|private)$"][bicycle!~"^(no|private)$"][access!~"^(private|no)$"]
   [highway!~"^(motorway|motorway_link|trunk_link|construction|proposed)$"]->.b;
.b out body;
.b >;
out skel qt;
relation[route=bicycle];
way(r);
out ids qt;
"""

# Street lamps (for after-dark comfort) and the small odd things that make a
# place feel alive: little free libraries, street pianos, chess tables, live
# music, patios, community gardens, anything notable enough for Wikipedia.
EXTRA_Q = """
[out:json][timeout:300][bbox:{bbox}];
(
  node[highway=street_lamp];
  nwr[amenity~"^(public_bookcase|piano|give_box|clock|music_venue|stage|studio|social_centre)$"];
  nwr[leisure~"^(bandstand|outdoor_seating|firepit|bird_hide)$"];
  nwr[sport~"chess|table_tennis"];
  nwr[live_music=yes];
  nwr[outdoor_seating=yes];
  nwr[craft~"^(brewery|distillery|pottery|bookbinder|glassblower)$"];
  nwr["garden:type"=community];
  nwr[natural=spring];
  nwr[man_made~"^(lighthouse|obelisk|windmill|watermill)$"];
  nwr[wikipedia][name][!highway][!boundary][!route][!admin_level][!place][!railway][!waterway][!public_transport];
);
out tags center qt;
"""

# Everything that makes a street feel alive (or dead). Ways/relations come back
# with full geometry so we can sample along them.
FEATURES_Q = """
[out:json][timeout:300][bbox:{bbox}];
(
  nwr[leisure~"^(park|garden|nature_reserve|playground|dog_park|common)$"];
  nwr[landuse~"^(forest|meadow|recreation_ground|village_green|cemetery|allotments|grass|industrial|railway|retail|commercial)$"];
  nwr[natural~"^(wood|water|beach|coastline|scrub|wetland|tree_row)$"];
  node[natural=tree];
  way[waterway~"^(river|stream|canal)$"];
  nwr[amenity~"^(cafe|restaurant|pub|bar|ice_cream|bakery|marketplace|library|theatre|cinema|arts_centre|fountain|place_of_worship|community_centre|biergarten|food_court|parking|fuel|bench)$"];
  nwr[shop~"^(bakery|books|florist|art|antiques|second_hand|music|craft|chocolate|cheese|deli|greengrocer|coffee|tea|pastry|confectionery|gift|farm|wine)$"];
  nwr[tourism~"^(artwork|viewpoint|attraction|museum|gallery|picnic_site)$"];
  nwr[historic];
  nwr[heritage];
  way[highway~"^(motorway|trunk|primary)$"];
  way[railway=rail];
);
out tags geom qt;
"""


def fetch(query: str, what: str) -> list:
    data = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(8):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            req = urllib.request.Request(
                url, data=data, headers={"User-Agent": "eardstapa-builder/0.1"}
            )
            with urllib.request.urlopen(req, timeout=400) as r:
                body = r.read()
            parsed = json.loads(body)
            if "elements" not in parsed or "remark" in parsed:
                raise RuntimeError(f"bad result: {str(parsed.get('remark', parsed))[:300]}")
            print(f"  {what}: {len(parsed['elements'])} elements, {len(body)/1e6:.1f} MB via {url}", flush=True)
            return parsed["elements"]
        except Exception as e:  # noqa: BLE001
            last = e
            print(f"  {what} attempt {attempt+1} at {url} failed: {e}", flush=True)
            time.sleep(10 + 10 * attempt)
    raise SystemExit(f"could not fetch {what}: {last}")


def run(template: str, bbox, out: pathlib.Path, tiles: int = 1) -> None:
    """Fetch a query over bbox, split into tiles x tiles pieces for big areas."""
    if out.exists() and out.stat().st_size > 1000:
        print(f"  {out.name} already present, skipping")
        return
    s, w, n, e = bbox
    seen, merged = set(), []
    for i in range(tiles):
        for j in range(tiles):
            b = (s + (n - s) * i / tiles, w + (e - w) * j / tiles,
                 s + (n - s) * (i + 1) / tiles, w + (e - w) * (j + 1) / tiles)
            part = RAW / f"{out.stem}.part{i}{j}.json"
            if part.exists():
                els = json.loads(part.read_text())
            else:
                els = fetch(template.format(bbox=",".join(f"{v:.5f}" for v in b)), f"{out.name} tile {i},{j}")
                if tiles > 1:
                    part.write_text(json.dumps(els))
            for el in els:
                key = (el["type"], el["id"], "nodes" in el or "tags" in el or el["type"] == "node")
                if key not in seen:
                    seen.add(key)
                    merged.append(el)
    out.write_text(json.dumps({"elements": merged}))
    for part in RAW.glob(f"{out.stem}.part*.json"):
        part.unlink()
    print(f"  {out.name}: {len(merged)} elements total", flush=True)


# City of Vancouver open data: every street-lighting pole (Open Government Licence - Vancouver)
LAMPS_CSV = {
    "vancouver": "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/street-lighting-poles/exports/csv?select=geo_point_2d",
}
LAMPS_CSV["metro-vancouver"] = LAMPS_CSV["vancouver"]


def fetch_lamps(city: str) -> None:
    out = RAW / f"{city}_lamps.csv"
    if city not in LAMPS_CSV or out.exists():
        return
    req = urllib.request.Request(LAMPS_CSV[city], headers={"User-Agent": "eardstapa-builder/0.1"})
    with urllib.request.urlopen(req, timeout=300) as r:
        out.write_bytes(r.read())
    print(f"  {out.name}: {out.stat().st_size/1e6:.1f} MB", flush=True)


def main() -> None:
    RAW.mkdir(exist_ok=True)
    for city in sys.argv[1:] or CITIES:
        bbox = CITIES[city]
        tiles = TILES.get(city, 1)
        print(city, flush=True)
        run(WAYS_Q, bbox, RAW / f"{city}_ways.json", tiles)
        run(FEATURES_Q, bbox, RAW / f"{city}_features.json", tiles)
        run(BIKE_Q, bbox, RAW / f"{city}_bike.json", 2 if tiles > 1 else 1)
        run(EXTRA_Q, bbox, RAW / f"{city}_extra.json", 2 if tiles > 1 else 1)
        fetch_lamps(city)


if __name__ == "__main__":
    main()
