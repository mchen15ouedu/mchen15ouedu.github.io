#!/usr/bin/env python3
"""Health check for the mcspace.work site (GitHub Pages).

Default run = plain HTTP checks, standard library only:
  * every page answers 200 and carries its <title>
  * every external script / stylesheet a page loads answers 200
  * the data files behind the interactive maps are served and parse
  * every basemap tile template used in this repo serves a real image tile
  * no basemap comes from a provider that needs an API key (CARTO started
    stamping "API KEY REQUIRED" on keyless tiles, which broke the maps once)
  * mchen15ouedu.github.io still redirects to the custom domain

    python scripts/site_health.py                      # checks https://mcspace.work
    SITE_URL=http://localhost:8766 python scripts/site_health.py

--browser = headless-Chromium smoke test of the interactive maps instead
(needs: pip install playwright && python -m playwright install chromium):
  * the Hydrological Zones map takes over its container, loads basemap tiles
    without broken images and actually paints basins on its canvas
  * the atlas and hydro maps load their basemap tiles
  * no JavaScript errors, no failed requests to the site or its CDNs

Exit status 1 when any check fails; the report is printed either way.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

SITE = os.environ.get("SITE_URL", "https://mcspace.work").rstrip("/")
GITHUB_PAGES_URL = "https://mchen15ouedu.github.io/"
REPO = Path(__file__).resolve().parents[1]
TIMEOUT = 40
UA = "mcspace-site-health/1.0 (+https://github.com/mchen15ouedu/mchen15ouedu.github.io)"

# path -> text that must appear in the page's <title>
PAGES = {
    "/": "Mengye Chen",
    "/demos/hydrobasins-atlas.html": "Hydrological Zones",
    "/demos/crest-ai.html": "CREST AI Flood Dashboard",
    "/demos/stem-splitter.html": "AI Stem Splitter",
    "/atlas/": "Solar + Wind Storage Atlas",
    "/hydro/": "CONUS CREST",
}

# path -> how to validate it
#   json     : fetch and parse; the value is a key that must be present
#   geojson  : HEAD must report at least this many bytes and the body must start with "{"
DATA = {
    "/demos/data/atlas_config.json": ("json", "vars"),
    "/demos/data/basins_L7.geojson": ("geojson", 20_000_000),
    "/hydro/data/meta.json": ("json", None),
    "/hydro/data/gauges.geojson": ("geojson", 100_000),
    "/hydro/data/basins.geojson": ("geojson", 100_000),
    "/atlas/data/meta.json": ("json", None),
    "/atlas/data/regions_index.json": ("json", None),
    "/atlas/data/regions.geojson": ("geojson", 100_000),
}

# basemap hosts that only serve proper tiles with a key/token in the URL
KEYED_TILE_HOSTS = {
    "basemaps.cartocdn.com": "CARTO basemaps need an API key; keyless tiles are stamped 'API KEY REQUIRED'",
    "tiles.stadiamaps.com": "Stadia Maps needs an API key or a registered domain",
    "api.mapbox.com": "Mapbox needs an access token",
    "api.maptiler.com": "MapTiler needs an API key",
}
KEY_PARAMS = ("key=", "apikey=", "api_key=", "access_token=")

# pages whose Leaflet map lives in #map (browser smoke test)
MAP_PAGES = ("/atlas/", "/hydro/")

# request failures from these hosts are outside this site's control
IGNORED_FAILURE_HOSTS = ("hf.space",)


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[bool, str, str]] = []

    def add(self, ok: bool, kind: str, detail: str) -> None:
        self.rows.append((ok, kind, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {kind:<8} {detail}", flush=True)

    @property
    def failures(self) -> int:
        return sum(1 for ok, _, _ in self.rows if not ok)


def request(url: str, method: str = "GET", headers: dict | None = None, limit: int | None = None):
    """Return (status, headers, body-bytes). Redirects are followed."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = b"" if method == "HEAD" else (resp.read(limit) if limit else resp.read())
            return resp.status, dict(resp.headers), body
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), b""


