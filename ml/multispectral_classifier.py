"""
multispectral_classifier.py
=============================
Nivel 2: runs an actual pretrained deep-learning model over real
Sentinel-2 multispectral bands around each fire point. This is what was
asked for literally -- "analiza las bandas... clasifique en forestales y
urbanos" -- as opposed to worldcover_classifier.py's precomputed-map
lookup.

Two pieces, both genuinely pretrained (nothing here trains a neural
network from scratch):

1. Backbone: a ResNet18 pretrained via SSL4EO-S12 (self-supervised
   contrastive learning -- MoCo -- on millions of unlabeled Sentinel-2
   scenes worldwide), loaded through torchgeo. This produces a strong
   general-purpose embedding of a Sentinel-2 patch; it was never trained
   to output "forest" vs "urban" labels directly, so:

2. Probe: a scikit-learn LogisticRegression fit on top of those frozen
   embeddings, using the EuroSAT benchmark (27,000 labeled Sentinel-2
   patches across 10 land-use classes, incl. Forest/Industrial/
   Residential/AnnualCrop). Fitting a logistic regression on a few
   thousand pre-extracted embedding vectors takes seconds on CPU -- this
   is NOT the "gran etapa de entrenamiento" being avoided; the deep
   network itself (the expensive part) stays completely frozen. Think of
   it as calibrating a ruler against a known reference, not building the
   ruler.

Fetching the actual imagery: queries Earth Search's public STAC API
(Element84, AWS Open Data, no auth) for the least-cloudy recent
Sentinel-2 L2A scene covering each point, and reads a small patch
(64x64px, ~640m) of the bands the model expects.

None of this network access (STAC catalog, Sentinel-2 COGs, EuroSAT
benchmark download, torchgeo's own weight hosting) is reachable from
this sandbox -- run and debug this file on your own machine.
"""

import os
import sqlite3

import numpy as np

try:
    import torch
    import torchgeo.models as tgm
except ImportError:
    torch = None
    tgm = None

try:
    from pystac_client import Client as StacClient
    import rasterio
    from rasterio.windows import Window
    from rasterio.warp import transform
except ImportError:
    StacClient = None

STAC_URL = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
PATCH_SIZE_PX = 64

# The 10 bands SSL4EO-S12/EuroSAT-style Sentinel-2 models typically expect
# (B10 cirrus is excluded -- not present in L2A surface reflectance
# products, only L1C). Order matters -- must match what the pretrained
# weights were trained on.
BANDS = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B09", "B11", "B12"]

EUROSAT_CLASS_MAP = {
    "AnnualCrop": "agricola",
    "Forest": "forestal",
    "HerbaceousVegetation": "forestal",
    "Highway": "urbano",
    "Industrial": "urbano",
    "Pasture": "forestal",
    "PermanentCrop": "agricola",
    "Residential": "urbano",
    "River": "otro",
    "SeaLake": "otro",
}

CACHE_DB_PATH = os.path.join(os.path.dirname(__file__), "multispectral_cache.db")


