/* perioid — cycle tracker 💪
   client-side only, password gate (mmiebaperiod), localStorage persistence.
*/

const PASSWORD = "mmiebaperiod";
const STORAGE_KEY = "perioid.data.v2";
const SESSION_KEY = "perioid.session";

/* --- utils --- */
const $ = (q, el=document) => el.querySelector(q);
const $$ = (q, el=document) => [...el.querySelectorAll(q)];
const fmt = d => d.toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" });
const fmtLong = d => d.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtMonth = d => d.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
const toISO = d => {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
};
const parseISO = s => { const [y,m,dd] = s.split("-").map(Number); return new Date(y, m-1, dd); };
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate()+n); return r; };
const startOfDay = d => { const r = new Date(d); r.setHours(0,0,0,0); return r; };

function gauss(x, mu, sigma) {
  if (sigma < 1) sigma = 1;
  return Math.exp(-0.5 * Math.pow((x - mu)/sigma, 2)) / (sigma * Math.sqrt(2 * Math.PI));
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}
function mad(arr, med) {
  if (!arr.length) return 0;
  const dev = arr.map(x => Math.abs(x - med));
  return median(dev) * 1.4826; // scale to ~σ for normal dist
}

/* --- data store --- */
let DATA = null;
let repoData = null;

async function loadInitial() {
  try {
    const r = await fetch("data.json", { cache: "no-store" });
    repoData = await r.json();
  } catch { repoData = { patient: { name: "—" }, cycles: [], mucus: [], doctorEntries: [] }; }
  const local = localStorage.getItem(STORAGE_KEY);
  DATA = local ? JSON.parse(local) : structuredClone(repoData);
  if (!DATA.mucus) DATA.mucus = [];
  if (!DATA.doctorEntries) DATA.doctorEntries = [];
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA)); }

/* --- predictions --- */
function getStats() {
  const cycles = [...DATA.cycles].sort((a,b)=> a.start.localeCompare(b.start));
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

  // Luteal phase length, estimated from mucus → next period.
  // Egg-white mucus = ~1-2 days before ovulation; luteal phase = ovulation → next period.
  // ROBUST: use median + MAD instead of mean/stdev so a single anovulatory or atypical
  // mucus observation (extreem vroege/late slijm) does not derail the estimate.
  const mucus = [...(DATA.mucus||[])].sort((a,b)=> a.date.localeCompare(b.date));
  const mucusEntries = []; // { date, gap, isOutlier, reason }
  for (const mEntry of mucus) {
    const md = parseISO(mEntry.date);
    const nextCycle = cycles.find(c => parseISO(c.start) > md);
    if (nextCycle) {
      mucusEntries.push({
        date: mEntry.date, note: mEntry.note,
        gap: daysBetween(md, parseISO(nextCycle.start)),
        isOutlier: false, reason: ""
      });
    } else {
      mucusEntries.push({ date: mEntry.date, note: mEntry.note, gap: null, isOutlier: false, reason: "geen volgende cyclus geregistreerd" });
    }
  }
  const gaps = mucusEntries.filter(x => x.gap != null).map(x => x.gap);

  const med = median(gaps);
  const robustSpread = mad(gaps, med ?? 0);
  // outlier window: medisch plausibele luteale fase ligt tussen 9 en 17 dagen,
  // dus mucus→menstruatie tussen ~10 en ~19 dagen. Buiten die range = atypisch.
  // Gebruik 3*MAD met een vloer van 3 dagen, plus harde medische grenzen.
  const tol = Math.max(3 * robustSpread, 3);
  mucusEntries.forEach(e => {
    if (e.gap == null) return;
    const tooFarFromMedian = med != null && Math.abs(e.gap - med) > tol;
    const outsideMedicalRange = e.gap < 8 || e.gap > 20;
    if (tooFarFromMedian || outsideMedicalRange) {
      e.isOutlier = true;
      if (outsideMedicalRange && e.gap > 20) e.reason = "atypisch vroeg in cyclus — mogelijk anovulatoir of dubbele follikel-recruitment";
      else if (outsideMedicalRange && e.gap < 8) e.reason = "atypisch laat in cyclus — mogelijk late ovulatie of verschoven cyclus";
      else e.reason = `wijkt >${tol.toFixed(1)}d af van mediaan (${med.toFixed(1)}d)`;
    }
  });

  const cleanGaps = mucusEntries.filter(x => x.gap != null && !x.isOutlier).map(x => x.gap);
  const usedMedian = cleanGaps.length ? median(cleanGaps) : (med ?? 15.5);
  const lutealEstimate = usedMedian - 1.5; // subtract ~1.5d to go from mucus→menstruation to ovulation→menstruation
  const lutealSigma = cleanGaps.length > 1 ? Math.max(mad(cleanGaps, usedMedian), 1) : 2;

  return { cycles, lengths, mean, sigma, lastStart: last ? parseISO(last.start) : null,
           mucus, mucusEntries, mucusGaps: gaps, mucusGapsClean: cleanGaps,
           lutealEstimate, lutealSigma, lutealMedian: usedMedian };
}

