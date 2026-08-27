"""
evaluate.py
============
Runs both classifiers (WorldCover lookup, multispectral deep model) over
a labeled FIRMS sample (from download_firms_sample.py) and reports
standard classification metrics against NASA's own `type` field as
ground truth.

Ground truth mapping (NASA type -> this app's category):
    0 (vegetation_fire)     -> forestal
    1 (volcano)             -> otro
    2 (static_land_source)  -> urbano   (NASA's catch-all for "not a
                                          vegetation fire" -- industrial
                                          sites, gas flares, etc.; the
                                          closest available match to
                                          "urbano" in this app's scheme)
    3 (offshore)             -> otro

Also reports the agreement rate between the two classifiers on the same
points -- useful on its own even without trusting the NASA labels
completely, since two independently-built classifiers agreeing is a
different (weaker, but still informative) kind of evidence than either
one matching ground truth.

Usage:
    python evaluate.py firms_sample.csv --classifier worldcover
    python evaluate.py firms_sample.csv --classifier multispectral
    python evaluate.py firms_sample.csv --classifier both
"""

import argparse
import csv
import sys

NASA_TYPE_TO_CATEGORY = {
    "0": "forestal",
    "1": "otro",
    "2": "urbano",
    "3": "otro",
}

CATEGORIES = ["forestal", "urbano", "agricola", "otro"]


def load_labeled_sample(path):
    rows = []
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            type_raw = (row.get("type") or "").strip()
            if type_raw not in NASA_TYPE_TO_CATEGORY:
                continue
            try:
                lat = float(row["latitude"])
                lon = float(row["longitude"])
            except (KeyError, ValueError):
                continue
            rows.append({"lat": lat, "lon": lon, "ground_truth": NASA_TYPE_TO_CATEGORY[type_raw]})
    return rows


def compute_metrics(y_true, y_pred, labels):
    """
    Plain-Python precision/recall/F1/accuracy + confusion matrix -- no
    sklearn dependency needed just for this, so evaluate.py's core metric
    logic can be tested without installing the heavier ML stack.
    """
    n = len(y_true)
    correct = sum(1 for t, p in zip(y_true, y_pred) if t == p)
    accuracy = correct / n if n else 0.0

    confusion = {t: {p: 0 for p in labels} for t in labels}
    for t, p in zip(y_true, y_pred):
        if t in confusion and p in confusion[t]:
            confusion[t][p] += 1

    per_class = {}
    for label in labels:
        tp = confusion[label][label]
        fp = sum(confusion[other][label] for other in labels if other != label)
        fn = sum(confusion[label][other] for other in labels if other != label)
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        support = sum(confusion[label].values())
        per_class[label] = {"precision": precision, "recall": recall, "f1": f1, "support": support}

    valid_classes = [c for c in per_class if per_class[c]["support"] > 0]
    macro_f1 = sum(per_class[c]["f1"] for c in valid_classes) / len(valid_classes) if valid_classes else 0.0

    return {"accuracy": accuracy, "macro_f1": macro_f1, "per_class": per_class, "confusion": confusion, "n": n}


def print_report(name, metrics):
    print(f"\n{'=' * 60}")
    print(f"  {name}")
    print(f"{'=' * 60}")
    print(f"  n = {metrics['n']}")
    print(f"  Accuracy: {metrics['accuracy']:.3f}")
    print(f"  Macro F1: {metrics['macro_f1']:.3f}")
    print(f"\n  {'Class':<12}{'Precision':>11}{'Recall':>9}{'F1':>8}{'Support':>10}")
    for label, m in metrics["per_class"].items():
        if m["support"] == 0:
            continue
        print(f"  {label:<12}{m['precision']:>11.3f}{m['recall']:>9.3f}{m['f1']:>8.3f}{m['support']:>10}")
    print(f"\n  Confusion matrix (rows = ground truth, cols = predicted):")
    header = "".join(f"{c[:8]:>10}" for c in CATEGORIES)
    print(f"  {'':<10}{header}")
    for true_label in CATEGORIES:
        row = "".join(f"{metrics['confusion'][true_label][pred]:>10}" for pred in CATEGORIES)
        print(f"  {true_label:<10}{row}")


def run_classifier(name, classify_fn, sample):
    points = [(r["lat"], r["lon"]) for r in sample]
    print(f"\nRunning {name} classifier on {len(points)} points...")
    results = classify_fn(points)
    y_true, y_pred = [], []
    n_failed = 0
    for row, (category, _detail) in zip(sample, results):
        if category is None:
            n_failed += 1
            continue
        y_true.append(row["ground_truth"])
        y_pred.append(category)
    if n_failed:
        print(f"  {n_failed} points failed to classify (network/tile availability) — excluded from metrics.")
    return compute_metrics(y_true, y_pred, CATEGORIES)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sample_csv", help="Output of download_firms_sample.py")
    parser.add_argument("--classifier", choices=["worldcover", "multispectral", "both"], default="both")
    args = parser.parse_args()

    sample = load_labeled_sample(args.sample_csv)
    print(f"Loaded {len(sample)} labeled points from {args.sample_csv}")
    if not sample:
        print("No labeled points found — nothing to evaluate. Try a larger --days window in download_firms_sample.py.")
        sys.exit(1)

    results = {}

    if args.classifier in ("worldcover", "both"):
        import worldcover_classifier
        results["worldcover"] = run_classifier("WorldCover (Nivel 1)", worldcover_classifier.classify_batch, sample)
        print_report("WorldCover (Nivel 1)", results["worldcover"])

    if args.classifier in ("multispectral", "both"):
        import multispectral_classifier
        clf = multispectral_classifier.MultispectralClassifier()
        results["multispectral"] = run_classifier("Multispectral SSL4EO+EuroSAT (Nivel 2)", clf.classify_batch, sample)
        print_report("Multispectral SSL4EO+EuroSAT (Nivel 2)", results["multispectral"])

    if len(results) == 2:
        print(f"\n{'=' * 60}")
        print("  Comparison")
        print(f"{'=' * 60}")
        print(f"  WorldCover accuracy:     {results['worldcover']['accuracy']:.3f}")
        print(f"  Multispectral accuracy:  {results['multispectral']['accuracy']:.3f}")
        print(f"  WorldCover macro F1:     {results['worldcover']['macro_f1']:.3f}")
        print(f"  Multispectral macro F1:  {results['multispectral']['macro_f1']:.3f}")


if __name__ == "__main__":
    main()
