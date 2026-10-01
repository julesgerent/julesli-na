
lucide.createIcons();

const FIREBASE_SDK_READY = typeof firebase !== "undefined";
let auth = null;
let db = null;
let storage = null;
let placesData = [];
let currentRole = null;

if (!FIREBASE_SDK_READY) {
  console.error("Firebase SDK non chargé.");
} else if (!window.APP_CONFIG || !window.APP_CONFIG.firebase) {
  console.error("Configuration Firebase manquante dans firebase-config.js.");
} else {
  if (!firebase.apps.length) firebase.initializeApp(window.APP_CONFIG.firebase);
  auth = firebase.auth();
  db = firebase.firestore();
  storage = firebase.storage ? firebase.storage() : null;
  auth.setPersistence(firebase.auth.Auth.Persistence.NONE).catch(console.error);
}

document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if(e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['I','i','J','j','C','c'].includes(e.key)) || (e.metaKey && e.altKey && ['I','i','J','j'].includes(e.key)) || (e.ctrlKey && ['U','u'].includes(e.key))) {
    e.preventDefault();
    return false;
  }
});

async function loginWithCode(code) {
  if (!auth || !db) throw new Error("Firebase n'est pas configuré.");
  const cleanCode = String(code || "").trim();
  if (!cleanCode) throw new Error("Code vide.");

  const candidates = [
    { role: "user", email: window.APP_CONFIG.userLoginEmail },
    { role: "admin", email: window.APP_CONFIG.adminLoginEmail }
  ];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const credential = await auth.signInWithEmailAndPassword(candidate.email, cleanCode);
      currentRole = candidate.role;
      await hydratePrivateData();
      return candidate.role;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Code incorrect.");
}

async function hydratePrivateData() {
  const [dailySnap, letterSnap, placesSnap] = await Promise.all([
    db.collection("content").doc("daily-note").get(),
    db.collection("content").doc("letter").get(),
    db.collection("places").orderBy("id", "asc").get()
  ]);

  if (dailySnap.exists) renderDailyNote(dailySnap.data());

  const letterEl = document.getElementById("letter-private-content");
  if (letterSnap.exists && letterEl) {
    const letter = letterSnap.data();
    letterEl.innerHTML = letter.html || '<p class="text-center text-white/50 py-12">Lettre vide.</p>';
  }

  placesData = placesSnap.docs.map(doc => doc.data());
  calculateDays();
  lucide.createIcons();
}

function renderDailyNote(data) {
  const textEl = document.getElementById("daily-note-text");
  const timeEl = document.getElementById("daily-note-time");
  if (!textEl || !timeEl) return;

  textEl.textContent = data?.text || "Aucun mot publié pour le moment.";

  if (data?.updatedAt?.toDate) {
    const d = data.updatedAt.toDate();
    timeEl.textContent = new Intl.DateTimeFormat("fr-FR", {
      day: "2-digit", month: "2-digit", year: "2-digit",
      hour: "2-digit", minute: "2-digit"
    }).format(d).replace(",", " -");
  } else {
    timeEl.textContent = "—";
  }
}

let calendarTrackerInterval = null;
let calendarTrackerLastEventMs = null;
let calendarTrackerFetchedAt = 0;
let calendarTrackerLoading = false;
let calendarTrackerData = null;
let calendarTrackerDetailsOpen = false;
const CALENDAR_TRACKER_CACHE_MS = 5 * 60 * 1000;
const TRACKER_TYPES = ["type-1", "type-2", "type-3", "type-4"];

let trackerInkAnimationFrame = null;
let trackerInkParticles = [];
let trackerInkIsRevealing = false;
let trackerInkResizeTimer = null;

function resetCalendarTracker() {
  if (calendarTrackerInterval) {
    clearInterval(calendarTrackerInterval);
    calendarTrackerInterval = null;
  }
  calendarTrackerLastEventMs = null;
  calendarTrackerFetchedAt = 0;
  calendarTrackerLoading = false;
  calendarTrackerData = null;
  calendarTrackerDetailsOpen = false;

  const valueEl = document.getElementById("calendar-tracker-value");
  const detailEl = document.getElementById("calendar-tracker-detail");
  const typeEl = document.getElementById("calendar-tracker-latest-type");
  const meaningEl = document.getElementById("calendar-tracker-meaning");
  const statsEl = document.getElementById("calendar-tracker-type-stats");
  if (valueEl) valueEl.textContent = "Chargement…";
  if (detailEl) detailEl.textContent = "Chargement…";
  if (typeEl) typeEl.textContent = "-";
  if (meaningEl) meaningEl.textContent = "Texte";
  if (statsEl) statsEl.innerHTML = "";
  stopTrackerInvisibleInk();
  resetTrackerSecretVisual();

  updateTrackerDetailsVisibility();
}

function formatTrackerElapsed(fromMs, nowMs = Date.now()) {
  const totalSeconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const dayText = `${days} jour${days > 1 ? "s" : ""}`;
  return `${dayText}, ${String(hours).padStart(2, "0")} h ${String(minutes).padStart(2, "0")} min ${String(seconds).padStart(2, "0")} s`;
}

function formatTrackerDate(ms, withTime = false) {
  if (!Number.isFinite(Number(ms))) return "Jamais";
  const options = { day: "2-digit", month: "2-digit", year: "numeric" };
  if (withTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
  }
  return new Intl.DateTimeFormat("fr-FR", options).format(new Date(Number(ms)));
}

function renderCalendarTrackerClock() {
  const valueEl = document.getElementById("calendar-tracker-value");
  if (!valueEl || !Number.isFinite(calendarTrackerLastEventMs)) return;
  valueEl.textContent = formatTrackerElapsed(calendarTrackerLastEventMs);
}

function startCalendarTrackerClock(lastEventMs) {
  calendarTrackerLastEventMs = Number(lastEventMs);
  if (calendarTrackerInterval) clearInterval(calendarTrackerInterval);
  renderCalendarTrackerClock();
  calendarTrackerInterval = setInterval(renderCalendarTrackerClock, 1000);
}

function setCalendarTrackerLoading(isLoading) {
  const btn = document.getElementById("calendar-tracker-refresh");
  if (btn) btn.disabled = isLoading;
}

function updateTrackerDetailsVisibility() {
  const panel = document.getElementById("calendar-tracker-more-panel");
  const button = document.getElementById("calendar-tracker-more");
  const label = document.getElementById("calendar-tracker-more-label");
  const icon = document.getElementById("calendar-tracker-more-icon");

  if (panel) panel.classList.toggle("hidden", !calendarTrackerDetailsOpen);
  if (button) button.setAttribute("aria-expanded", calendarTrackerDetailsOpen ? "true" : "false");
  if (label) label.textContent = calendarTrackerDetailsOpen ? "Voir moins" : "Voir plus";
  if (icon) icon.setAttribute("data-lucide", calendarTrackerDetailsOpen ? "chevron-up" : "chevron-down");
  if (window.lucide) lucide.createIcons();
}

function toggleTrackerDetails() {
  calendarTrackerDetailsOpen = !calendarTrackerDetailsOpen;
  updateTrackerDetailsVisibility();
}

function escapeTrackerHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}

function renderTrackerTypeStats(types) {
  const statsEl = document.getElementById("calendar-tracker-type-stats");
  if (!statsEl) return;

  const byType = new Map((Array.isArray(types) ? types : []).map(item => [item.type, item]));
  statsEl.innerHTML = TRACKER_TYPES.map(type => {
    const item = byType.get(type) || {};
    const count = Number.isFinite(Number(item.count)) ? Number(item.count) : 0;
    const dateText = formatTrackerDate(item.lastEventAtMs, false);
    const displayName = escapeTrackerHtml(item.meaning || type || "—");


    return `
      <div class="tracker-type-row">
        <div>
          <span class="tracker-type-name">${displayName}</span>
          <span class="tracker-type-date">Dernière fois : ${dateText}</span>
        </div>
        <span class="tracker-type-count">${count} au total</span>
      </div>`;
  }).join("");
}