def _init_cache():
    conn = sqlite3.connect(CACHE_DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS lookups (grid_key TEXT PRIMARY KEY, category TEXT, eurosat_class TEXT)")
    conn.commit()
    return conn


def _grid_key(lat, lon, grid_deg=0.01):
    return f"{round(lat / grid_deg) * grid_deg:.3f},{round(lon / grid_deg) * grid_deg:.3f}"


def fetch_sentinel2_patch(lat, lon, max_cloud_cover=20):
    """
    Finds the least-cloudy recent Sentinel-2 L2A scene covering (lat, lon)
    and reads a small multi-band patch centered on the point. Returns a
    numpy array shaped (len(BANDS), PATCH_SIZE_PX, PATCH_SIZE_PX), or None
    if no suitable scene is found.
    """
    if StacClient is None:
        raise RuntimeError("Missing deps -- run: pip install pystac-client rasterio")

    catalog = StacClient.open(STAC_URL)
    search = catalog.search(
        collections=[COLLECTION],
        intersects={"type": "Point", "coordinates": [lon, lat]},
        query={"eo:cloud_cover": {"lt": max_cloud_cover}},
        sortby=[{"field": "properties.datetime", "direction": "desc"}],
        max_items=1,
    )
    items = list(search.items())
    if not items:
        return None
    item = items[0]

    band_arrays = []
    for band in BANDS:
        asset = item.assets.get(band)
        if asset is None:
            return None
        with rasterio.open(asset.href) as src:
            px, py = transform("EPSG:4326", src.crs, [lon], [lat])
            col, row = ~src.transform * (px[0], py[0])
            col, row = int(col), int(row)
            half = PATCH_SIZE_PX // 2
            window = Window(col - half, row - half, PATCH_SIZE_PX, PATCH_SIZE_PX)
            patch = src.read(1, window=window, boundless=True, fill_value=0)
            band_arrays.append(patch)
    return np.stack(band_arrays, axis=0).astype(np.float32)


class MultispectralClassifier:
    """
    Loads the frozen backbone once and reuses it across many points --
    loading model weights per-call would be far slower than the
    classification itself.
    """
    def __init__(self):
        if torch is None:
            raise RuntimeError("Missing deps -- run: pip install torch torchgeo scikit-learn")
        weights = tgm.ResNet18_Weights.SENTINEL2_ALL_MOCO
        self.backbone = tgm.resnet18(weights=weights)
        self.backbone.eval()
        self.probe = self._fit_eurosat_probe()

    def _fit_eurosat_probe(self):
        """
        Extracts frozen embeddings for the EuroSAT training split and fits
        a logistic regression on top -- seconds on CPU, not a training
        run on the deep network itself. torchgeo's EuroSAT dataset class
        handles the (one-time, cached) download.
        """
        from sklearn.linear_model import LogisticRegression
        from torchgeo.datasets import EuroSAT

        print("Fitting linear probe on EuroSAT embeddings (one-time, seconds not hours)...")
        ds = EuroSAT(root=os.path.join(os.path.dirname(__file__), "eurosat_data"), split="train", download=True)
        embeddings, labels = [], []
        with torch.no_grad():
            for i in range(len(ds)):
                sample = ds[i]
                image = sample["image"].unsqueeze(0).float()
                embedding = self.backbone(image).squeeze(0).numpy()
                embeddings.append(embedding)
                labels.append(ds.classes[sample["label"]])
        probe = LogisticRegression(max_iter=1000)
        probe.fit(np.array(embeddings), labels)
        print(f"  Probe fit on {len(embeddings)} EuroSAT samples.")
        return probe

    def classify_patch(self, patch):
        """patch: (bands, H, W) numpy array -> (category, eurosat_class)."""
        tensor = torch.from_numpy(patch).unsqueeze(0)
        with torch.no_grad():
            embedding = self.backbone(tensor).squeeze(0).numpy()
        eurosat_class = self.probe.predict([embedding])[0]
        return EUROSAT_CLASS_MAP.get(eurosat_class, "otro"), eurosat_class

    def classify_point(self, lat, lon, conn=None):
        owns_conn = conn is None
        if owns_conn:
            conn = _init_cache()
        key = _grid_key(lat, lon)
        cached = conn.execute("SELECT category, eurosat_class FROM lookups WHERE grid_key = ?", (key,)).fetchone()
        if cached is not None:
            if owns_conn:
                conn.close()
            return cached[0], cached[1]

        patch = fetch_sentinel2_patch(lat, lon)
        if patch is None:
            if owns_conn:
                conn.close()
            return None, None
        category, eurosat_class = self.classify_patch(patch)
        conn.execute("INSERT OR REPLACE INTO lookups (grid_key, category, eurosat_class) VALUES (?, ?, ?)",
                      (key, category, eurosat_class))
        conn.commit()
        if owns_conn:
            conn.close()
        return category, eurosat_class

    def classify_batch(self, points):
        conn = _init_cache()
        results = [self.classify_point(lat, lon, conn=conn) for lat, lon in points]
        conn.close()
        return results


if __name__ == "__main__":
    clf = MultispectralClassifier()
    test_points = [
        ("Bosque cerca de Tlaquepaque", 20.55, -103.35),
        ("Centro de Guadalajara (urbano)", 20.6767, -103.3475),
    ]
    for label, lat, lon in test_points:
        category, eurosat_class = clf.classify_point(lat, lon)
        print(f"{label}: {category} (EuroSAT class: {eurosat_class})")
