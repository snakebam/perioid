/* perioid — cycle tracker
   client-side only, password gate (mmiebaperiod), localStorage persistence.
*/

const PASSWORD = "mmiebaperiod";
const STORAGE_KEY = "perioid.data.v1";
const SESSION_KEY = "perioid.session";

const PHASES = [
  { key: "menstruation", label: "menstruatie", start: 1,  end: 5,  color: "#ff4d6d" },
  { key: "follicular",   label: "folliculair", start: 6,  end: 12, color: "#8ad7ff" },
  { key: "fertile",      label: "vruchtbaar",  start: 13, end: 13, color: "#ffd166" },
  { key: "ovulation",    label: "ovulatie",    start: 14, end: 14, color: "#ffb703" },
  { key: "fertile2",     label: "vruchtbaar",  start: 15, end: 16, color: "#ffd166" },
  { key: "implantation", label: "innesteling", start: 17, end: 17, color: "#e2a4ff" },
  { key: "early-luteal", label: "vroege luteaal", start: 17, end: 23, color: "#c89cff" },
  { key: "late-luteal",  label: "late luteaal",   start: 24, end: 28, color: "#a26bff" },
];

/* --- utils --- */
const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => [...el.querySelectorAll(q)];
const fmt = d => d.toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" });
const fmtLong = d => d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtMonth = d => d.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
const toISO = d => d.toISOString().slice(0,10);
const parseISO = s => { const [y,m,dd] = s.split("-").map(Number); return new Date(y, m-1, dd); };
const daysBetween = (a, b) => Math.round((b - a) / 86400000);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const startOfDay = d => { const r = new Date(d); r.setHours(0,0,0,0); return r; };

/* gaussian pdf for menstruation probability */
function gauss(x, mu, sigma) {
  if (sigma < 1) sigma = 1;
  return Math.exp(-0.5 * Math.pow((x - mu)/sigma, 2)) / (sigma * Math.sqrt(2 * Math.PI));
}

/* --- data store --- */
let DATA = null;
let repoData = null;

async function loadInitial() {
  try {
    const r = await fetch("data.json", { cache: "no-store" });
    repoData = await r.json();
  } catch { repoData = { patient: { name: "—" }, cycles: [], doctorEntries: [] }; }
  const local = localStorage.getItem(STORAGE_KEY);
  DATA = local ? JSON.parse(local) : structuredClone(repoData);
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA)); }

/* --- predictions --- */
function getStats() {
  const cycles = [...DATA.cycles].sort((a,b)=> a.start.localeCompare(b.start));
  // recompute lengthFromPrev from dates
  const lengths = [];
  for (let i = 1; i < cycles.length; i++) {
    lengths.push(daysBetween(parseISO(cycles[i-1].start), parseISO(cycles[i].start)));
  }
  const recent = lengths.slice(-6);
  const useLengths = recent.length ? recent : lengths;
  const mean = useLengths.length ? useLengths.reduce((a,b)=>a+b,0)/useLengths.length : 28;
  const variance = useLengths.length > 1
    ? useLengths.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(useLengths.length-1)
    : 4;
  const sigma = Math.sqrt(variance) || 2;
  const last = cycles[cycles.length-1];
  return { cycles, lengths, mean, sigma, lastStart: last ? parseISO(last.start) : null };
}

function predictNextStart() {
  const s = getStats();
  if (!s.lastStart) return null;
  return addDays(s.lastStart, Math.round(s.mean));
}

/* probability density of menstruation starting on each day (sum of gaussians for next ~3 cycles) */
function menstruationProb(date, stats) {
  if (!stats.lastStart) return 0;
  const dayIdx = daysBetween(stats.lastStart, date);
  let p = 0;
  for (let k = 1; k <= 4; k++) {
    p += gauss(dayIdx, stats.mean * k, stats.sigma * Math.sqrt(k));
  }
  return p;
}

function cycleDayFor(date, stats) {
  if (!stats.lastStart) return null;
  const diff = daysBetween(stats.lastStart, date);
  if (diff < 0) return null;
  // map day into current predicted cycle
  return (diff % Math.round(stats.mean)) + 1;
}

function phaseFor(cycleDay) {
  if (cycleDay == null) return null;
  // priority: menstruation > ovulation > fertile > luteal > follicular
  if (cycleDay >= 1 && cycleDay <= 5)  return { key: "menstruation", label: "menstruatie", color: "#ff4d6d" };
  if (cycleDay === 14)                 return { key: "ovulation",    label: "ovulatie",    color: "#ffb703" };
  if (cycleDay >= 12 && cycleDay <= 16)return { key: "fertile",      label: "vruchtbaar",  color: "#ffd166" };
  if (cycleDay >= 17 && cycleDay <= 23)return { key: "early-luteal", label: "vroege luteaal", color: "#c89cff" };
  if (cycleDay >= 24)                  return { key: "late-luteal",  label: "late luteaal",   color: "#a26bff" };
  return { key: "follicular", label: "folliculair", color: "#8ad7ff" };
}