function lowercaseFirstLetter(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  return text.charAt(0).toLocaleLowerCase("fr-FR") + text.slice(1);
}

function stopTrackerInvisibleInk() {
  if (trackerInkAnimationFrame) {
    cancelAnimationFrame(trackerInkAnimationFrame);
    trackerInkAnimationFrame = null;
  }
  trackerInkParticles = [];
  trackerInkIsRevealing = false;
}

function setupTrackerInvisibleInk() {
  const wrapper = document.getElementById("calendar-tracker-secret");
  const canvas = document.getElementById("tracker-invisible-ink");
  if (!wrapper || !canvas) return;

  stopTrackerInvisibleInk();
  wrapper.classList.remove("revealed");
  canvas.style.opacity = "1";

  const rect = wrapper.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const area = width * height;
  const particleCount = Math.max(460, Math.min(1150, Math.round(area / 6.2)));

  trackerInkParticles = Array.from({ length: particleCount }, () => {
    const sizeRoll = Math.random();
    const radius = sizeRoll < 0.78
      ? 0.45 + Math.random() * 0.45
      : sizeRoll < 0.97
        ? 0.9 + Math.random() * 0.55
        : 1.45 + Math.random() * 0.55;

    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius,
      baseAlpha: 0.28 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
      speed: 0.55 + Math.random() * 1.4,
      driftX: (Math.random() - 0.5) * 0.72,
      driftY: (Math.random() - 0.5) * 0.58,
      revealVX: 0,
      revealVY: 0,
      revealAlpha: 1
    };
  });

  let lastTime = performance.now();

  function draw(time) {
    const dt = Math.min((time - lastTime) / 1000, 0.04);
    lastTime = time;
    ctx.clearRect(0, 0, width, height);

    let alive = false;

    for (const p of trackerInkParticles) {
      if (trackerInkIsRevealing) {
        p.x += p.revealVX * dt;
        p.y += p.revealVY * dt;
        p.revealVX *= 0.955;
        p.revealVY *= 0.955;
        p.revealAlpha -= dt * 2.9;
        if (p.revealAlpha <= 0) continue;
      }

      alive = true;

      const shimmer = Math.sin(time * 0.0021 * p.speed + p.phase);
      const shimmer2 = Math.sin(time * 0.0047 + p.phase * 1.63);
      const px = p.x + Math.sin(time * 0.00125 * p.speed + p.phase) * p.driftX;
      const py = p.y + Math.cos(time * 0.00108 * p.speed + p.phase) * p.driftY;

      let alpha = p.baseAlpha + shimmer * 0.09 + shimmer2 * 0.035;
      alpha = Math.max(0.12, Math.min(0.88, alpha));
      if (trackerInkIsRevealing) alpha *= Math.max(0, p.revealAlpha);

      const sparkle = shimmer > 0.93 && p.radius > 0.8;
      const tone = sparkle ? 250 : 214 + Math.floor((shimmer2 + 1) * 8);

      ctx.beginPath();
      ctx.arc(px, py, sparkle ? p.radius * 1.18 : p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${tone},${tone},${Math.min(255, tone + 3)},${alpha})`;
      ctx.fill();
    }

    if (trackerInkIsRevealing && !alive) {
      canvas.style.opacity = "0";
      wrapper.classList.add("revealed");
      trackerInkAnimationFrame = null;
      return;
    }

    trackerInkAnimationFrame = requestAnimationFrame(draw);
  }

  if (!canvas.dataset.trackerInkBound) {
    canvas.dataset.trackerInkBound = "1";
    canvas.addEventListener("click", revealTrackerSecret);
  }

  if (!wrapper.dataset.trackerInkKeyboardBound) {
    wrapper.dataset.trackerInkKeyboardBound = "1";
    wrapper.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        revealTrackerSecret();
      }
    });
  }

  trackerInkAnimationFrame = requestAnimationFrame(draw);
}

function revealTrackerSecret(event) {
  const wrapper = document.getElementById("calendar-tracker-secret");
  const canvas = document.getElementById("tracker-invisible-ink");
  if (!wrapper || !canvas || trackerInkIsRevealing || wrapper.classList.contains("revealed")) return;

  trackerInkIsRevealing = true;
  const rect = canvas.getBoundingClientRect();
  const clickX = typeof event?.clientX === "number" ? event.clientX - rect.left : rect.width / 2;
  const clickY = typeof event?.clientY === "number" ? event.clientY - rect.top : rect.height / 2;

  trackerInkParticles.forEach(p => {
    let dx = p.x - clickX;
    let dy = p.y - clickY;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= distance;
    dy /= distance;

    const proximity = Math.max(0, 1 - distance / Math.max(rect.width, rect.height));
    const force = 10 + proximity * 24 + Math.random() * 8;
    p.revealVX = dx * force + (Math.random() - 0.5) * 4;
    p.revealVY = dy * force + (Math.random() - 0.5) * 4;
    p.revealAlpha = 0.88 + Math.random() * 0.12;
  });

  setTimeout(() => wrapper.classList.add("revealed"), 75);
}

function resetTrackerSecretVisual() {
  const wrapper = document.getElementById("calendar-tracker-secret");
  const canvas = document.getElementById("tracker-invisible-ink");
  if (wrapper) wrapper.classList.remove("revealed");
  if (canvas) canvas.style.opacity = "1";
}

function renderCalendarTrackerData(data) {
  const valueEl = document.getElementById("calendar-tracker-value");
  const detailEl = document.getElementById("calendar-tracker-detail");
  const typeEl = document.getElementById("calendar-tracker-latest-type");
  const meaningEl = document.getElementById("calendar-tracker-meaning");

  renderTrackerTypeStats(data?.types);

  if (!data?.configured) {
    if (valueEl) valueEl.textContent = "À configurer";
    if (detailEl) detailEl.textContent = "Calendrier non configuré.";
    if (typeEl) typeEl.textContent = "-";
    if (meaningEl) meaningEl.textContent = "Texte";
    return;
  }

  if (!data?.found || !Number.isFinite(Number(data?.latest?.atMs))) {
    if (calendarTrackerInterval) clearInterval(calendarTrackerInterval);
    calendarTrackerInterval = null;
    calendarTrackerLastEventMs = null;
    if (valueEl) valueEl.textContent = "Aucune activité";
    if (detailEl) detailEl.textContent = "Missing type-1 / type-2/ type-3 / type-4.";
    if (typeEl) typeEl.textContent = "Aucune activité trouvée";
    if (meaningEl) meaningEl.textContent = "Texte";
    return;
  }

  const lastEventMs = Number(data.latest.atMs);
  startCalendarTrackerClock(lastEventMs);

  if (detailEl) detailEl.textContent = `La dernière fois c'était le ${formatTrackerDate(lastEventMs, true)}.`;
  if (typeEl) {
    const latestMeaning = data.latest.meaning || data.latest.type || "—";
    typeEl.textContent = lowercaseFirstLetter(latestMeaning);
  }

  resetTrackerSecretVisual();
  requestAnimationFrame(() => setupTrackerInvisibleInk());
}

async function loadCalendarTracker(force = false) {
  if (!currentRole || calendarTrackerLoading) return;

  const valueEl = document.getElementById("calendar-tracker-value");
  const detailEl = document.getElementById("calendar-tracker-detail");
  const cacheValid = calendarTrackerData && Date.now() - calendarTrackerFetchedAt < CALENDAR_TRACKER_CACHE_MS;

  if (!force && cacheValid) {
    renderCalendarTrackerData(calendarTrackerData);
    return;
  }

  calendarTrackerLoading = true;
  if (calendarTrackerInterval) {
    clearInterval(calendarTrackerInterval);
    calendarTrackerInterval = null;
  }
  setCalendarTrackerLoading(true);
  if (valueEl) valueEl.textContent = "Chargement…";
  if (detailEl) detailEl.textContent = "Chargement…";

  try {
    const functions = firebase.app().functions("europe-west9");
    const getCalendarTracker = functions.httpsCallable("getCalendarTracker");
    const result = await getCalendarTracker();
    const data = result.data || {};

    calendarTrackerData = data;
    calendarTrackerFetchedAt = Date.now();
    renderCalendarTrackerData(data);
  } catch (error) {
    console.error("Erreur tracker calendrier :", error);
    if (valueEl) valueEl.textContent = "Indisponible";
    if (detailEl) {
      let message = "Impossible de lire le calendrier pour le moment.";
      if (error?.code === "functions/failed-precondition") message = error.message || "Tracker non configuré depuis espace admin.";
      if (error?.code === "functions/unauthenticated") message = "Expired session. Reconnect.";
      detailEl.textContent = message;
    }
  } finally {
    calendarTrackerLoading = false;
    setCalendarTrackerLoading(false);
    lucide.createIcons();
  }
}

window.addEventListener("resize", () => {
  clearTimeout(trackerInkResizeTimer);
  trackerInkResizeTimer = setTimeout(() => {
    const wrapper = document.getElementById("calendar-tracker-secret");
    if (wrapper && !wrapper.classList.contains("revealed") && calendarTrackerData?.found) {
      setupTrackerInvisibleInk();
    }
  }, 140);
});

function getTrackerMeaningsFromAdmin() {
  const meanings = {};
  for (const type of TRACKER_TYPES) {
    const input = document.getElementById(`admin-tracker-meaning-${type}`);
    meanings[type] = String(input?.value || "").trim();
  }
  return meanings;
}

async function saveCalendarTrackerConfig() {
  if (currentRole !== "admin") return;

  const urlInput = document.getElementById("admin-calendar-public-url");
  const btn = document.getElementById("btn-save-calendar-tracker");
  const publicUrl = String(urlInput?.value || "").trim();
  const meanings = getTrackerMeaningsFromAdmin();

  if (btn) btn.disabled = true;
  setAdminStatus("calendar-tracker-admin-status", "Vérification puis enregistrement…", "neutral");

  try {
    const functions = firebase.app().functions("europe-west9");
    const saveConfig = functions.httpsCallable("saveCalendarTrackerConfig");
    const result = await saveConfig({ publicUrl, meanings });
    if (urlInput) {
      urlInput.value = "";
      if (result.data?.hasPublicUrl) urlInput.placeholder = "Lien déjà enregistré";
    }
    resetCalendarTracker();
    setAdminStatus("calendar-tracker-admin-status", "Configuration enregistrée.", "success");
  } catch (error) {
    console.error("Erreur configuration tracker :", error);
    setAdminStatus("calendar-tracker-admin-status", error?.message || "Impossible d'enregistrer la configuration.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadCalendarTrackerAdminConfig() {
  if (currentRole !== "admin") return;

  const btn = document.getElementById("btn-load-calendar-tracker");
  if (btn) btn.disabled = true;
  setAdminStatus("calendar-tracker-admin-status", "Chargement de la configuration…", "neutral");

  try {
    const functions = firebase.app().functions("europe-west9");
    const getConfig = functions.httpsCallable("getCalendarTrackerConfig");
    const result = await getConfig();
    const data = result.data || {};

    const urlInput = document.getElementById("admin-calendar-public-url");
    if (urlInput) {
      urlInput.value = "";
      urlInput.placeholder = data.hasPublicUrl
        ? "Lien déjà enregistré"
        : "Nouveau lien";
    }

    for (const type of TRACKER_TYPES) {
      const input = document.getElementById(`admin-tracker-meaning-${type}`);
      if (input) input.value = data.meanings?.[type] || "Texte";
    }

    setAdminStatus(
      "calendar-tracker-admin-status",
      data.configured ? "Configuration chargée." : "Aucun lien de calendrier enregistré pour le moment.",
      data.configured ? "success" : "neutral"
    );
  } catch (error) {
    console.error("Erreur chargement config tracker :", error);
    setAdminStatus("calendar-tracker-admin-status", error?.message || "Impossible de charger la configuration.", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function lockSite() {
  try {
    if (auth) await auth.signOut();
  } finally {
    currentRole = null;
    placesData = [];
    resetCalendarTracker();
    const input = document.getElementById("password-input");
    if (input) input.value = "";
    navigate("locked");
  }
}

const states = ['locked', 'menu', 'tracker', 'map', 'letter', 'admin'];
    
    function navigate(targetState) {
      if (targetState === "admin" && currentRole !== "admin") targetState = "locked";
      states.forEach(state => {
        const el = document.getElementById(state + '-state');
        if (el) {
          if (state === targetState) {
            el.classList.remove('hidden');
            el.classList.add('flex');
            setTimeout(() => {
              el.style.opacity = '1';
              el.style.transform = 'scale(1)';
            }, 50);

            if (targetState === 'map') {
              initMap();
            }
            if (targetState === 'tracker') {
              loadCalendarTracker(false);
            }
          } else {
            el.style.opacity = '0';
            el.style.transform = 'scale(0.95)';
            setTimeout(() => {
              el.classList.add('hidden');
              el.classList.remove('flex');
            }, 400);
          }
        }
      });
      
      closePlaceDetail();
    }

    // logique de déverouillage

    async function checkPassword() {
      const input = document.getElementById('password-input');
      const btn = document.querySelector('#login-card button');
      const loadingText = document.getElementById('loading-text');
      if (!input || input.dataset.loading === "1") return;

      input.dataset.loading = "1";
      if (btn) btn.disabled = true;
      if (loadingText) loadingText.classList.remove('hidden');

      try {
        const role = await loginWithCode(input.value);
        navigate(role === "admin" ? "admin" : "menu");
        enableNotifications();
        if (role === "admin") {
          populateAdminPlaces();
          resetAdminPlaceForm();
          const daily = document.getElementById("daily-note-text");
          const adminDaily = document.getElementById("admin-daily-note");
          if (daily && adminDaily && !daily.textContent.includes("Chargement")) {
            adminDaily.value = daily.textContent === "Aucun mot publié pour le moment." ? "" : daily.textContent;
          }
        }
      } catch (error) {
        console.warn("Connexion refusée :", error?.code || error);
        triggerErrorAnimation();
      } finally {
        input.dataset.loading = "0";
        if (btn) btn.disabled = false;
        if (loadingText) loadingText.classList.add('hidden');
      }
    }

    function triggerErrorAnimation() {
      const card = document.getElementById('login-card');
      const input = document.getElementById('password-input');
      card.classList.add('translate-y-1');
      setTimeout(() => card.classList.remove('translate-y-1'), 100);
      input.classList.add('border-rose-500/50', 'bg-rose-950/20');
      input.value = '';
      input.placeholder = 'Code erroné...';
      setTimeout(() => {
        input.classList.remove('border-rose-500/50', 'bg-rose-950/20');
        input.placeholder = 'Code secret...';
      }, 2000);
    }
    
    let map = null;
    let darkLayer = null;
    let satelliteLayer = null;
    let isSatellite = false;

    function initMap() {
      if (map !== null) {
        setTimeout(() => map.invalidateSize(), 100);
        return;
      }
      
      map = L.map('leaflet-map', { zoomControl: false }).setView([44.011, 4.872], 10);

      darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_3swe_1_4e793a44a5becab08102309c', {
        attribution: '&copy; OpenStreetMap',
        subdomains: 'abcd',
        maxZoom: 19
      });

      satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri',
        maxZoom: 19
      });

      darkLayer.addTo(map);

      // marqueur depuis données
      placesData.forEach(place => {
        // custom marqueur violet
        const customIcon = L.divIcon({
          className: 'custom-div-icon',
          html: `<div class="w-4 h-4 bg-purple-500 rounded-full border-2 border-white shadow-[0_0_10px_rgba(168,85,247,0.8)] animate-pulse"></div>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        });

        const marker = L.marker([place.lat, place.lng], {icon: customIcon}).addTo(map);
        
        const popupHTML = place.events.length > 1 ? `
          <div class="text-center w-44 p-1">
            <h4 class="font-semibold text-sm mb-1 font-sans">${place.title}</h4>
            <span class="text-[10px] text-purple-300 block mb-3">${place.events.length} souvenirs</span>
            <button onclick="openPlaceDetail(${place.id})" class="px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-semibold w-full transition-all text-white shadow-lg border border-purple-400/30">Voir les souvenirs</button>
          </div>
        ` : `
          <div class="text-center w-40 p-1">
            <h4 class="font-semibold text-sm mb-3 font-sans">${place.title}</h4>
            <button onclick="openPlaceDetail(${place.id})" class="px-3 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl text-xs font-semibold w-full transition-all text-white shadow-lg border border-purple-400/30">Voir ce souvenir</button>
          </div>
        `;
        
        marker.bindPopup(popupHTML);
      });

      setTimeout(() => map.invalidateSize(), 100);
    }

    function toggleMapStyle() {
      const btnText = document.getElementById('map-style-text');
      if (isSatellite) {
        map.removeLayer(satelliteLayer);
        darkLayer.addTo(map);
        btnText.innerText = "Satellite";
        isSatellite = false;
      } else {
        map.removeLayer(darkLayer);
        satelliteLayer.addTo(map);
        btnText.innerText = "Plan";
        isSatellite = true;
      }
    }

    
      function openPlaceDetail(id) {
      const place = placesData.find(p => p.id === id);
      if (!place) return;

      if (place.events.length === 1) {
        const event = place.events[0];
        document.getElementById('detail-title').innerText = event.title;
        document.getElementById('detail-date').innerText = event.date;
        
        let contentHTML = `<p>${event.text}</p>`;

        if (event.photos && event.photos.length > 0) {
          if (event.photos.length === 1) {
            const mediaSrc = event.photos[0];
            const isVideo = /\.(mp4|webm|mov|ogg)$/i.test(mediaSrc);

            if (isVideo) {
              contentHTML += `
                <div class="my-6 rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 relative">
                  <video src="${mediaSrc}" controls class="w-full max-h-60 rounded-2xl object-cover"></video>
                </div>
              `;
            } else {
              contentHTML += `
                <div class="my-6 rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 relative group cursor-pointer" onclick="openLightbox(this)">
                  <img src="${mediaSrc}" class="w-full object-cover max-h-52 rounded-2xl" alt="${event.title}">
                </div>
              `;
            }
          } else {
            contentHTML += `<div class="my-6 grid grid-cols-${Math.min(event.photos.length, 3)} gap-3">`;
            event.photos.forEach(mediaSrc => {
              const isVideo = /\.(mp4|webm|mov|ogg)$/i.test(mediaSrc);
              if (isVideo) {
                contentHTML += `
                  <div class="rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 flex flex-col">
                    <video src="${mediaSrc}" controls class="w-full object-cover flex-grow aspect-square rounded-xl"></video>
                  </div>
                `;
              } else {
                contentHTML += `
                  <div class="rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 flex flex-col cursor-pointer" onclick="openLightbox(this)">
                    <img src="${mediaSrc}" class="w-full object-cover flex-grow aspect-square rounded-xl" alt="Média lieu">
                  </div>
                `;
              }
            });
            contentHTML += `</div>`;
          }
        }

        document.getElementById('detail-content').innerHTML = contentHTML;
      } 
      else {
        document.getElementById('detail-title').innerText = place.title;
        document.getElementById('detail-date').innerText = "Nos moments ici";
        
        let contentHTML = '';

        place.events.forEach((event, index) => {
          contentHTML += `
            <div class="${index > 0 ? 'mt-10 pt-8 border-t border-purple-500/20' : ''}">
              <div class="text-[10px] tracking-widest text-white/40 mb-2 uppercase font-medium">${event.date}</div>
              <h4 class="text-lg font-semibold text-white mb-3">${event.title}</h4>
              <p class="mb-4">${event.text}</p>
          `;

          if (event.photos && event.photos.length > 0) {
            if (event.photos.length === 1) {
              const mediaSrc = event.photos[0];
              const isVideo = /\.(mp4|webm|mov|ogg)$/i.test(mediaSrc);

              if (isVideo) {
                contentHTML += `
                  <div class="my-4 rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 relative">
                    <video src="${mediaSrc}" controls class="w-full max-h-60 rounded-2xl object-cover"></video>
                  </div>
                `;
              } else {
                contentHTML += `
                  <div class="my-4 rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 relative group cursor-pointer" onclick="openLightbox(this)">
                    <img src="${mediaSrc}" class="w-full object-cover max-h-52 rounded-2xl" alt="${event.title}">
                  </div>
                `;
              }
            } else {
              contentHTML += `<div class="my-4 grid grid-cols-${Math.min(event.photos.length, 3)} gap-3">`;
              event.photos.forEach(mediaSrc => {
                const isVideo = /\.(mp4|webm|mov|ogg)$/i.test(mediaSrc);
                if (isVideo) {
                  contentHTML += `
                    <div class="rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 flex flex-col">
                      <video src="${mediaSrc}" controls class="w-full object-cover flex-grow aspect-square rounded-xl"></video>
                    </div>
                  `;
                } else {
                  contentHTML += `
                    <div class="rounded-2xl overflow-hidden border border-purple-500/20 backdrop-blur-md bg-white/5 flex flex-col cursor-pointer" onclick="openLightbox(this)">
                      <img src="${mediaSrc}" class="w-full object-cover flex-grow aspect-square rounded-xl" alt="Média lieu">
                    </div>
                  `;
                }
              });
              contentHTML += `</div>`;
            }
          }

          contentHTML += `</div>`;
        });

        document.getElementById('detail-content').innerHTML = contentHTML;
      }

      const detailView = document.getElementById('place-detail-state');
      const detailCard = detailView.querySelector('.liquid-glass-glow');

      detailView.classList.remove('hidden');
      detailView.scrollTop = 0;
      detailCard.classList.remove('memory-enter');
      void detailCard.offsetWidth;
      detailCard.classList.add('memory-enter');

      requestAnimationFrame(() => {
        detailView.style.opacity = '1';
      });
    }

    function handlePlaceDetailBackdrop(event) {
      if (event.target === event.currentTarget) {
        closePlaceDetail();
      }
    }

    function closePlaceDetail() {
      const detailView = document.getElementById('place-detail-state');
      const detailCard = detailView.querySelector('.liquid-glass-glow');

      detailView.style.opacity = '0';
      detailCard.classList.remove('memory-enter');

      setTimeout(() => {
        detailView.classList.add('hidden');
      }, 180);
    }



    function setAdminStatus(id, message, type = "neutral") {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = message;
      el.classList.remove("hidden", "is-success", "is-error");
      if (type === "success") el.classList.add("is-success");
      if (type === "error") el.classList.add("is-error");
    }

    async function saveDailyNote() {
      if (currentRole !== "admin") return;
      const field = document.getElementById("admin-daily-note");
      const btn = document.getElementById("btn-save-daily-note");
      const text = field?.value.trim();

      if (!text) {
        setAdminStatus("daily-note-status", "Écris un mot avant de publier.", "error");
        return;
      }

      btn.disabled = true;
      try {
        await db.collection("content").doc("daily-note").set({
          text,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const snap = await db.collection("content").doc("daily-note").get();
        renderDailyNote(snap.data());
        setAdminStatus("daily-note-status", "Mot du jour publié.", "success");
      } catch (error) {
        console.error(error);
        setAdminStatus("daily-note-status", "Impossible de publier le mot.", "error");
      } finally {
        btn.disabled = false;
      }
    }

    const ORIGINAL_PLACE_MAX_ID = 15;
    const ADMIN_EDIT_WINDOW_MS = 15 * 60 * 1000;
    const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024;
    let adminEventIndex = 0;
    const pendingStorageDeletes = new Set();

    function createAdminEventId() {
      if (window.crypto?.randomUUID) return window.crypto.randomUUID();
      return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    function valueToMillis(value) {
      if (!value) return null;
      if (typeof value === "number") return value;
      if (typeof value?.toMillis === "function") return value.toMillis();
      if (typeof value?.toDate === "function") return value.toDate().getTime();
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    function isAdminManagedPlace(place) {
      return Boolean(place && (place.adminCreated === true || Number(place.id) > ORIGINAL_PLACE_MAX_ID));
    }

    function isInsideEditWindow(createdAt) {
      const createdAtMs = valueToMillis(createdAt);
      return Number.isFinite(createdAtMs) && (Date.now() - createdAtMs) <= ADMIN_EDIT_WINDOW_MS;
    }

    function sanitizeFileBaseName(value) {
      return String(value || "")
        .trim()
        .replace(/\.(jpe?g|png|heic|heif)$/i, "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, "")
        .slice(0, 80);
    }

    function populateAdminPlaces() {
      const select = document.getElementById("admin-place-select");
      if (!select) return;

      const currentValue = select.value;
      select.innerHTML = '<option value="new">Ajouter un nouveau lieu</option>';

      placesData.forEach(place => {
        const option = document.createElement("option");
        option.value = String(place.id);
        option.textContent = place.title || `Lieu ${place.id}`;
        select.appendChild(option);
      });

      if ([...select.options].some(option => option.value === currentValue)) {
        select.value = currentValue;
      }
    }

    function resetAdminPlaceForm() {
      pendingStorageDeletes.clear();
      const select = document.getElementById("admin-place-select");
      if (select) select.value = "new";
      handleAdminPlaceSelection();
    }

    function setPlaceLockInfo(message) {
      const info = document.getElementById("admin-place-lock-info");
      if (!info) return;
      if (!message) {
        info.textContent = "";
        info.classList.add("hidden");
        return;
      }
      info.textContent = message;
      info.classList.remove("hidden");
    }

    function handleAdminPlaceSelection() {
      const select = document.getElementById("admin-place-select");
      const latInput = document.getElementById("admin-place-lat");
      const lngInput = document.getElementById("admin-place-lng");
      const titleInput = document.getElementById("admin-place-title");
      const eventsList = document.getElementById("admin-events-list");
      const deletePlaceBtn = document.getElementById("btn-delete-place");
      if (!select || !latInput || !lngInput || !titleInput || !eventsList) return;

      pendingStorageDeletes.clear();
      eventsList.innerHTML = "";
      adminEventIndex = 0;
      setPlaceLockInfo("");
      if (deletePlaceBtn) deletePlaceBtn.classList.add("hidden");

      if (select.value === "new") {
        latInput.value = "";
        lngInput.value = "";
        titleInput.value = "";
        latInput.disabled = false;
        lngInput.disabled = false;
        titleInput.disabled = false;
        addAdminEvent();
        lucide.createIcons();
        return;
      }

      const placeId = Number(select.value);
      const place = placesData.find(item => Number(item.id) === placeId);
      if (!place) return;

      latInput.value = place.lat ?? "";
      lngInput.value = place.lng ?? "";
      titleInput.value = place.title ?? "";

      const managed = isAdminManagedPlace(place);
      const placeEditable = managed && isInsideEditWindow(place.createdAt);

      latInput.disabled = !placeEditable;
      lngInput.disabled = !placeEditable;
      titleInput.disabled = !placeEditable;

      if (!managed) {
        setPlaceLockInfo("Lieu protégé.");
      } else if (placeEditable) {
        const remainingMs = Math.max(0, ADMIN_EDIT_WINDOW_MS - (Date.now() - valueToMillis(place.createdAt)));
        const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
        setPlaceLockInfo(`Modifications possibles encore environ ${remainingMinutes} min.`);
      } else {
        setPlaceLockInfo("Délai de 15 minutes passé.");
      }

      if (managed && deletePlaceBtn) deletePlaceBtn.classList.remove("hidden");

      (place.events || []).forEach(eventData => {
        addAdminEvent(eventData, { placeId, persisted: true });
      });

      lucide.createIcons();
    }

    function toggleAdminAccordion(headerElement) {
      const accordion = headerElement.closest(".admin-event-accordion");
      if (accordion) accordion.classList.toggle("open");
    }

    function buildPhotoUploadUI(existingPhotos, initialBaseName = "") {
      const existingCount = Array.isArray(existingPhotos) ? existingPhotos.length : 0;
      const remaining = Math.max(0, 3 - existingCount);
      const existingMessage = existingCount
        ? `<p class="admin-photo-existing">${existingCount} photo${existingCount > 1 ? "s" : ""} déjà enregistrée${existingCount > 1 ? "s" : ""}.</p>`
        : "";

      if (remaining === 0) {
        return `${existingMessage}<p class="admin-photo-existing">Maximum de 3 photos atteint.</p>`;
      }

      let rows = "";
      for (let i = 1; i <= remaining; i++) {
        rows += `
          <div class="photo-upload-row ${i > 1 ? "hidden" : ""}" data-photo-slot="${i}">
            <span class="photo-slot-label">Photo ${existingCount + i}</span>
            <input class="file-input hidden" type="file"
              accept="image/jpeg,image/png,image/heic,image/heif,.jpg,.jpeg,.png,.heic,.heif"
              onchange="handleFileSelect(this)">
            <button class="btn-upload-photo" type="button" onclick="this.previousElementSibling.click()">
              <i class="w-4 h-4" data-lucide="image-plus"></i>
              <span>Choisir</span>
            </button>
            <span class="selected-photo-name">Aucune photo</span>
          </div>`;
      }

      return `
        ${existingMessage}
        <label class="admin-field photo-base-field">
          <span>Nom du fichier</span>
          <input class="admin-input photo-base-name" type="text" maxlength="80" placeholder="titre-exemple" value="${sanitizeFileBaseName(initialBaseName)}">
          <small>1 photo : titre-exemple.jpeg · plusieurs : titre-exemple-1.jpeg, titre-exemple-2.jpeg…</small>
        </label>
        <div class="photo-upload-rows">${rows}</div>`;
    }

    function addAdminEvent(initial = {}, context = {}) {
      const list = document.getElementById("admin-events-list");
      if (!list) return;

      const selectedPlaceId = Number(document.getElementById("admin-place-select")?.value);
      const placeId = Number.isFinite(context.placeId) ? context.placeId : (Number.isFinite(selectedPlaceId) ? selectedPlaceId : null);
      const persisted = context.persisted === true;
      const index = ++adminEventIndex;
      const createdAtMs = valueToMillis(initial.createdAt);
      const protectedOriginal = persisted && Number(placeId) <= ORIGINAL_PLACE_MAX_ID && initial.adminCreated !== true;
      const editable = !persisted || (!protectedOriginal && isInsideEditWindow(createdAtMs));
      const deletable = !protectedOriginal;

      const block = document.createElement("div");
      block.className = "admin-event-accordion open";
      block.dataset.eventIndex = String(index);
      block.dataset.persisted = persisted ? "1" : "0";
      block.dataset.editable = editable ? "1" : "0";
      block._initialEvent = {
        ...initial,
        photos: Array.isArray(initial.photos) ? [...initial.photos] : [],
        photoPaths: Array.isArray(initial.photoPaths) ? [...initial.photoPaths] : []
      };

      block.innerHTML = `
        <div class="admin-event-header">
          <strong class="admin-event-title"></strong>
          <div class="admin-event-header-actions">
            ${deletable ? '<button type="button" class="admin-remove-event">Supprimer</button>' : ''}
            <i data-lucide="chevron-down" class="w-5 h-5 text-white/50"></i>
          </div>
        </div>
        <div class="admin-event-body">
          ${persisted && !editable ? `<p class="admin-event-lock-message">${protectedOriginal ? "Souvenir protégé." : "Délai de modification dépassé."}</p>` : ""}
          <label class="admin-field"><span>Date</span>
            <input type="text" class="admin-input event-date" placeholder="Ex. 23 Septembre 2026" ${editable ? "" : "disabled"}>
          </label>
          <label class="admin-field"><span>Titre</span>
            <input type="text" class="admin-input event-title" placeholder="Titre du souvenir" ${editable ? "" : "disabled"}>
          </label>
          <label class="admin-field"><span>Texte</span>
            <textarea class="admin-input admin-textarea event-text" placeholder="Texte du souvenir" ${editable ? "" : "disabled"}></textarea>
          </label>
          <div class="admin-field photo-upload-container">
            <span>Photos (3 maximum)</span>
            ${editable ? buildPhotoUploadUI(block._initialEvent.photos, initial.photoBaseName || "") : `<p class="admin-photo-existing">${block._initialEvent.photos.length} photo${block._initialEvent.photos.length > 1 ? "s" : ""} enregistrée${block._initialEvent.photos.length > 1 ? "s" : ""}.</p>`}
          </div>
        </div>`;

      const header = block.querySelector(".admin-event-header");
      const headerTitle = block.querySelector(".admin-event-title");
      const dateInput = block.querySelector(".event-date");
      const titleInput = block.querySelector(".event-title");
      const textInput = block.querySelector(".event-text");

      headerTitle.textContent = initial.title || `Nouveau souvenir ${index}`;
      dateInput.value = initial.date || "";
      titleInput.value = initial.title || "";
      textInput.value = initial.text || "";

      header.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        toggleAdminAccordion(header);
      });

      if (editable) {
        titleInput.addEventListener("input", () => {
          headerTitle.textContent = titleInput.value.trim() || "Nouveau souvenir";
        });
      }

      const removeButton = block.querySelector(".admin-remove-event");
      if (removeButton) {
        removeButton.addEventListener("click", event => {
          event.stopPropagation();
          if (persisted && !window.confirm("Supprimer ce souvenir ?")) return;
          (block._initialEvent.photoPaths || []).forEach(path => path && pendingStorageDeletes.add(path));
          block.remove();
        });
      }

      list.appendChild(block);
      lucide.createIcons();
    }

    async function handleFileSelect(inputElement) {
      const file = inputElement.files?.[0];
      if (!file) return;

      const row = inputElement.closest(".photo-upload-row");
      const label = row?.querySelector(".selected-photo-name");
      const button = row?.querySelector(".btn-upload-photo");

      try {
        if (file.size > MAX_SOURCE_IMAGE_BYTES) {
          throw new Error("La photo dépasse 30 Mo.");
        }

        if (button) button.disabled = true;
        if (label) label.textContent = "Conversion…";

        inputElement.processedBlob = await processImageToJpeg(file);

        if (label) label.textContent = file.name;
        if (button) {
          button.innerHTML = '<i class="w-4 h-4" data-lucide="check"></i><span>Prête</span>';
        }

        const rows = [...row.parentElement.querySelectorAll(".photo-upload-row")];
        const currentIndex = rows.indexOf(row);
        if (currentIndex >= 0 && rows[currentIndex + 1]) {
          rows[currentIndex + 1].classList.remove("hidden");
        }
        lucide.createIcons();
      } catch (error) {
        console.error("Erreur image :", error);
        inputElement.value = "";
        inputElement.processedBlob = null;
        if (label) label.textContent = error.message || "Photo incompatible";
        setAdminStatus("place-status", error.message || "Impossible de traiter cette photo.", "error");
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function blobToJpeg(blob, quality = 0.88, maxDimension = 2800) {
      return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();

        image.onload = () => {
          try {
            const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
            const width = Math.max(1, Math.round(image.naturalWidth * ratio));
            const height = Math.max(1, Math.round(image.naturalHeight * ratio));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);
            canvas.toBlob(result => {
              URL.revokeObjectURL(objectUrl);
              if (!result) return reject(new Error("La conversion JPEG a échoué."));
              resolve(result);
            }, "image/jpeg", quality);
          } catch (error) {
            URL.revokeObjectURL(objectUrl);
            reject(error);
          }
        };

        image.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error("Le navigateur n'arrive pas à lire cette image."));
        };

        image.src = objectUrl;
      });
    }

    async function processImageToJpeg(file) {
      const lowerName = String(file.name || "").toLowerCase();
      const isJpeg = /\.jpe?g$/.test(lowerName) || file.type === "image/jpeg";
      const isPng = /\.png$/.test(lowerName) || file.type === "image/png";
      const looksHeic = /\.(heic|heif)$/.test(lowerName) || /image\/hei[cf]/i.test(file.type || "");

      if (!isJpeg && !isPng && !looksHeic) {
        throw new Error("Formats acceptés : JPG/JPEG, PNG, HEIC et HEIF.");
      }

      if (isJpeg) return file;

      if (looksHeic) {
        if (!window.HeicTo) {
          throw new Error("Le convertisseur HEIC n'est pas chargé.");
        }
        let converted;
        try {
          converted = await window.HeicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
        } catch (error) {
          console.error("Conversion HEIC/HEIF impossible :", error);
          throw new Error("Impossible de convertir cette photo HEIC/HEIF.");
        }
        return blobToJpeg(converted, 0.88, 2800);
      }

      return blobToJpeg(file, 0.88, 2800);
    }

    async function uploadEventPhotos(eventBlock, placeId, eventId, uploadedPaths) {
      const initial = eventBlock._initialEvent || {};
      const existingPhotos = Array.isArray(initial.photos) ? [...initial.photos] : [];
      const existingPhotoPaths = Array.isArray(initial.photoPaths) ? [...initial.photoPaths] : [];
      const fileInputs = [...eventBlock.querySelectorAll(".file-input")].filter(input => input.processedBlob);

      if (fileInputs.length === 0) {
        return {
          photos: existingPhotos,
          photoPaths: existingPhotoPaths,
          photoBaseName: initial.photoBaseName || ""
        };
      }

      if (!storage) throw new Error("Firebase Storage n'est pas disponible.");
      if (existingPhotos.length + fileInputs.length > 3) throw new Error("3 photos maximum par souvenir.");

      const baseInput = eventBlock.querySelector(".photo-base-name");
      const baseName = sanitizeFileBaseName(baseInput?.value);
      if (!baseName) throw new Error("Nom fichier : titre-exemple.");

      const photos = [...existingPhotos];
      const photoPaths = [...existingPhotoPaths];
      const totalAfterUpload = existingPhotos.length + fileInputs.length;

      for (let i = 0; i < fileInputs.length; i++) {
        const absoluteIndex = existingPhotos.length + i;
        let fileName;
        if (existingPhotos.length === 0 && totalAfterUpload === 1) {
          fileName = `${baseName}.jpeg`;
        } else {
          fileName = `${baseName}-${absoluteIndex + 1}.jpeg`;
        }

        const storagePath = `places/place-${placeId}/${eventId}/${fileName}`;
        const ref = storage.ref(storagePath);
        await ref.put(fileInputs[i].processedBlob, { contentType: "image/jpeg" });
        uploadedPaths.push(storagePath);
        const downloadUrl = await ref.getDownloadURL();
        photos.push(downloadUrl);
        photoPaths.push(storagePath);
      }

      return { photos, photoPaths, photoBaseName: baseName };
    }

    function adminEventHasAnyContent(block) {
      const date = block.querySelector(".event-date")?.value.trim() || "";
      const title = block.querySelector(".event-title")?.value.trim() || "";
      const text = block.querySelector(".event-text")?.value.trim() || "";
      const existingPhotos = block._initialEvent?.photos?.length || 0;
      const newPhotos = [...block.querySelectorAll(".file-input")].some(input => input.processedBlob);
      return Boolean(date || title || text || existingPhotos || newPhotos);
    }

    async function collectAdminEventsForSave(placeId, saveTimeMs, uploadedPaths) {
      const blocks = [...document.querySelectorAll("#admin-events-list .admin-event-accordion")];
      const events = [];

      for (const block of blocks) {
        const initial = block._initialEvent || {};
        const persisted = block.dataset.persisted === "1";
        const editable = block.dataset.editable === "1";

        if (persisted && !editable) {
          events.push({ ...initial, photos: [...(initial.photos || [])], photoPaths: [...(initial.photoPaths || [])] });
          continue;
        }

        if (!adminEventHasAnyContent(block)) continue;

        const date = block.querySelector(".event-date")?.value.trim() || "";
        const title = block.querySelector(".event-title")?.value.trim() || "";
        const text = block.querySelector(".event-text")?.value.trim() || "";

        if (!date || !title || !text) {
          throw new Error("Chaque souvenir doit avoir une date, un titre et un texte.");
        }

        const eventId = initial.id || createAdminEventId();
        const uploaded = await uploadEventPhotos(block, placeId, eventId, uploadedPaths);

        events.push({
          ...initial,
          id: eventId,
          date,
          title,
          text,
          photos: uploaded.photos,
          photoPaths: uploaded.photoPaths,
          photoBaseName: uploaded.photoBaseName,
          adminCreated: persisted ? (initial.adminCreated === true) : true,
          createdAt: persisted && initial.createdAt ? initial.createdAt : saveTimeMs
        });
      }

      return events;
    }

    async function getNextPlaceId() {
      const lastSnap = await db.collection("places").orderBy("id", "desc").limit(1).get();
      return lastSnap.empty ? 1 : Number(lastSnap.docs[0].data().id) + 1;
    }

    async function deleteStoragePaths(paths) {
      if (!storage) return false;
      let allDeleted = true;
      for (const path of [...new Set(paths.filter(Boolean))]) {
        try {
          await storage.ref(path).delete();
        } catch (error) {
          if (error?.code !== "storage/object-not-found") {
            allDeleted = false;
            console.warn("Impossible de supprimer le fichier Storage :", path, error);
          }
        }
      }
      return allDeleted;
    }

    function refreshMapAfterPlacesChange() {
      if (!map) return;
      map.remove();
      map = null;
      darkLayer = null;
      satelliteLayer = null;
      isSatellite = false;
    }

    async function savePlaceData() {
      if (currentRole !== "admin") return;

      const select = document.getElementById("admin-place-select");
      const latInput = document.getElementById("admin-place-lat");
      const lngInput = document.getElementById("admin-place-lng");
      const titleInput = document.getElementById("admin-place-title");
      const btn = document.getElementById("btn-save-place");
      if (!select || !latInput || !lngInput || !titleInput || !btn) return;

      const isNewPlace = select.value === "new";
      const existingPlace = isNewPlace ? null : placesData.find(place => Number(place.id) === Number(select.value));
      if (!isNewPlace && !existingPlace) {
        setAdminStatus("place-status", "Lieu introuvable.", "error");
        return;
      }

      const managed = existingPlace ? isAdminManagedPlace(existingPlace) : true;
      const placeEditable = isNewPlace || (managed && isInsideEditWindow(existingPlace?.createdAt));
      const lat = placeEditable ? Number(latInput.value) : Number(existingPlace.lat);
      const lng = placeEditable ? Number(lngInput.value) : Number(existingPlace.lng);
      const title = placeEditable ? titleInput.value.trim() : String(existingPlace.title || "").trim();

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !title) {
        setAdminStatus("place-status", "Latitude, longitude et titre du lieu sont obligatoires.", "error");
        return;
      }

      btn.disabled = true;
      setAdminStatus("place-status", "Traitement et enregistrement en cours…", "neutral");
      const uploadedPaths = [];

      try {
        const targetId = isNewPlace ? await getNextPlaceId() : Number(existingPlace.id);
        const saveTimeMs = Date.now();
        const events = await collectAdminEventsForSave(targetId, saveTimeMs, uploadedPaths);

        if (isNewPlace && events.length === 0) {
          throw new Error("Ne peut pas ajouter de lieu sans au moins un souvenir.");
        }

        const functions = firebase.app().functions("europe-west9");
        const saveAdminPlace = functions.httpsCallable("saveAdminPlace");
        const result = await saveAdminPlace({
          placeId: targetId,
          isNewPlace,
          lat,
          lng,
          title,
          events
        });

        pendingStorageDeletes.clear();
        await hydratePrivateData();
        populateAdminPlaces();
        select.value = String(result.data?.placeId || targetId);
        handleAdminPlaceSelection();
        refreshMapAfterPlacesChange();

        const cleanupOk = result.data?.cleanupOk !== false;
        setAdminStatus(
          "place-status",
          cleanupOk ? "Modifications enregistrées." : "Modifications enregistrées, mais une ancienne photo n'a pas pu être supprimée du stockage.",
          cleanupOk ? "success" : "error"
        );
      } catch (error) {
        console.error("Erreur enregistrement lieu :", error);
        if (uploadedPaths.length) await deleteStoragePaths(uploadedPaths);

        let message = error?.message || "Impossible d'enregistrer les modifications.";
        if (error?.code === "functions/unauthenticated") message = "Plus connecté.";
        if (error?.code === "functions/permission-denied") message = "Accès administrateur refusé.";
        if (error?.code === "functions/already-exists") message = "Ce numéro de lieu vient d'être utilisé. Actualiser le site.";

        setAdminStatus("place-status", message, "error");
      } finally {
        btn.disabled = false;
      }
    }

    async function deleteSelectedPlace() {
      if (currentRole !== "admin") return;
      const select = document.getElementById("admin-place-select");
      if (!select || select.value === "new") return;

      const placeId = Number(select.value);
      const place = placesData.find(item => Number(item.id) === placeId);
      if (!place || !isAdminManagedPlace(place)) {
        setAdminStatus("place-status", "Lieu protégé, ne peut pas être modifié ici.", "error");
        return;
      }

      if (!window.confirm(`Supprimer définitivement « ${place.title} » et tous ses souvenirs ajoutés depuis l'admin ?`)) return;

      const btn = document.getElementById("btn-delete-place");
      if (btn) btn.disabled = true;
      setAdminStatus("place-status", "Suppression du lieu…", "neutral");

      try {
        const functions = firebase.app().functions("europe-west9");
        const deleteAdminPlace = functions.httpsCallable("deleteAdminPlace");
        const result = await deleteAdminPlace({ placeId });

        await hydratePrivateData();
        populateAdminPlaces();
        resetAdminPlaceForm();
        refreshMapAfterPlacesChange();

        const cleanupOk = result.data?.cleanupOk !== false;
        setAdminStatus(
          "place-status",
          cleanupOk ? "Lieu supprimé." : "Lieu supprimé, mais au moins une photo n'a pas pu être supprimée du stockage.",
          cleanupOk ? "success" : "error"
        );
      } catch (error) {
        console.error("Erreur suppression lieu :", error);
        let message = error?.message || "Impossible de supprimer ce lieu.";
        if (error?.code === "functions/unauthenticated") message = "Plus connecté.";
        if (error?.code === "functions/permission-denied") message = "Ce lieu ne peut pas être supprimé.";
        setAdminStatus("place-status", message, "error");
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    const EMAILJS_PUBLIC_KEY = "NMr1ISqYYFK-jBLCC"; 
    const EMAILJS_SERVICE_ID = "updatemail";
    const EMAILJS_TEMPLATE_ID = "template_update";

    emailjs.init(EMAILJS_PUBLIC_KEY);

    function sendUpdateEmail() {
      const btn = document.getElementById('btn-send-email');
      const statusTxt = document.getElementById('email-status');
      
      btn.disabled = true;
      btn.classList.add('opacity-50');
      statusTxt.innerText = "Envoi en cours...";
      statusTxt.classList.remove('hidden', 'text-emerald-400', 'text-rose-400');

      const templateParams = {
        email: "linatsebo367@gmail.com"
      };

      emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams)
        .then(function(response) {
          statusTxt.innerText = "Email envoyé avec succès !";
          statusTxt.classList.add('text-emerald-400');
        })
        .catch(function(error) {
          console.error("Erreur EmailJS :", error);
          statusTxt.innerText = "Echec de l'envoi.";
          statusTxt.classList.add('text-rose-400');
          btn.disabled = false;
          btn.classList.remove('opacity-50');
        });
    }


    function calculateDays() {
      const startDate = new Date('2025-05-17T00:00:00');
      const currentDate = new Date();
      const diffTime = currentDate.getTime() - startDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      const counterElement = document.getElementById('day-counter');
      if (counterElement) counterElement.innerText = diffDays;
    }
    calculateDays();

    function openLightbox(container) {
      const img = container.querySelector('img');
      const lightbox = document.getElementById('lightbox');
      const lightboxImg = document.getElementById('lightbox-img');
      
      if (img && img.src) {
        lightboxImg.src = img.src;
        lightbox.classList.remove('invisible');
        setTimeout(() => lightbox.classList.add('opacity-100'), 10);
      }
    }

    function closeLightbox() {
      const lightbox = document.getElementById('lightbox');
      lightbox.classList.remove('opacity-100');
      setTimeout(() => lightbox.classList.add('invisible'), 300);
    }

    function toggleAudio() {
      const audio = document.getElementById('vocal-player');
      const icon = document.getElementById('audio-play-icon');
      if (audio.paused) {
        audio.play();
        icon.setAttribute('data-lucide', 'pause');
        icon.classList.remove('fill-purple-300');
      } else {
        audio.pause();
        icon.setAttribute('data-lucide', 'play');
        icon.classList.add('fill-purple-300');
      }
      lucide.createIcons();
    }

    function updateAudioProgress() {
      const audio = document.getElementById('vocal-player');
      const progress = document.getElementById('audio-progress');
      if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        progress.style.width = percent + '%';
      }
    }

    const vocalPlayer = document.getElementById('vocal-player');
    if(vocalPlayer) {
        vocalPlayer.onended = function() {
          const icon = document.getElementById('audio-play-icon');
          icon.setAttribute('data-lucide', 'play');
          icon.classList.add('fill-purple-300');
          lucide.createIcons();
          document.getElementById('audio-progress').style.width = '0%';
        };
    }

    document.querySelectorAll('#menu-state > div:nth-child(2) > button, #daily-note-card').forEach((card) => {
      card.addEventListener('mouseenter', () => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        if (card.classList.contains('menu-pinned-shake')) return;
        card.classList.add('menu-pinned-shake');
      });

      card.addEventListener('animationend', (event) => {
        if (event.animationName === 'menuPinnedShake') {
          card.classList.remove('menu-pinned-shake');
        }
      });
    });

async function enableNotifications() {
  if (!("serviceWorker" in navigator)) {
    console.error("Service Workers non supportés.");
    return false;
  }

  if (!("Notification" in window)) {
    console.error("Notifications non supportées.");
    return false;
  }

  try {
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;

    console.log("Permission notifications :", permission);

    if (permission !== "granted") {
      console.warn("Notifications non autorisées.");
      return false;
    }

    await navigator.serviceWorker.register(
      "./firebase-messaging-sw.js",
      { scope: "./" }
    );

    const registration = await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();

    const token = await messaging.getToken({
      vapidKey: "BIphsCrM9BS1XQno8CYHEUjtTSnBJ2z9yGh5984d7nTJ6_3Do63y9UXprFTI-DoxI5OzTrtCz4N9mbnWMlMbAV8",
      serviceWorkerRegistration: registration
    });

    if (!token) {
      console.error("Aucun token FCM généré.");
      return false;
    }

    if (currentRole === "user") {
      const deviceStorageKey = "juleslina_push_device_id";
      let deviceId = localStorage.getItem(deviceStorageKey);

      if (!deviceId) {
        deviceId = (window.crypto?.randomUUID?.() ||
          `device-${Date.now()}-${Math.random().toString(36).slice(2)}`)
          .replace(/[^a-zA-Z0-9_-]/g, "-");
        localStorage.setItem(deviceStorageKey, deviceId);
      }

      await db.collection("settings")
        .doc("pushToken_user")
        .collection("devices")
        .doc(deviceId)
        .set({
          token,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

    } else if (currentRole === "admin") {
      await db.collection("settings")
        .doc("pushToken_admin")
        .set({
          token,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    console.log("Notifications Firebase correctement configurées.");
    return true;

  } catch (error) {
    console.error(
      "Erreur configuration notifications Firebase :",
      error
    );
    return false;
  }
}


if (typeof firebase !== "undefined" && firebase.messaging) {

  const messaging = firebase.messaging();

  messaging.onMessage(async (payload) => {

    console.log("Notification reçue au premier plan :", payload);

    if (Notification.permission === "granted") {

      const registration = await navigator.serviceWorker.ready;

      await registration.showNotification(
        payload.notification?.title || "Jules & Li-Na",
        {
          body: payload.notification?.body || "",
          icon: "./assets/icon-192.jpeg"
        }
      );

    }

  });

}

async function sendPushNotification() {
  if (currentRole !== "admin") return;

  const titleInput = document.getElementById("admin-push-title");
  const messageInput = document.getElementById("admin-push-message");
  const btn = document.getElementById("btn-send-push");

  const title = titleInput?.value.trim();
  const body = messageInput?.value.trim();

  if (!title || !body) {
    setAdminStatus("push-status", "Le titre et le message sont obligatoires.", "error");
    return;
  }

  btn.disabled = true;
  setAdminStatus("push-status", "Envoi de la notification...", "neutral");

  try {
    const functions = firebase.app().functions("europe-west9");
    const sendPush = functions.httpsCallable("sendPushToLina");
    const result = await sendPush({ title, body });

    if (result.data?.success) {
      const sentCount = Number(result.data?.sentCount || 0);
      const failedCount = Number(result.data?.failedCount || 0);

      const statusMessage = sentCount > 0
        ? `Notification envoyée à ${sentCount} appareil${sentCount > 1 ? "s" : ""}${failedCount > 0 ? ` (${failedCount} échec${failedCount > 1 ? "s" : ""})` : ""}.`
        : "Notification push envoyée !";

      setAdminStatus("push-status", statusMessage, "success");
      titleInput.value = "";
      messageInput.value = "";
    } else {
      throw new Error("Réponse inattendue.");
    }
  } catch (error) {
    console.error("Erreur envoi notification push :", error);
    let message = "Impossible d'envoyer la notification push.";
    
    if (error?.code === "functions/unauthenticated") message = "Tu n'es plus connecté.";
    if (error?.code === "functions/permission-denied") message = "Accès administrateur refusé.";
    if (error?.code === "functions/not-found") message = "Aucun iPhone enregistré.";
    
    setAdminStatus("push-status", message, "error");
  } finally {
    btn.disabled = false;
  }
}