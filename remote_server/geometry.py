"""
geometry.py
============
Point-in-polygon test (ray casting), used to check whether a fire
detection falls inside an OSM landuse=residential/commercial/retail
polygon -- the override signal for cases where ESA WorldCover's raw
10m-pixel land cover answer disagrees with what a human would call the
zone (a real backyard tree canopy or an undeveloped lot read as
"vegetation" by WorldCover, even though it sits inside a residential
neighborhood). See remote_server/api.py's /classify-landcover for how
this gets applied.

No external dependencies (no shapely) -- OSM polygon rings here are
simple, and a hand-rolled ray-cast is plenty accurate for "is this fire
inside this neighborhood's boundary" at the precision this needs.
"""


def point_in_ring(lat, lon, ring):
    """
    Standard ray-casting point-in-polygon test. ring is a list of
    (lat, lon) tuples forming a closed (or implicitly-closed) polygon
    boundary. Returns True/False. Doesn't handle self-intersecting or
    multi-part (multipolygon-with-holes) rings specially -- OSM
    landuse=residential/commercial/retail ways are almost always simple
    single rings, and a stray edge case here just means an occasional
    point near a genuinely complex polygon's edge might be misjudged,
    which is no worse than WorldCover's own pixel-level ambiguity this
    is meant to help correct.
    """
    if len(ring) < 3:
        return False
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        lat_i, lon_i = ring[i]
        lat_j, lon_j = ring[j]
        if ((lon_i > lon) != (lon_j > lon)) and \
           (lat < (lat_j - lat_i) * (lon - lon_i) / (lon_j - lon_i + 1e-15) + lat_i):
            inside = not inside
        j = i
    return inside


def ring_bbox(ring):
    """Returns (west, south, east, north) for a ring's coordinates --
    used to cheaply pre-filter polygon candidates via a plain SQL range
    query before running the more expensive exact point_in_ring test."""
    lats = [p[0] for p in ring]
    lons = [p[1] for p in ring]
    return (min(lons), min(lats), max(lons), max(lats))
