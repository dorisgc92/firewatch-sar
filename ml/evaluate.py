"""
evaluate.py
============
Runs both classifiers (WorldCover lookup, multispectral deep model) over
a labeled FIRMS sample (from download_firms_sample.py) and reports
standard classification metrics against NASA's own `type` field as
ground truth. Every run gets appended to results_log.jsonl so nothing
gets lost as more runs (bigger samples, the multispectral classifier,
future code changes) come in -- see log_run()/print_log_summary().

Ground truth mapping (NASA type -> this app's category):
    0 (vegetation_fire)     -> forestal
    1 (volcano)             -> otro
    2 (static_land_source)  -> urbano   (NASA's catch-all for "not a
                                          vegetation fire" -- industrial
                                          sites, gas flares, etc.; the
                                          closest available match to
                                          "urbano" in this app's scheme)
    3 (offshore)             -> otro

Also reports a "merged vegetation" view (forestal+agricola collapsed into
one class before scoring) alongside the normal 4-class report -- NASA's
type field never distinguishes forest fires from agricultural burns in
the first place (both are type=0), so a classifier correctly splitting
"vegetacion" into forestal vs. agricola looks like it's making mistakes
against ground truth that can't actually validate that split. The merged
view answers "did it get vegetation-vs-not right" on its own, separate
from the finer split the 4-class report is (fairly) less confident about.

Usage:
    python evaluate.py firms_sample.csv --classifier worldcover
    python evaluate.py firms_sample.csv --classifier multispectral
    python evaluate.py firms_sample.csv --classifier both
    python evaluate.py firms_sample.csv --sample-size 5000
    python evaluate.py --show-log
"""

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

NASA_TYPE_TO_CATEGORY = {
    "0": "forestal",
    "1": "otro",
    "2": "urbano",
    "3": "otro",
}

CATEGORIES = ["forestal", "urbano", "agricola", "otro"]
LOG_PATH = Path(__file__).parent / "results_log.jsonl"


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


def stratified_sample(rows, n, seed=42):
    """
    Keeps class proportions intact while shrinking to n rows total --
    useful for a fast first pass over a big download before committing to
    evaluating all of it. Without stratifying, a plain random sample of a
    heavily imbalanced dataset (this one is ~93% forestal) could easily
    end up with zero examples of a minority class, making that class's
    metrics meaningless (0/0) instead of just noisier.
    """
    import random
    random.seed(seed)
    by_class = {}
    for row in rows:
        by_class.setdefault(row["ground_truth"], []).append(row)
    total = len(rows)
    sample = []
    for label, group in by_class.items():
        share = max(1, round(n * len(group) / total))
        sample.extend(random.sample(group, min(share, len(group))))
    random.shuffle(sample)
    return sample[:n] if len(sample) > n else sample


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

    return {"accuracy": accuracy, "macro_f1": macro_f1, "per_class": per_class, "confusion": confusion, "n": n,
            "labels": labels}


def print_report(name, metrics):
    labels = metrics["labels"]
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
    header = "".join(f"{c[:8]:>10}" for c in labels)
    print(f"  {'':<10}{header}")
    for true_label in labels:
        row = "".join(f"{metrics['confusion'][true_label][pred]:>10}" for pred in labels)
        print(f"  {true_label:<10}{row}")


def merged_vegetation_metrics(y_true, y_pred):
    """forestal+agricola collapsed into one 'vegetacion' class -- see
    module docstring for why this view matters alongside the 4-class one."""
    collapse = lambda c: "vegetacion" if c in ("forestal", "agricola") else c
    merged_true = [collapse(c) for c in y_true]
    merged_pred = [collapse(c) for c in y_pred]
    labels = ["vegetacion", "urbano", "otro"]
    return compute_metrics(merged_true, merged_pred, labels)


def log_run(name, sample_csv, metrics, merged_metrics=None, extra=None):
    """
    Appends one line of JSON per run to results_log.jsonl -- append-only,
    so nothing gets overwritten and every past run stays comparable
    against whatever comes next. JSONL (one JSON object per line) rather
    than a single JSON array specifically so it's always safe to append
    to without ever needing to read-modify-write the whole file.
    """
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "classifier": name,
        "sample_csv": sample_csv,
        "n": metrics["n"],
        "accuracy": round(metrics["accuracy"], 4),
        "macro_f1": round(metrics["macro_f1"], 4),
        "per_class": {k: {"precision": round(v["precision"], 4), "recall": round(v["recall"], 4),
                           "f1": round(v["f1"], 4), "support": v["support"]}
                      for k, v in metrics["per_class"].items()},
    }
    if merged_metrics:
        record["merged_vegetation_accuracy"] = round(merged_metrics["accuracy"], 4)
        record["merged_vegetation_macro_f1"] = round(merged_metrics["macro_f1"], 4)
    if extra:
        record.update(extra)
    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(record) + "\n")
    print(f"\n  Saved to {LOG_PATH}")


