
lucide.createIcons();

const FIREBASE_SDK_READY = typeof firebase !== "undefined";
let auth = null;
let db = null;
let placesData = [];
let currentRole = null;

if (!FIREBASE_SDK_READY) {
  console.error("Firebase SDK non chargé.");
} else if (!window.APP_CONFIG || !window.APP_CONFIG.firebase) {
  console.error("Configuration Firebase manquante dans firebase-config.js.");
} else {
  firebase.initializeApp(window.APP_CONFIG.firebase);
  auth = firebase.auth();
  db = firebase.firestore();
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

async function lockSite() {
  try {
    if (auth) await auth.signOut();
  } finally {
    currentRole = null;
    placesData = [];
    const input = document.getElementById("password-input");
    if (input) input.value = "";
    navigate("locked");
  }
}

const states = ['locked', 'menu', 'map', 'letter', 'admin'];
    
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
        if (role === "admin") {
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

    let adminEventIndex = 0;

    function addAdminEvent(initial = {}) {
      const list = document.getElementById("admin-events-list");
      if (!list) return;

      const index = ++adminEventIndex;
      const block = document.createElement("div");
      block.className = "admin-event-card";
      block.dataset.eventIndex = index;
      block.innerHTML = `
        <div class="admin-event-card-head">
          <strong>Événement ${list.children.length + 1}</strong>
          <button type="button" class="admin-remove-event" aria-label="Supprimer l'événement">Supprimer</button>
        </div>
        <label class="admin-field">
          <span>Date</span>
          <input type="text" class="admin-input event-date" placeholder="Ex. 23 Septembre 2026">
        </label>
        <label class="admin-field">
          <span>Titre</span>
          <input type="text" class="admin-input event-title" placeholder="Titre du souvenir">
        </label>
        <label class="admin-field">
          <span>Texte</span>
          <textarea class="admin-input admin-textarea event-text" placeholder="Texte du souvenir"></textarea>
        </label>
        <label class="admin-field">
          <span>Photos / vidéos</span>
          <input type="text" class="admin-input event-photos" placeholder="assets/photo1.jpeg, assets/photo2.jpeg">
        </label>
      `;

      block.querySelector(".event-date").value = initial.date || "";
      block.querySelector(".event-title").value = initial.title || "";
      block.querySelector(".event-text").value = initial.text || "";
      block.querySelector(".event-photos").value = (initial.photos || []).join(", ");
      block.querySelector(".admin-remove-event").addEventListener("click", () => {
        block.remove();
        renumberAdminEvents();
      });

      list.appendChild(block);
      lucide.createIcons();
    }

    function renumberAdminEvents() {
      document.querySelectorAll("#admin-events-list .admin-event-card").forEach((card, i) => {
        const title = card.querySelector(".admin-event-card-head strong");
        if (title) title.textContent = `Événement ${i + 1}`;
      });
    }

    function resetAdminPlaceForm() {
      ["admin-place-lat", "admin-place-lng", "admin-place-title"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      const list = document.getElementById("admin-events-list");
      if (list) list.innerHTML = "";
      adminEventIndex = 0;
      addAdminEvent();
    }

    function collectAdminEvents() {
      return [...document.querySelectorAll("#admin-events-list .admin-event-card")].map(card => {
        const photos = card.querySelector(".event-photos").value
          .split(",")
          .map(v => v.trim())
          .filter(Boolean);

        return {
          date: card.querySelector(".event-date").value.trim(),
          title: card.querySelector(".event-title").value.trim(),
          text: card.querySelector(".event-text").value.trim(),
          photos
        };
      }).filter(event => event.date || event.title || event.text || event.photos.length);
    }

    async function savePlace() {
      if (currentRole !== "admin") return;

      const lat = Number(document.getElementById("admin-place-lat").value);
      const lng = Number(document.getElementById("admin-place-lng").value);
      const title = document.getElementById("admin-place-title").value.trim();
      const events = collectAdminEvents();
      const btn = document.getElementById("btn-save-place");

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !title || events.length === 0) {
        setAdminStatus("place-status", "Latitude, longitude, titre et au moins un événement sont obligatoires.", "error");
        return;
      }

      btn.disabled = true;
      try {
        const lastSnap = await db.collection("places").orderBy("id", "desc").limit(1).get();
        const nextId = lastSnap.empty ? 1 : Number(lastSnap.docs[0].data().id) + 1;

        const place = { id: nextId, lat, lng, title, events };
        await db.collection("places").doc(`place-${nextId}`).set(place);
        placesData.push(place);
        placesData.sort((a, b) => a.id - b.id);

        setAdminStatus("place-status", `Lieu ajouté avec l'ID ${nextId}.`, "success");
        resetAdminPlaceForm();

        if (map) {
          map.remove();
          map = null;
          darkLayer = null;
          satelliteLayer = null;
          isSatellite = false;
          const container = document.getElementById("leaflet-map");
          if (container) container._leaflet_id = null;
        }
      } catch (error) {
        console.error(error);
        setAdminStatus("place-status", "Impossible d'ajouter le lieu.", "error");
      } finally {
        btn.disabled = false;
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
  