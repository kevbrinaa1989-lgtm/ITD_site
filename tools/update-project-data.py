"""Refresh browser project data from projects.json; preserve the image registry."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent
target = root / "project-data.js"
source = target.read_text(encoding="utf-8")
marker = "window.ITD_PROJECTS="
assert marker in source, "The project registry is missing"
projects = json.loads((root / "projects.json").read_text(encoding="utf-8"))
ids = [p["id"] for p in projects]
assert len(ids) == len(set(ids)), "Project IDs must be unique"
for project in projects:
    assert project["gallery"], f"Empty gallery: {project['id']}"
    assert any(g["assetId"] == project["cover"] for g in project["gallery"]), f"Cover is missing from gallery: {project['id']}"
target.write_text(source.split(marker, 1)[0] + marker + json.dumps(projects, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
print(f"Updated {len(projects)} projects in {target.name}")