function predictNextStart(stats=null) {
  const s = stats || getStats();
  if (!s.lastStart) return null;
  return addDays(s.lastStart, Math.round(s.mean));
}

/* probability density of menstruation starting on each day (sum over future cycles) */
function menstruationProb(date, stats) {
  if (!stats.lastStart) return 0;
  const dayIdx = daysBetween(stats.lastStart, date);
  if (dayIdx < 1) return 0;
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
  return (diff % Math.round(stats.mean)) + 1;
}

function phaseFor(cycleDay, stats) {
  if (cycleDay == null) return null;
  const total = Math.round(stats.mean);
  const luteal = Math.round(stats.lutealEstimate);
  const ovulDay = total - luteal; // estimated ovulation day in cycle
  const fertileStart = ovulDay - 4;
  const fertileEnd = ovulDay + 1;

  if (cycleDay >= 1 && cycleDay <= 5) return { key: "menstruation", label: "menstruatie 🩸", color: "#ff4d6d" };
  if (cycleDay === ovulDay)            return { key: "ovulation",   label: "ovulatie ⚡",     color: "#ffb703" };
  if (cycleDay >= fertileStart && cycleDay <= fertileEnd) return { key: "fertile", label: "vruchtbaar 💧", color: "#ffd166" };
  if (cycleDay > ovulDay)              return { key: "luteal",      label: "luteaal 🔵",      color: "#2b7fff" };
  return { key: "follicular", label: "folliculair 🔷", color: "#00d4ff" };
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
  const next = predictNextStart(stats);
  if (next) {
    $("#nextDate").textContent = fmtLong(next);
    const lo = addDays(next, -Math.round(stats.sigma));
    const hi = addDays(next, +Math.round(stats.sigma));
    $("#nextRange").textContent = `bereik: ${fmt(lo)} – ${fmt(hi)} (σ ≈ ${stats.sigma.toFixed(1)}d)`;
    const today = startOfDay(new Date());
    const du = daysBetween(today, next);
    $("#daysUntil").textContent = du >= 0 ? du : `${-du} geleden`;
    $("#daysUntilSub").textContent = du >= 0 ? "dagen tot menstruatie" : "menstruatie overtijd";
  } else {
    $("#nextDate").textContent = "geen data";
    $("#nextRange").textContent = "";
  }
  $("#avgCycle").textContent = stats.mean ? stats.mean.toFixed(1) + " d" : "—";
  $("#avgCycleSub").textContent = "σ " + stats.sigma.toFixed(2) + "d · " + stats.lengths.length + " cycli";

  const today = startOfDay(new Date());
  const cd = cycleDayFor(today, stats);
  const ph = phaseFor(cd, stats);
  $("#currentPhase").textContent = ph ? ph.label : "—";
  $("#phaseDay").textContent = cd ? `dag ${cd} van cyclus` : "";

  // phase strip dynamic based on stats
  const strip = $("#phaseStrip");
  strip.innerHTML = "";
  const total = Math.round(stats.mean);
  const luteal = Math.round(stats.lutealEstimate);
  const ovulDay = total - luteal;
  const segs = [
    { l: "menstruatie 🩸", from: 1, to: 5, c: "#ff4d6d" },
    { l: "folliculair 🔷", from: 6, to: ovulDay - 5, c: "#00d4ff" },
    { l: "vruchtbaar 💧", from: ovulDay - 4, to: ovulDay - 1, c: "#ffd166" },
    { l: "ovulatie ⚡", from: ovulDay, to: ovulDay, c: "#ffb703" },
    { l: "vruchtbaar 💧", from: ovulDay + 1, to: ovulDay + 1, c: "#ffd166" },
    { l: "luteaal 🔵", from: ovulDay + 2, to: total, c: "#2b7fff" },
  ];
  segs.forEach(s => {
    const w = ((Math.min(s.to,total) - s.from + 1) / total) * 100;
    if (w <= 0) return;
    const el = document.createElement("div");
    el.className = "phase-seg";
    el.style.flexBasis = w + "%";
    el.style.background = s.c;
    el.textContent = w > 10 ? s.l : "";
    strip.appendChild(el);
  });
  if (cd) {
    const m = document.createElement("div");
    m.className = "phase-marker";
    m.style.left = ((cd - 0.5) / total) * 100 + "%";
    strip.appendChild(m);
  }

  // upcoming phases
  const tb = $("#phaseTable tbody");
  tb.innerHTML = "";
  if (stats.lastStart) {
    const items = [
      { label: "💧 vruchtbaar venster start", day: ovulDay - 4 },
      { label: "⚡ ovulatie", day: ovulDay },
      { label: "🔵 luteale fase start", day: ovulDay + 2 },
      { label: "🩸 volgende menstruatie", day: total + 1 },
    ];
    items.forEach(p => {
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
  const offset = (first.getDay() + 6) % 7;
  const start = addDays(first, -offset);
  const today = startOfDay(new Date());
  const mucusSet = new Set((DATA.mucus||[]).map(x => x.date));
  const cycleSet = new Set(DATA.cycles.map(x => x.start));

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
    const iso = toISO(d);
    const inMonth = d.getMonth() === m;
    const isToday = d.getTime() === today.getTime();
    const cell = document.createElement("div");
    cell.className = "cal-cell" + (inMonth ? "" : " muted") + (isToday ? " today" : "");

    const cd = cycleDayFor(d, stats);
    const ph = phaseFor(cd, stats);
    const p = win[i];
    const probNorm = maxP > 0 ? p / maxP : 0;
    const isMens = cycleSet.has(iso);
    const isMucus = mucusSet.has(iso);

    if (ph) {
      const tint = document.createElement("div");
      tint.className = "ph";
      tint.style.background = ph.color;
      tint.style.opacity = ph.key === "menstruation" ? 0.5 : (ph.key === "ovulation" ? 0.45 : (ph.key === "fertile" ? 0.3 : 0.18));
      cell.appendChild(tint);
    }
    if (probNorm > 0.15) {
      const ov = document.createElement("div");
      ov.className = "ph";
      ov.style.background = "radial-gradient(circle at 50% 60%, rgba(255,77,109,"+ (0.15 + probNorm*0.7).toFixed(2) +") 0%, transparent 70%)";
      cell.appendChild(ov);
    }
    if (isMens) {
      const m1 = document.createElement("div");
      m1.className = "ph";
      m1.style.background = "linear-gradient(135deg, rgba(255,77,109,.9), rgba(180,30,60,.7))";
      cell.appendChild(m1);
    }
    if (isMucus) {
      const m2 = document.createElement("div");
      m2.className = "ph";
      m2.style.background = "radial-gradient(circle at 50% 50%, rgba(90,240,255,.85) 0%, rgba(90,240,255,.2) 60%, transparent 80%)";
      cell.appendChild(m2);
    }

    const day = document.createElement("div");
    day.className = "d";
    day.textContent = d.getDate();
    cell.appendChild(day);

    if (isMucus) {
      const mk = document.createElement("div");
      mk.className = "marker";
      mk.textContent = "💧";
      cell.appendChild(mk);
    } else if (isMens) {
      const mk = document.createElement("div");
      mk.className = "marker";
      mk.textContent = "🩸";
      cell.appendChild(mk);
    }

    if (probNorm > 0.3 && !isMens) {
      const pct = document.createElement("div");
      pct.className = "pct";
      pct.textContent = Math.round(probNorm * 100) + "%";
      cell.appendChild(pct);
    }

    const titleBits = [fmt(d)];
    if (cd) titleBits.push("dag "+cd);
    if (ph) titleBits.push(ph.label);
    if (isMens) titleBits.push("🩸 menstruatie gemeten");
    if (isMucus) titleBits.push("💧 heldere slijm gemeten");
    if (probNorm > 0.05 && !isMens) titleBits.push("kans "+(probNorm*100).toFixed(0)+"%");
    cell.title = titleBits.join(" · ");

    grid.appendChild(cell);
  }
}
$("#calPrev").addEventListener("click", ()=> { calCursor.setMonth(calCursor.getMonth()-1); renderCalendar(); });
$("#calNext").addEventListener("click", ()=> { calCursor.setMonth(calCursor.getMonth()+1); renderCalendar(); });
$("#calToday").addEventListener("click", ()=> { calCursor = new Date(); calCursor.setDate(1); renderCalendar(); });

/* --- charts --- */
let charts = {};
const CHART_COLORS = { ink: "#e8f0fa", muted: "#7a93b0", grid: "#243a55" };
function destroyCharts() { Object.values(charts).forEach(c => c?.destroy?.()); charts = {}; }
function renderCharts() {
  destroyCharts();
  const stats = getStats();
  const cycles = stats.cycles;

  const labels = [];
  const lens = [];
  for (let i = 1; i < cycles.length; i++) {
    labels.push(fmt(parseISO(cycles[i].start)));
    lens.push(daysBetween(parseISO(cycles[i-1].start), parseISO(cycles[i].start)));
  }
  charts.len = new Chart($("#chartLen"), {
    type: "line",
    data: { labels, datasets: [
      { label: "cyclus (dagen)", data: lens, borderColor: "#2b7fff", backgroundColor: "rgba(43,127,255,.2)", tension: .3, fill: true, pointRadius: 5, pointBackgroundColor: "#4d9bff" },
      { label: "gemiddelde", data: lens.map(()=>stats.mean), borderColor: "#00d4ff", borderDash: [5,5], pointRadius: 0 }
    ]},
    options: { plugins: { legend: { labels: { color: CHART_COLORS.ink } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.muted }, grid: { color: CHART_COLORS.grid } },
        y: { ticks: { color: CHART_COLORS.muted }, grid: { color: CHART_COLORS.grid }, suggestedMin: 20, suggestedMax: 35 }
      } }
  });

  const bins = {};
  lens.forEach(l => { bins[l] = (bins[l]||0)+1; });
  const bk = Object.keys(bins).sort((a,b)=>a-b);
  charts.hist = new Chart($("#chartHist"), {
    type: "bar",
    data: { labels: bk, datasets: [{ label: "aantal", data: bk.map(k=>bins[k]), backgroundColor: "#2b7fff", borderColor: "#4d9bff", borderWidth: 1 }] },
    options: { plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "cycluslengte (dagen)", color: CHART_COLORS.muted }, ticks: { color: CHART_COLORS.muted }, grid: { color: CHART_COLORS.grid } },
        y: { ticks: { color: CHART_COLORS.muted, stepSize: 1 }, grid: { color: CHART_COLORS.grid } }
      } }
  });

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
    options: { plugins: { legend: { labels: { color: CHART_COLORS.ink } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.muted, maxTicksLimit: 12 }, grid: { color: CHART_COLORS.grid } },
        y: { ticks: { color: CHART_COLORS.muted, callback: v => v+"%" }, grid: { color: CHART_COLORS.grid }, min: 0, max: 100 }
      } }
  });

  // ovulation timing chart: bar of "days from mucus → next menstruation" per observation
  const ovLabels = [];
  const ovData = [];
  const ovColors = [];
  for (const e of stats.mucusEntries) {
    if (e.gap == null) continue;
    ovLabels.push(fmt(parseISO(e.date)));
    ovData.push(e.gap);
    ovColors.push(e.isOutlier ? "#ffb86b" : "#5af0ff");
  }
  const medLine = ovData.map(()=> stats.lutealMedian);
  charts.ovul = new Chart($("#chartOvul"), {
    type: "bar",
    data: { labels: ovLabels, datasets: [
      { label: "dagen heldere slijm → menstruatie", data: ovData, backgroundColor: ovColors, borderColor: "#00d4ff", borderWidth: 1 },
      { label: "mediaan (robuust)", data: medLine, type: "line", borderColor: "#ffb703", borderDash: [5,5], pointRadius: 0 }
    ]},
    options: { plugins: { legend: { labels: { color: CHART_COLORS.ink } } },
      scales: {
        x: { ticks: { color: CHART_COLORS.muted }, grid: { color: CHART_COLORS.grid } },
        y: { title: { display: true, text: "dagen tot menstruatie", color: CHART_COLORS.muted }, ticks: { color: CHART_COLORS.muted }, grid: { color: CHART_COLORS.grid }, suggestedMin: 0, suggestedMax: 20 }
      } }
  });
}

