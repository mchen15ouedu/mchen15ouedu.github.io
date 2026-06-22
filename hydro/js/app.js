/* CONUS CREST Calibration — Gauge Hydrograph Viewer.
   Loads out/{gauges.geojson, huc12.geojson, meta.json}; per-gauge WY2019 hydrographs and
   full CSVs are fetched lazily from meta.hf_base (Hugging Face) or local ./data in dev. */
"use strict";

const LOCAL = "data";                          // dev fallback for hydro JSON / csv
let META, GAUGES, HUC, map, gaugeLayer, hucLayer, canvas;
let curMetric, drawer, rectControl;
const markerById = {};                         // id -> circleMarker
const sel = new Set();                         // selected gauge ids
let tool = "point";

const PLOTLY_BG = { paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
  font: { color: "#cdd9e2", size: 11 } };

// per-metric color ramp + domain (low->high order of stops). higher = better for nsce/cc;
// lower = better for rmse; bias is diverging around 0.
const RAMPS = {
  nsce:      { stops: ["#d73027", "#fee08b", "#1a9850"], dom: [-1, 1] },
  cc:        { stops: ["#d73027", "#fee08b", "#1a9850"], dom: [0, 1] },
  rmse:      { stops: ["#1a9850", "#fee08b", "#d73027"], dom: [0, 50] },
  rel_bias:  { stops: ["#2c7bb6", "#ffffbf", "#d7191c"], dom: [-100, 100] },
  norm_bias: { stops: ["#2c7bb6", "#ffffbf", "#d7191c"], dom: [-50, 50] },
};

const GRAY = "#8a98a5";
function lerp(a, b, t) { return a + (b - a) * t; }
function hex2rgb(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
function rgb2hex(c) { return "#" + c.map(v => Math.round(v).toString(16).padStart(2, "0")).join(""); }
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = 1 / (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(t / seg));
  const f = (t - i * seg) / seg, a = hex2rgb(stops[i]), b = hex2rgb(stops[i + 1]);
  return rgb2hex([0, 1, 2].map(k => lerp(a[k], b[k], f)));
}
function colorFor(props) {
  if (!props.has_data) return GRAY;
  const v = props[curMetric], r = RAMPS[curMetric];
  if (v === null || v === undefined) return GRAY;
  return ramp(r.stops, (v - r.dom[0]) / (r.dom[1] - r.dom[0] || 1));
}
function fmt(v, dp = 2) { return v === null || v === undefined ? "—" : (+v).toFixed(dp); }
const hfBase = () => (META && META.hf_base) ? META.hf_base : LOCAL;

async function boot() {
  META = await fetch("data/meta.json").then(r => r.json());
  GAUGES = await fetch("data/gauges.geojson").then(r => r.json());
  HUC = await fetch("data/huc12.geojson").then(r => r.json()).catch(() => ({ features: [] }));
  document.title = META.title;
  document.querySelector("#sidebar header h1").textContent = "CONUS Hydrograph Viewer";
  curMetric = META.default_metric;
  buildMetricSelect();
  initMap();
  drawGauges();
  buildLegend();
  document.getElementById("meta-foot").innerHTML =
    `${META.n_data} of ${META.n_gauges} gauges have a calibrated CREST simulation. ${META.water_year}.`;
  document.getElementById("closeDetail").onclick = () => document.getElementById("detail").classList.add("hidden");
  document.querySelectorAll(".seg-b").forEach(b => b.onclick = () => setTool(b.dataset.tool));
  document.getElementById("clearSel").onclick = clearSelection;
  document.getElementById("dlSel").onclick = downloadSelected;
}

function buildMetricSelect() {
  const s = document.getElementById("metricSelect");
  Object.keys(META.metric_info).forEach(k => {
    const o = document.createElement("option");
    o.value = k; o.textContent = META.metric_info[k].label; s.appendChild(o);
  });
  s.value = curMetric;
  s.onchange = () => { curMetric = s.value; restyle(); buildLegend(); };
}