def head_or_get(url: str) -> tuple[int, dict]:
    """HEAD, falling back to a truncated GET for servers that refuse HEAD."""
    status, headers, _ = request(url, "HEAD")
    if status in (403, 405, 501):
        status, headers, _ = request(url, "GET", limit=1024)
    return status, headers


def external_assets(html: str) -> list[str]:
    urls = re.findall(r'<script[^>]+src="(https?://[^"]+)"', html)
    for tag in re.findall(r"<link[^>]*>", html):
        if 'rel="stylesheet"' in tag:
            m = re.search(r'href="(https?://[^"]+)"', tag)
            if m:
                urls.append(m.group(1))
    return sorted(set(urls))


def tile_templates() -> list[tuple[str, str]]:
    """(file, template) for every tile-URL template in the repo's HTML/JS."""
    found = []
    pattern = re.compile(r"""https?://[^"'\s]+\{z\}[^"'\s]*""")
    for path in list(REPO.rglob("*.html")) + list(REPO.rglob("*.js")):
        if "/data/" in path.as_posix() or "/.git/" in path.as_posix():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in pattern.finditer(text):
            found.append((path.relative_to(REPO).as_posix(), m.group(0)))
    return sorted(set(found))


def http_checks(rep: Report) -> None:
    seen_assets: set[str] = set()
    for path, title in PAGES.items():
        url = SITE + path
        try:
            status, _, body = request(url)
        except Exception as e:  # noqa: BLE001 - report, don't crash
            rep.add(False, "page", f"{url} ({e})")
            continue
        html = body.decode("utf-8", errors="replace")
        m = re.search(r"<title>(.*?)</title>", html, re.S)
        got = m.group(1).strip() if m else "(no <title>)"
        rep.add(status == 200 and title in got, "page", f"{url} (HTTP {status}, title: {got})")
        for asset in external_assets(html):
            if asset in seen_assets:
                continue
            seen_assets.add(asset)
            try:
                s, _ = head_or_get(asset)
                rep.add(s == 200, "asset", f"{asset} (HTTP {s})")
            except Exception as e:  # noqa: BLE001
                rep.add(False, "asset", f"{asset} ({e})")

    for path, (kind, want) in DATA.items():
        url = SITE + path
        try:
            if kind == "json":
                status, _, body = request(url)
                doc = json.loads(body.decode("utf-8"))
                ok = status == 200 and (want is None or want in doc)
                rep.add(ok, "data", f"{url} (HTTP {status}, {len(body):,} bytes of JSON)")
            else:
                status, headers = head_or_get(url)
                size = int(headers.get("Content-Length", "0") or 0)
                _, _, prefix = request(url, headers={"Range": "bytes=0-63"}, limit=64)
                ok = status == 200 and size >= want and prefix.lstrip().startswith(b"{")
                rep.add(ok, "data", f"{url} (HTTP {status}, {size:,} bytes, starts with {prefix[:12]!r})")
        except Exception as e:  # noqa: BLE001
            rep.add(False, "data", f"{url} ({e})")

    for src, template in tile_templates():
        host = re.match(r"https?://([^/]+)", template).group(1).lower()
        keyed = next((why for h, why in KEYED_TILE_HOSTS.items() if host.endswith(h)), None)
        if keyed and not any(p in template.lower() for p in KEY_PARAMS):
            rep.add(False, "basemap", f"{src}: {template} -> {keyed}")
            continue
        url = (template.replace("{s}", "a").replace("{r}", "")
               .replace("{z}", "2").replace("{x}", "1").replace("{y}", "1"))
        try:
            status, headers, body = request(url)
            ctype = headers.get("Content-Type", "")
            ok = status == 200 and ctype.startswith("image/") and len(body) > 500
            rep.add(ok, "basemap", f"{src}: {url} (HTTP {status}, {ctype}, {len(body):,} bytes)")
        except Exception as e:  # noqa: BLE001
            rep.add(False, "basemap", f"{src}: {url} ({e})")

    try:
        req = urllib.request.Request(GITHUB_PAGES_URL, method="HEAD", headers={"User-Agent": UA})
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(req, timeout=TIMEOUT) as resp:
            status, location = resp.status, resp.headers.get("Location", "")
    except urllib.error.HTTPError as e:
        status, location = e.code, e.headers.get("Location", "")
    except Exception as e:  # noqa: BLE001
        status, location = 0, str(e)
    rep.add(status in (301, 302, 308) and location.startswith(SITE.replace("http://", "https://")),
            "redirect", f"{GITHUB_PAGES_URL} -> HTTP {status} {location}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


MAP_READY_JS = """
() => {
  const el = document.getElementById(%r);
  if (!el) return false;
  const loaded = el.querySelectorAll('img.leaflet-tile-loaded').length;
  if (loaded < 4) return false;
  if (!%s) return true;
  const cv = el.querySelector('canvas');
  if (!cv) return false;
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4 * 199) if (d[i] > 0) n++;
  return n > 20;   // basins have been painted, not just an empty canvas
}
"""

MAP_STATS_JS = """
(id) => {
  const el = document.getElementById(id);
  const tiles = [...el.querySelectorAll('img.leaflet-tile')];
  return {
    tiles: tiles.length,
    loaded: el.querySelectorAll('img.leaflet-tile-loaded').length,
    broken: tiles.filter(t => t.complete && t.naturalWidth === 0).length,
    hosts: [...new Set(tiles.map(t => new URL(t.src).host))],
    canvas: !!el.querySelector('canvas'),
  };
}
"""


def browser_checks(rep: Report) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        rep.add(False, "browser", "playwright is not installed: pip install playwright && python -m playwright install chromium")
        return

    def ignored(url: str, failure: str | None) -> bool:
        # Leaflet cancels tile loads when the zoom moves on; the browser reports those as
        # net::ERR_ABORTED, which is not a server failure
        return (url.endswith("/favicon.ico") or any(h in url for h in IGNORED_FAILURE_HOSTS)
                or "ERR_ABORTED" in str(failure or ""))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        targets = [("/demos/hydrobasins-atlas.html", "map-P", True)] + [(path, "map", False) for path in MAP_PAGES]
        for path, map_id, needs_canvas in targets:
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors: list[str] = []
            failed: list[str] = []
            page.on("pageerror", lambda e, errors=errors: errors.append(str(e)))
            page.on("console", lambda m, errors=errors: errors.append(m.text) if m.type == "error" else None)
            page.on("requestfailed", lambda r, failed=failed: None if ignored(r.url, r.failure) else failed.append(f"{r.url} ({r.failure})"))
            url = SITE + path
            try:
                page.goto(url, wait_until="load", timeout=120_000)
                page.locator("#" + map_id).scroll_into_view_if_needed()
                page.wait_for_function(MAP_READY_JS % (map_id, "true" if needs_canvas else "false"), timeout=180_000)
                stats = page.evaluate(MAP_STATS_JS, map_id)
                ok = stats["loaded"] >= 4 and stats["broken"] == 0 and (stats["canvas"] or not needs_canvas)
                rep.add(ok, "browser", f"{url} #{map_id} renders ({stats})")
            except Exception as e:  # noqa: BLE001
                rep.add(False, "browser", f"{url} #{map_id} did not render: {str(e).splitlines()[0]}")
            rep.add(not errors, "browser", f"{url} JavaScript errors: {errors[:3] if errors else 'none'}")
            rep.add(not failed, "browser", f"{url} failed requests: {failed[:3] if failed else 'none'}")
            page.close()
        browser.close()


def main(argv: list[str]) -> int:
    if hasattr(sys.stdout, "reconfigure"):  # Windows consoles: never choke on the pages' typography
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    rep = Report()
    print(f"Site health check for {SITE}\n")
    if "--browser" in argv:
        browser_checks(rep)
    else:
        http_checks(rep)
    total = len(rep.rows)
    print(f"\n{total - rep.failures}/{total} checks passed" + (f", {rep.failures} FAILED" if rep.failures else ""))
    return 1 if rep.failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