/* --- doctor tab --- */
function renderCyclesTable() {
  const tb = $("#cyclesTable tbody");
  tb.innerHTML = "";
  const cycles = [...DATA.cycles].sort((a,b)=> a.start.localeCompare(b.start));
  cycles.forEach((c, idx) => {
    const prev = idx > 0 ? daysBetween(parseISO(cycles[idx-1].start), parseISO(c.start)) : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmt(parseISO(c.start))}</td><td>${prev}${prev!=="—"?" d":""}</td><td>${escapeHtml(c.note||"")}</td><td><button class="row-del">✕</button></td>`;
    tr.querySelector(".row-del").addEventListener("click", ()=> {
      DATA.cycles = DATA.cycles.filter(x => x.start !== c.start);
      persist(); render();
    });
    tb.appendChild(tr);
  });
}
function renderMucusTable() {
  const tb = $("#mucusTable tbody");
  tb.innerHTML = "";
  const stats = getStats();
  const byDate = Object.fromEntries(stats.mucusEntries.map(e => [e.date, e]));
  const mucus = [...(DATA.mucus||[])].sort((a,b)=> a.date.localeCompare(b.date));
  mucus.forEach(mItem => {
    const md = parseISO(mItem.date);
    const prevCycle = [...stats.cycles].reverse().find(c => parseISO(c.start) <= md);
    const cd = prevCycle ? daysBetween(parseISO(prevCycle.start), md) + 1 : "—";
    const entry = byDate[mItem.date];
    const flag = entry?.isOutlier ? ` <span style="color:#ffb86b" title="${escapeHtml(entry.reason)}">⚠️ outlier</span>` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${fmt(md)}${flag}</td><td>${cd !== "—" ? "dag "+cd : "—"}</td><td>${escapeHtml(mItem.note||"")}</td><td><button class="row-del">✕</button></td>`;
    tr.querySelector(".row-del").addEventListener("click", ()=> {
      DATA.mucus = DATA.mucus.filter(x => x.date !== mItem.date);
      persist(); render();
    });
    tb.appendChild(tr);
  });
}
function renderDocList() {
  const ul = $("#docList");
  ul.innerHTML = "";
  const items = [...(DATA.doctorEntries||[])].sort((a,b)=> b.date.localeCompare(a.date));
  items.forEach((e, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="meta"><span>${fmt(parseISO(e.date))}</span><span class="tag-pill">${e.type}</span></div><div>${escapeHtml(e.text)}</div>`;
    ul.appendChild(li);
  });
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

$("#addCycleForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = $("#cycleDate").value;
  const note = $("#cycleNote").value;
  if (!date) return;
  if (!DATA.cycles.some(c => c.start === date)) {
    DATA.cycles.push({ start: date, note });
    persist(); render();
  }
  e.target.reset();
  $("#cycleDate").value = toISO(new Date());
});
$("#addMucusForm").addEventListener("submit", e => {
  e.preventDefault();
  const date = $("#mucusDate").value;
  const note = $("#mucusNote").value || "heldere slijm";
  if (!date) return;
  DATA.mucus = DATA.mucus || [];
  if (!DATA.mucus.some(m => m.date === date)) {
    DATA.mucus.push({ date, note });
    persist(); render();
  }
  e.target.reset();
  $("#mucusDate").value = toISO(new Date());
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
  $("#docDate").value = toISO(new Date());
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
  try { DATA = JSON.parse(txt); if (!DATA.mucus) DATA.mucus = []; persist(); render(); }
  catch { alert("ongeldige JSON"); }
});
$("#resetBtn").addEventListener("click", ()=> {
  if (confirm("Reset naar repo data.json? Lokale wijzigingen gaan verloren.")) {
    DATA = structuredClone(repoData);
    if (!DATA.mucus) DATA.mucus = [];
    persist(); render();
  }
});

function renderDataPreview() { $("#dataPreview").textContent = JSON.stringify(DATA, null, 2); }

function render() {
  renderOverview();
  renderCalendar();
  renderCyclesTable();
  renderMucusTable();
  renderDocList();
  renderDataPreview();
  if ($("#tab-charts").classList.contains("active")) renderCharts();
}

(async function boot() {
  await loadInitial();
  const today = toISO(new Date());
  $("#cycleDate").value = today;
  $("#mucusDate").value = today;
  $("#docDate").value = today;
  tryUnlock();
})();
