import csv
import glob
import os
import re
from collections import OrderedDict

DOWNLOAD_GLOB = os.environ.get(
    "EVENT_TYPES_INPUT_GLOB",
    os.path.expanduser("~/Downloads/PureStay Event Types By Class - *.csv"),
)
OUT_PATH = os.environ.get(
    "EVENT_TYPES_OUT_PATH",
    os.path.join(os.path.dirname(__file__), "..", "resources", "event_types.csv"),
)

ORDER = ["A", "B", "C", "Student", "Workforce", "Seniors", "Lease-Up", "55+"]


def split_class_fit(value: str):
    s = (value or "").strip().strip('"')
    if not s:
        return []

    parts = [p.strip() for p in re.split(r"\s*,\s*", s) if p.strip()]
    norm = []
    for p in parts:
        p2 = p
        low = p2.lower()
        if low in ["lease-up", "leaseup", "lease up"]:
            p2 = "Lease-Up"
        elif low in ["seniors", "senior"]:
            p2 = "Seniors"
        elif low in ["student", "students"]:
            p2 = "Student"
        elif low in ["workforce"]:
            p2 = "Workforce"
        elif p2 in ["55+", "55 +", "55plus"]:
            p2 = "55+"
        elif p2.upper() in ["A", "B", "C"]:
            p2 = p2.upper()
        norm.append(p2)

    out = []
    for p in norm:
        if p not in out:
            out.append(p)
    return out


def join_class_fit(parts):
    if not parts:
        return ""

    ordered = [x for x in ORDER if x in parts]
    for x in parts:
        if x not in ordered:
            ordered.append(x)
    return ", ".join(ordered)


def norm_type(value: str):
    s = (value or "").strip()
    if not s:
        return ""
    low = s.lower()
    if low.startswith("anch"):
        return "Anchor"
    if low.startswith("mom"):
        return "Momentum"
    return s


def main():
    files = sorted(glob.glob(DOWNLOAD_GLOB))
    if not files:
        raise SystemExit(f"No input files matched: {DOWNLOAD_GLOB}")

    by_name = OrderedDict()

    for fp in files:
        with open(fp, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = (row.get("Event Type") or "").strip()
                if not name:
                    continue

                key = re.sub(r"\s+", " ", name).strip()

                hook = (row.get("Psychological Hook") or "").strip()
                class_fit = split_class_fit(row.get("Class Fit") or "")
                goal = (row.get("Goal") or "").strip()
                notes = (row.get("Notes") or "").strip()
                typ = norm_type(row.get("Type") or "")

                cur = by_name.get(key)
                if not cur:
                    by_name[key] = {
                        "Event Type": key,
                        "Psychological Hook": hook,
                        "Class Fit": class_fit,
                        "Goal": goal,
                        "Notes": notes,
                        "Type": typ,
                    }
                    continue

                for p in class_fit:
                    if p and p not in cur["Class Fit"]:
                        cur["Class Fit"].append(p)

                # Prefer the most informative (longest) text fields.
                for field, val in [
                    ("Psychological Hook", hook),
                    ("Goal", goal),
                    ("Notes", notes),
                ]:
                    if val and (not cur[field] or len(val) > len(cur[field])):
                        cur[field] = val

                # Prefer Anchor if any source says Anchor.
                if typ:
                    if cur["Type"] != "Anchor" and typ == "Anchor":
                        cur["Type"] = "Anchor"
                    elif not cur["Type"]:
                        cur["Type"] = typ

    out_rows = []
    for _k, v in by_name.items():
        out_rows.append(
            {
                "Event Type": v["Event Type"],
                "Psychological Hook": v["Psychological Hook"],
                "Class Fit": join_class_fit(v["Class Fit"]),
                "Goal": v["Goal"],
                "Notes": v["Notes"],
                "Type": v["Type"],
            }
        )

    out_path = os.path.abspath(OUT_PATH)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "Event Type",
                "Psychological Hook",
                "Class Fit",
                "Goal",
                "Notes",
                "Type",
            ],
        )
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"Wrote {out_path}")
    print(f"- inputs: {len(files)} file(s)")
    print(f"- unique event types: {len(out_rows)}")


if __name__ == "__main__":
    main()