function initMap() {
  map = L.map("map", { preferCanvas: true, minZoom: 3, maxZoom: 12 }).setView([39, -96], 4);
  canvas = L.canvas({ padding: 0.5 });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Imagery © Esri", maxZoom: 19 });
  const topo = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri", maxZoom: 19 });
  const dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png",
    { attribution: "© OpenStreetMap © CARTO", subdomains: "abcd", maxZoom: 19 });
  dark.addTo(map);
  // HUC12 basins (shown when the basin tool is active)
  hucLayer = L.geoJSON(HUC, {
    style: { color: "#4cc9a0", weight: 1, fillColor: "#4cc9a0", fillOpacity: 0.06 },
    onEachFeature: (f, lyr) => {
      lyr.on("mouseover", e => e.target.setStyle({ fillOpacity: 0.22, weight: 2 }));
      lyr.on("mouseout", e => hucLayer.resetStyle(e.target));
      lyr.on("click", () => { if (tool === "basin") selectBasin(f.properties.gauge_ids || []); });
      lyr.bindTooltip(`HUC12 ${f.properties.huc12} · ${(f.properties.gauge_ids || []).length} gauge(s)`,
        { sticky: true });
    },
  });
  L.control.layers({ "Dark": dark, "Satellite": sat, "Topographic": topo },
    { "HUC12 basins": hucLayer }, { position: "bottomleft", collapsed: true }).addTo(map);
  // rectangle-draw control (used only in rect mode)
  drawer = new L.Draw.Rectangle(map, { shapeOptions: { color: "#f4a259", weight: 2, fillOpacity: 0.05 } });
  map.on(L.Draw.Event.CREATED, e => { selectInBounds(e.layer.getBounds()); });
}

function drawGauges() {
  // draw no-data (faint gray) first so colored gauges sit on top
  const order = [...GAUGES.features].sort((a, b) => (a.properties.has_data ? 1 : 0) - (b.properties.has_data ? 1 : 0));
  order.forEach(f => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const m = L.circleMarker([lat, lon], markerStyle(p)).addTo(map);
    m._g = p;
    m.on("click", () => onGaugeClick(p));
    m.bindTooltip(() => tip(p), { className: "gauge-tip" });
    markerById[p.id] = m;
  });
}
function markerStyle(p) {
  if (!p.has_data) return { renderer: canvas, radius: 3, color: GRAY, weight: 0, fillColor: GRAY, fillOpacity: 0.2 };
  const c = colorFor(p), on = sel.has(p.id);
  return { renderer: canvas, radius: on ? 7 : 5, color: on ? "#fff" : "#0b0f14",
    weight: on ? 2 : 0.6, fillColor: c, fillOpacity: 0.95 };
}
function restyle() { Object.values(markerById).forEach(m => m.setStyle(markerStyle(m._g))); }
function tip(p) {
  const mi = META.metric_info[curMetric];
  return `<div class="gauge-tip"><b>${p.id}</b> ${p.name || ""}<br>` +
    (p.has_data ? `${mi.label}: ${fmt(p[curMetric])}` : "no simulation") +
    (p.huc12 ? `<br>HUC12 ${p.huc12}` : "") + `</div>`;
}

function buildLegend() {
  const r = RAMPS[curMetric], el = document.getElementById("legend"), mi = META.metric_info[curMetric];
  const grad = r.stops.map((s, i) => `${s} ${(100 * i / (r.stops.length - 1)).toFixed(0)}%`).join(", ");
  el.innerHTML =
    `<div class="bar" style="background:linear-gradient(90deg,${grad})"></div>` +
    `<div class="ends"><span>${r.dom[0]}</span><span>${r.dom[1]}</span></div>` +
    `<div style="margin-top:6px">${mi.help}</div>` +
    `<div class="gray-note"><span class="gdot"></span>no simulation (${META.n_gauges - META.n_data} gauges)</div>`;
}

/* ---------------- selection ---------------- */
function setTool(t) {
  tool = t;
  document.querySelectorAll(".seg-b").forEach(b => b.classList.toggle("active", b.dataset.tool === t));
  if (t === "basin") { if (!map.hasLayer(hucLayer)) hucLayer.addTo(map); }
  if (t === "rect") { drawer.enable(); } else { try { drawer.disable(); } catch (e) {} }
}
function onGaugeClick(p) {
  if (tool === "point") { toggleSel(p.id); }
  if (p.has_data) openGauge(p);
}
function toggleSel(id) { sel.has(id) ? sel.delete(id) : sel.add(id); afterSel(); }
function selectBasin(ids) { ids.forEach(i => sel.add(i)); afterSel(); }
function selectInBounds(b) {
  GAUGES.features.forEach(f => {
    if (!f.properties.has_data) return;
    const [lon, lat] = f.geometry.coordinates;
    if (b.contains([lat, lon])) sel.add(f.properties.id);
  });
  afterSel();
}
function clearSelection() { sel.clear(); afterSel(); }
function afterSel() {
  restyle();
  const n = sel.size, info = document.getElementById("selInfo");
  info.textContent = n ? `${n} gauge${n > 1 ? "s" : ""} selected.` : "No gauges selected.";
  document.getElementById("clearSel").classList.toggle("hidden", !n);
  const dl = document.getElementById("dlSel");
  dl.classList.toggle("hidden", !n);
  dl.textContent = `⤓ Download ${n} selected (folders)`;
}