def print_log_summary():
    """Every run saved so far -- `python evaluate.py --show-log`."""
    if not LOG_PATH.exists():
        print("No runs logged yet.")
        return
    print(f"\n{'Timestamp':<21}{'Classifier':<16}{'Win':>5}{'n':>7}{'Accuracy':>10}{'Macro F1':>10}{'Veg.Acc':>9}")
    with open(LOG_PATH) as f:
        for line in f:
            r = json.loads(line)
            ts = r["timestamp"][:19].replace("T", " ")
            veg_val = r.get("merged_vegetation_accuracy")
            veg = f"{veg_val:.3f}" if veg_val is not None else "—"
            win = r.get("window_size", "—")
            print(f"{ts:<21}{r['classifier']:<16}{str(win):>5}{r['n']:>7}{r['accuracy']:>10.3f}{r['macro_f1']:>10.3f}{veg:>9}")


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
    metrics = compute_metrics(y_true, y_pred, CATEGORIES)
    return metrics, y_true, y_pred


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sample_csv", nargs="?", help="Output of download_firms_sample.py")
    parser.add_argument("--classifier", choices=["worldcover", "multispectral", "both"], default="both")
    parser.add_argument("--sample-size", type=int, default=None,
                         help="Evaluate a stratified subset instead of the full file (faster first pass)")
    parser.add_argument("--window-size", type=int, default=5,
                         help="WorldCover majority-vote window (pixels, 10m each). 1 = single pixel, no voting.")
    parser.add_argument("--show-log", action="store_true", help="Print every past run and exit")
    args = parser.parse_args()

    if args.show_log:
        print_log_summary()
        return

    if not args.sample_csv:
        print("sample_csv is required unless using --show-log")
        sys.exit(1)

    sample = load_labeled_sample(args.sample_csv)
    print(f"Loaded {len(sample)} labeled points from {args.sample_csv}")
    if args.sample_size and args.sample_size < len(sample):
        sample = stratified_sample(sample, args.sample_size)
        print(f"Using a stratified subset of {len(sample)} points (--sample-size).")
    if not sample:
        print("No labeled points found — nothing to evaluate. Try a larger --days window in download_firms_sample.py.")
        sys.exit(1)

    results = {}

    if args.classifier in ("worldcover", "both"):
        import worldcover_classifier
        classify_fn = lambda points: worldcover_classifier.classify_batch(points, window_size=args.window_size)
        metrics, y_true, y_pred = run_classifier(f"WorldCover (Nivel 1, window={args.window_size})", classify_fn, sample)
        print_report("WorldCover (Nivel 1)", metrics)
        merged = merged_vegetation_metrics(y_true, y_pred)
        print_report("WorldCover (Nivel 1) — vegetacion fusionada (forestal+agricola)", merged)
        log_run("worldcover", args.sample_csv, metrics, merged, extra={"window_size": args.window_size})
        results["worldcover"] = metrics

    if args.classifier in ("multispectral", "both"):
        import multispectral_classifier
        clf = multispectral_classifier.MultispectralClassifier()
        metrics, y_true, y_pred = run_classifier("Multispectral SSL4EO+EuroSAT (Nivel 2)", clf.classify_batch, sample)
        print_report("Multispectral SSL4EO+EuroSAT (Nivel 2)", metrics)
        merged = merged_vegetation_metrics(y_true, y_pred)
        print_report("Multispectral (Nivel 2) — vegetacion fusionada (forestal+agricola)", merged)
        log_run("multispectral", args.sample_csv, metrics, merged)
        results["multispectral"] = metrics

    if len(results) == 2:
        print(f"\n{'=' * 60}")
        print("  Comparison")
        print(f"{'=' * 60}")
        print(f"  WorldCover accuracy:     {results['worldcover']['accuracy']:.3f}")
        print(f"  Multispectral accuracy:  {results['multispectral']['accuracy']:.3f}")
        print(f"  WorldCover macro F1:     {results['worldcover']['macro_f1']:.3f}")
        print(f"  Multispectral macro F1:  {results['multispectral']['macro_f1']:.3f}")

    print("\nTip: run `python evaluate.py --show-log` anytime to see every run so far.")


if __name__ == "__main__":
    main()