/* --- gate --- */
function tryUnlock() {
  if (sessionStorage.getItem(SESSION_KEY) === "1") show();
}
function show() {
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  render();
}
$("#pwForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("#pw").value;
  if (v === PASSWORD) {
    sessionStorage.setItem(SESSION_KEY, "1");
    show();
  } else {
    $("#pwErr").textContent = "fout wachtwoord";
    $("#pw").value = "";
  }
});
$("#logout").addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
});

/* --- tabs --- */
$$(".tab").forEach(b => b.addEventListener("click", () => {
  $$(".tab").forEach(t => t.classList.remove("active"));
  b.classList.add("active");
  $$(".tab-panel").forEach(p => p.classList.remove("active"));
  $("#tab-" + b.dataset.tab).classList.add("active");
  if (b.dataset.tab === "charts") renderCharts();
  if (b.dataset.tab === "calendar") renderCalendar();
}));

/* --- render: overview --- */
function renderOverview() {
  const stats = getStats();
  $("#patientName").textContent = DATA.patient?.name || "—";
  const next = predictNextStart();
  if (next) {
    $("#nextDate").textContent = fmtLong(next);
    const lo = addDays(next, -Math.round(stats.sigma));
    const hi = addDays(next, +Math.round(stats.sigma));
    $("#nextRange").textContent = `bereik: ${fmt(lo)} – ${fmt(hi)}`;
    const today = startOfDay(new Date());
    const du = daysBetween(today, next);
    $("#daysUntil").textContent = du >= 0 ? du : `${-du} geleden`;
    $("#daysUntilSub").textContent = du >= 0 ? "dagen tot menstruatie" : "menstruatie is begonnen / overtijd";
  } else {
    $("#nextDate").textContent = "geen data";
    $("#nextRange").textContent = "";
  }
  $("#avgCycle").textContent = stats.mean ? stats.mean.toFixed(1) + " d" : "—";
  $("#avgCycleSub").textContent = "σ " + stats.sigma.toFixed(2);

  const today = startOfDay(new Date());
  const cd = cycleDayFor(today, stats);
  const ph = phaseFor(cd);
  $("#currentPhase").textContent = ph ? ph.label : "—";
  $("#phaseDay").textContent = cd ? `dag ${cd} van cyclus` : "";

  // phase strip
  const strip = $("#phaseStrip");
  strip.innerHTML = "";
  const total = Math.round(stats.mean);
  const segs = [
    { l: "menstruatie", from: 1, to: 5, c: "#ff4d6d" },
    { l: "folliculair", from: 6, to: 11, c: "#8ad7ff" },
    { l: "vruchtbaar", from: 12, to: 13, c: "#ffd166" },
    { l: "ovulatie",   from: 14, to: 14, c: "#ffb703" },
    { l: "vruchtbaar", from: 15, to: 16, c: "#ffd166" },
    { l: "vroege luteaal", from: 17, to: 23, c: "#c89cff" },
    { l: "late luteaal",   from: 24, to: total, c: "#a26bff" },
  ];
  segs.forEach(s => {
    const w = ((Math.min(s.to,total) - s.from + 1) / total) * 100;
    if (w <= 0) return;
    const el = document.createElement("div");
    el.className = "phase-seg";
    el.style.flexBasis = w + "%";
    el.style.background = s.c;
    el.textContent = w > 8 ? s.l : "";
    strip.appendChild(el);
  });
  if (cd) {
    const m = document.createElement("div");
    m.className = "phase-marker";
    m.style.left = ((cd - 0.5) / total) * 100 + "%";
    strip.appendChild(m);
  }

  // upcoming phases table
  const tb = $("#phaseTable tbody");
  tb.innerHTML = "";
  const upcoming = [
    { label: "ovulatie",      day: 14 },
    { label: "innesteling",   day: 17 },
    { label: "vroege luteaal",day: 17 },
    { label: "late luteaal",  day: 24 },
    { label: "volgende menstruatie", day: total + 1 },
  ];
  if (stats.lastStart) {
    upcoming.forEach(p => {
      const dt = addDays(stats.lastStart, p.day - 1);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${p.label}</td><td>${fmt(dt)}</td><td>dag ${p.day}</td>`;
      tb.appendChild(tr);
    });
  }
}

/* --- calendar --- */
let calCursor = startOfDay(new Date());
calCursor.setDate(1);

function renderCalendar() {
  const stats = getStats();
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  $("#calTitle").textContent = fmtMonth(calCursor);
  const grid = $("#calGrid");
  grid.innerHTML = "";

  const first = new Date(y, m, 1);
  // monday=0
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  const today = startOfDay(new Date());

  // find max prob in window for normalization
  let maxP = 0;
  const win = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const p = menstruationProb(d, stats);
    win.push(p);
    if (p > maxP) maxP = p;
  }

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const inMonth = d.getMonth() === m;
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (inMonth ? "" : " muted") + (d.getTime() === today.getTime() ? " today" : "");

    const cd = cycleDayFor(d, stats);
    const ph = phaseFor(cd);
    const p = win[i];
    const probNorm = maxP > 0 ? p / maxP : 0;

    // base phase tint
    if (ph) {
      const tint = document.createElement("div");
      tint.className = "ph";
      tint.style.background = ph.color;
      tint.style.setProperty("--ph-a", ph.key === "menstruation" ? 0.55 : 0.18);
      tint.style.opacity = ph.key === "menstruation" ? 0.55 : 0.18;
      cell.appendChild(tint);
    }
    // probability overlay (red for menstruation chance)
    if (probNorm > 0.15) {
      const ov = document.createElement("div");
      ov.className = "ph";
      ov.style.background = "radial-gradient(circle at 50% 60%, rgba(255,77,109,"+ (0.15 + probNorm*0.7).toFixed(2) +") 0%, transparent 70%)";
      ov.style.opacity = 1;
      cell.appendChild(ov);
    }

    const day = document.createElement("div");
    day.className = "d";
    day.textContent = d.getDate();
    cell.appendChild(day);

    if (probNorm > 0.3) {
      const pct = document.createElement("div");
      pct.className = "pct";
      pct.textContent = Math.round(probNorm * 100) + "%";
      cell.appendChild(pct);
    }

    cell.title = `${fmt(d)}${cd ? " · dag "+cd : ""}${ph ? " · "+ph.label : ""}${probNorm>0.05 ? " · kans "+(probNorm*100).toFixed(0)+"%" : ""}`;
    grid.appendChild(cell);
  }
}
$("#calPrev").addEventListener("click", ()=> { calCursor.setMonth(calCursor.getMonth()-1); renderCalendar(); });
$("#calNext").addEventListener("click", ()=> { calCursor.setMonth(calCursor.getMonth()+1); renderCalendar(); });
$("#calToday").addEventListener("click", ()=> { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); });

/* --- charts --- */
let charts = {};
function destroyCharts() { Object.values(charts).forEach(c => c?.destroy?.()); charts = {}; }
function renderCharts() {
  destroyCharts();
  const stats = getStats();
  const cycles = stats.cycles;

  // 1) line: cycle length over time
  const labels = [];
  const lens = [];
  for (let i = 1; i < cycles.length; i++) {
    labels.push(fmt(parseISO(cycles[i].start)));
    lens.push(daysBetween(parseISO(cycles[i-1].start), parseISO(cycles[i].start)));
  }
  charts.len = new Chart($("#chartLen"), {
    type: "line",
    data: { labels, datasets: [
      { label: "cyclus (dagen)", data: lens, borderColor: "#ff5d8f", backgroundColor: "rgba(255,93,143,.2)", tension: .3, fill: true, pointRadius: 5 },
      { label: "gemiddelde", data: lens.map(()=>stats.mean), borderColor: "#c89cff", borderDash: [5,5], pointRadius: 0 }
    ]},
    options: { plugins: { legend: { labels: { color: "#f4e8ee" } } },
      scales: {
        x: { ticks: { color: "#b08aa0" }, grid: { color: "#4a2c3f" } },
        y: { ticks: { color: "#b08aa0" }, grid: { color: "#4a2c3f" }, suggestedMin: 20, suggestedMax: 35 }
      } }
  });

  // 2) histogram
  const bins = {};
  lens.forEach(l => { bins[l] = (bins[l]||0)+1; });
  const bk = Object.keys(bins).sort((a,b)=>a-b);
  charts.hist = new Chart($("#chartHist"), {
    type: "bar",
    data: { labels: bk, datasets: [{ label: "aantal", data: bk.map(k=>bins[k]), backgroundColor: "#ff5d8f" }] },
    options: { plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "cycluslengte (dagen)", color: "#b08aa0" }, ticks: { color: "#b08aa0" }, grid: { color: "#4a2c3f" } },
        y: { ticks: { color: "#b08aa0", stepSize: 1 }, grid: { color: "#4a2c3f" } }
      } }
  });

  // 3) probability over next 60 days
  const probLabels = [], probData = [];
  const today = startOfDay(new Date());
  let maxP = 0;
  const raw = [];
  for (let i = 0; i < 60; i++) {
    const d = addDays(today, i);
    const p = menstruationProb(d, stats);
    raw.push(p);
    if (p > maxP) maxP = p;
    probLabels.push(d.toLocaleDateString("nl-NL", { day: "2-digit", month: "2-digit" }));
  }
  raw.forEach(p => probData.push(maxP ? (p/maxP*100) : 0));
  charts.prob = new Chart($("#chartProb"), {
    type: "line",
    data: { labels: probLabels, datasets: [{
      label: "kans (genormaliseerd)",
      data: probData, borderColor: "#ff4d6d", backgroundColor: "rgba(255,77,109,.25)", fill: true, tension: .35, pointRadius: 0
    }]},
    options: { plugins: { legend: { labels: { color: "#f4e8ee" } } },
      scales: {
        x: { ticks: { color: "#b08aa0", maxTicksLimit: 12 }, grid: { color: "#4a2c3f" } },
        y: { ticks: { color: "#b08aa0", callback: v => v+"%" }, grid: { color: "#4a2c3f" }, min: 0, max: 100 }
      } }
  });
}

/* --- doctor / data tabs --- */
function renderCyclesTable() {
  const tb = $("#cyclesTable tbody");
  tb.innerHTML = "";
  const cycles = [...DATA.cycles].sort((a,b)=> a.start.localeCompare(b.start));
  cycles.forEach((c, idx) => {
    const prev = idx > 0 ? daysBetween(parseISO(cycles[idx-1].start), parseISO(c.start)) : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmt(parseISO(c.start))}</td><td>${prev}${prev!=="—"?" d":""}</td><td>${c.note||""}</td><td><button class="row-del">verwijder</button></td>`;
    tr.querySelector(".row-del").addEventListener("click", ()=> {
      DATA.cycles = DATA.cycles.filter(x => !(x.start === c.start));
      persist(); render();
    });
    tb.appendChild(tr);
  });
}
function renderDocList() {
  const ul = $("#docList");
  ul.innerHTML = "";
  const items = [...(DATA.doctorEntries||[])].sort((a,b)=> b.date.localeCompare(a.date));
  items.forEach(e => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="meta"><span>${fmt(parseISO(e.date))}</span><span class="tag-pill">${e.type}</span></div><div>${escapeHtml(e.text)}</div>`;
    ul.appendChild(li);
  });
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

$("#addCycleForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = $("#cycleDate").value;
  const note = $("#cycleNote").value;
  if (!date) return;
  if (!DATA.cycles.some(c => c.start === date)) {
    DATA.cycles.push({ start: date, lengthFromPrev: null, note });
    persist(); render();
  }
  e.target.reset();
});
$("#docForm").addEventListener("submit", e => {
  e.preventDefault();
  const entry = {
    date: $("#docDate").value,
    type: $("#docType").value,
    text: $("#docText").value,
    createdAt: new Date().toISOString()
  };
  if (!entry.date || !entry.text) return;
  DATA.doctorEntries = DATA.doctorEntries || [];
  DATA.doctorEntries.push(entry);
  persist(); render();
  e.target.reset();
});

$("#exportBtn").addEventListener("click", ()=> {
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "data.json"; a.click();
  URL.revokeObjectURL(url);
});
$("#importBtn").addEventListener("click", ()=> $("#importFile").click());
$("#importFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  const txt = await f.text();
  try { DATA = JSON.parse(txt); persist(); render(); }
  catch { alert("ongeldige JSON"); }
});
$("#resetBtn").addEventListener("click", ()=> {
  if (confirm("Reset naar repo data.json? Lokale wijzigingen gaan verloren.")) {
    DATA = structuredClone(repoData);
    persist(); render();
  }
});

function renderDataPreview() { $("#dataPreview").textContent = JSON.stringify(DATA, null, 2); }

/* --- master render --- */
function render() {
  renderOverview();
  renderCalendar();
  renderCyclesTable();
  renderDocList();
  renderDataPreview();
  if ($("#tab-charts").classList.contains("active")) renderCharts();
}

/* --- boot --- */
(async function boot() {
  await loadInitial();
  // pre-fill today in forms
  const today = toISO(new Date());
  $("#cycleDate").value = today;
  $("#docDate").value = today;
  tryUnlock();
})();