/* ---------------- gauge detail + hydrograph ---------------- */
async function openGauge(p) {
  document.getElementById("gName").textContent = p.id + "  " + (p.name || "");
  document.getElementById("gCrumb").textContent =
    `${p.state || ""}${p.drain_sqkm ? " · " + Math.round(p.drain_sqkm).toLocaleString() + " km²" : ""}` +
    `${p.huc12 ? " · HUC12 " + p.huc12 : ""}`;
  const mi = META.metric_info;
  const card = (k) => `<div class="card"><div class="k">${mi[k].label}</div>
    <div class="v">${fmt(p[k], k === "rmse" || k.includes("bias") ? 1 : 3)}</div></div>`;
  document.getElementById("gMetrics").innerHTML = Object.keys(mi).map(card).join("");
  document.getElementById("gLinks").innerHTML =
    `<button id="dlOne">⤓ Download this gauge (full folder)</button>`;
  document.getElementById("dlOne").onclick = () => downloadFolders([p.id]);
  document.getElementById("detail").classList.remove("hidden");
  document.getElementById("hydro").innerHTML = `<div class="loading">loading hydrograph…</div>`;
  try {
    const h = await fetch(`${hfBase()}/hydro/${p.id}.json`).then(r => r.json());
    drawHydro(h);
  } catch (e) {
    document.getElementById("hydro").innerHTML = `<div class="loading">hydrograph unavailable</div>`;
  }
}

function drawHydro(h) {
  const t0 = new Date(h.t0.replace(" ", "T"));
  const x = Array.from({ length: h.n }, (_, i) => new Date(t0.getTime() + i * 3600e3));
  const maxP = Math.max(0.1, ...h.p.filter(v => v != null));
  const traces = [
    { x, y: h.q, name: "Estimated Q", mode: "lines", line: { color: "#4cc9a0", width: 1.4 }, yaxis: "y" },
    { x, y: h.obs, name: "Observed Q", mode: "lines", line: { color: "#f4f4f4", width: 1.4 }, yaxis: "y" },
    { x, y: h.p, name: "Precip", type: "bar", marker: { color: "#5b9bd5" }, yaxis: "y2", opacity: 0.7 },
  ];
  const layout = Object.assign({
    height: 340, margin: { l: 52, r: 52, t: 10, b: 36 },
    showlegend: true, legend: { orientation: "h", y: 1.12, font: { size: 10 } },
    bargap: 0,
    xaxis: { type: "date", gridcolor: "rgba(255,255,255,.06)" },
    // discharge on the lower ~70% of the panel
    yaxis: { title: "Discharge (m³/s)", rangemode: "tozero", domain: [0, 1], gridcolor: "rgba(255,255,255,.06)" },
    // precip on a REVERSED right axis -> bars hang from the top (standard hydrograph)
    yaxis2: { title: "Precip (mm/h)", overlaying: "y", side: "right", range: [maxP * 3.4, 0], showgrid: false },
  }, PLOTLY_BG);
  Plotly.newPlot("hydro", traces, layout, { displayModeBar: false, responsive: true });
}

/* ---------- downloads: each gauge's full simulation FOLDER from HF ----------
   single gauge -> the gauge's zip directly. Multiple (basin / rectangle / many points)
   -> re-extract every gauge folder into ONE combined zip so the user unzips once and
   gets all the folders side by side: <id>/ts.1.crestphys.csv, <id>/...tif, ... */
async function downloadSelected() { downloadFolders([...sel]); }
async function downloadFolders(ids) {
  if (!ids.length) return;
  const base = hfBase();
  if (ids.length === 1) { window.open(`${base}/sim/${ids[0]}.zip`, "_blank"); return; }
  const estMB = Math.round(ids.length * 2.3);
  if (ids.length > 40 &&
      !confirm(`Bundle ${ids.length} gauge folders (~${estMB} MB) into one zip?`)) return;
  const dl = document.getElementById("dlSel");
  const old = dl.textContent; dl.disabled = true;
  try {
    const parent = new JSZip();
    let done = 0;
    for (const id of ids) {
      dl.textContent = `bundling ${++done}/${ids.length}…`;
      const r = await fetch(`${base}/sim/${id}.zip`);
      if (!r.ok) continue;
      const inner = await JSZip.loadAsync(await r.arrayBuffer());   // unzip the per-gauge folder
      await Promise.all(Object.values(inner.files).filter(f => !f.dir)
        .map(async f => parent.file(f.name, await f.async("blob"))));   // names already prefixed <id>/
    }
    const blob = await parent.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `conus_hydro_${ids.length}_gauges.zip`;
    a.click(); URL.revokeObjectURL(a.href);
  } finally { dl.textContent = old; dl.disabled = false; }
}

boot();
