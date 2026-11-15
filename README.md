# Eardstapa

*Eardstapa* is Old English for “earth-stepper”, a wanderer. Walking and biking directions that optimise for beauty, serendipity and aliveness instead of speed.
Covers Vancouver, BC and Guelph, ON from a fixed OpenStreetMap snapshot — no server, no live feeds.

## Run

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765

## How it works

- `scripts/fetch_osm.py` downloads streets, paths, parks, water, trees, cafés, art, heritage etc. into `raw/`.
- `scripts/build_graph.py` scores every street segment for nature, water, street life, culture and calm
  (per mode), and writes a compact graph to `data/`.
- `app.js` loads the graph and runs A* in the browser. The “Wander” route minimises
  `time × (1 + K × (1 − aliveness)²)`, with K chosen as large as your detour budget allows.

## Refresh the snapshot or add a city

Add a bounding box to `CITIES` in both scripts (and the id to `CITIES` in `app.js`), then:

```bash
rm -rf raw && python3 scripts/fetch_osm.py && python3 scripts/build_graph.py
```

Map data © OpenStreetMap contributors (ODbL).

Street-lighting poles: City of Vancouver Open Data (Open Government Licence – Vancouver).
