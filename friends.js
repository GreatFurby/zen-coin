"use strict";

const byId = id => document.getElementById(id);
const endpoint = window.ZEN_COIN_ENDPOINT;
const PROFILE_KEY = "zen-coin-profile-v1";
const COOLDOWN_KEY = "zen-coin-ticker-v1";
const FIVE_MINUTES = 300_000;
const motion = matchMedia("(prefers-reduced-motion: reduce)");

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); }
  catch { return null; }
}

function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { showStorageNotice("Je browser kon je gegevens niet lokaal opslaan."); }
}

let profile = readLocal(PROFILE_KEY);
let ranking = null;
let ownMessage = "";
let onlineError = "";
let busy = false;
let refreshRequested = false;
let scoreChangedDuringRequest = false;
let lastRefresh = 0;

function saveProfile() {
  writeLocal(PROFILE_KEY, profile);
  byId("greeting").textContent = `Hoi, ${profile.name}!`;
  byId("greeting").hidden = false;
}

const errorMessages = {
  INVITE: "Die uitnodigingscode klopt niet.",
  AUTH: "Je profiel kon niet worden geverifieerd.",
  INPUT: "Controleer je invoer en probeer het opnieuw.",
  SERVER: "De spelserver is tijdelijk niet beschikbaar."
};

async function request(action, fields) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {"Content-Type": "text/plain;charset=UTF-8"},
    body: JSON.stringify({action, id: profile.id, token: profile.token, ...fields}),
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error("NETWORK");
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result;
}

function showConnection() {
  const connection = byId("connection");
  if (!endpoint) connection.textContent = "Je speelt lokaal. De vriendengroep is nog niet ingesteld.";
  else if (!navigator.onLine || onlineError) {
    connection.textContent = navigator.onLine ? onlineError : "Je bent offline.";
    if (profile?.joined) connection.textContent += " Je record wordt lokaal bewaard en later gesynchroniseerd.";
  } else if (profile && !profile.joined) {
    connection.textContent = "Gebruik je uitnodigingscode onder Profiel om mee te doen aan de ranglijst.";
  } else connection.textContent = "";
}

function renderRanking() {
  const tbody = byId("ranking-body");
  tbody.replaceChildren();
  byId("ranking-status").textContent = ranking?.length
    ? onlineError ? "Laatst opgehaalde scores." : ""
    : !endpoint ? "De vriendengroep is nog niet ingesteld."
      : !profile?.joined ? "Word lid via Profiel om de ranglijst te bekijken."
        : onlineError || (ranking ? "Er staan nog geen scores op de ranglijst." : "Ranglijst ophalen…");
  let place = 0;
  ranking?.forEach((player, index) => {
    if (index === 0 || player.best !== ranking[index - 1].best) place = index + 1;
    const row = tbody.insertRow();
    row.insertCell().textContent = fmt(place);
    const name = row.insertCell();
    name.textContent = player.name;
    if (validRecordCoin(player.recordCoin)) {
      const {level, color} = player.recordCoin;
      const coin = document.createElement("span");
      coin.className = "ranking-coin";
      coin.textContent = fmt(level);
      coin.style.setProperty("--coin-color", color);
      coin.setAttribute("role", "img");
      coin.setAttribute("aria-label", `Hoogste munt: niveau ${fmt(level)}`);
      name.append(coin);
    }
    row.insertCell().textContent = fmt(player.best);
  });
}

function acceptSnapshot(snapshot) {
  ownMessage = snapshot.message;
  profile.name = snapshot.name;
  profile.syncedBest = snapshot.best;
  const record = validRecordCoin(snapshot.recordCoin) ? snapshot.recordCoin : null;
  profile.syncedCoinLevel = record?.level ?? 0;
  const localCoinLevel = game.recordCoin?.level ?? 0;
  const updateCoin = record && record.level >= localCoinLevel &&
    (record.level > localCoinLevel || record.color !== game.recordCoin?.color);
  if (snapshot.best > game.best || updateCoin) {
    game.best = Math.max(game.best, snapshot.best);
    if (updateCoin) game.recordCoin = record;
    saveGame();
    render();
  }
  saveProfile();
  ranking = snapshot.ranking;
  ticker.setFeed(navigator.onLine ? snapshot.news : null);
  lastRefresh = Date.now();
  onlineError = navigator.onLine ? "" : "Je bent offline.";
  renderRanking();
}

async function exchange(action, fields = {}) {
  if (busy || !endpoint || !navigator.onLine) return false;
  busy = true;
  const controls = ["name-save", "message-save", "message-clear"];
  for (const id of controls) byId(id).disabled = true;
  byId("join-form").querySelector("button").disabled = true;
  try {
    const snapshot = await request(action, {best: game.best, recordCoin: game.recordCoin ?? null, ...fields});
    if (action === "join") profile.joined = true;
    acceptSnapshot(snapshot);
    return true;
  } catch (error) {
    const message = errorMessages[error.message] || "Geen verbinding met de spelserver.";
    if (!["INVITE", "INPUT"].includes(error.message)) {
      onlineError = message;
      ticker.setFeed(null);
    }
    if (action === "join" || action === "rename") byId("profile-status").textContent = message;
    if (action === "message") byId("message-status").textContent = message;
    renderRanking();
    return false;
  } finally {
    busy = false;
    for (const id of controls) byId(id).disabled = false;
    byId("join-form").querySelector("button").disabled = false;
    showConnection();
    if (refreshRequested || scoreChangedDuringRequest) {
      refreshRequested = scoreChangedDuringRequest = false;
      setTimeout(refresh, 0);
    }
  }
}

function refresh() {
  if (!profile?.joined || !endpoint || document.hidden || !navigator.onLine) return;
  if (busy) { refreshRequested = true; return; }
  void exchange("sync");
}

const screens = ["info", "ranking", "play", "profile"];

function showScreen(screen) {
  for (const id of screens) {
    byId(id).hidden = id !== screen;
    byId(`${id}-open`).setAttribute("aria-pressed", String(id === screen));
  }
  window.scrollTo(0, 0);
  ticker.resumeOrPause();
}

function populateProfile() {
  byId("profile-title").textContent = profile ? "Profiel" : "Hoe mogen we je noemen?";
  byId("name-form").querySelector("label").textContent = profile ? "Naam wijzigen" : "Je naam";
  byId("name").value = profile?.name ?? "";
  byId("join-form").hidden = !endpoint || !profile || profile.joined;
}

for (const id of screens) {
  byId(`${id}-open`).onclick = () => {
    showScreen(id);
    if (id === "ranking") {
      renderRanking();
      if (!ranking || onlineError) refresh();
    }
  };
}

byId("name-form").onsubmit = async event => {
  event.preventDefault();
  const name = byId("name").value.trim();
  if (!name) { byId("profile-status").textContent = "Vul je naam in."; return; }
  if (profile?.joined) {
    if (!navigator.onLine) { byId("profile-status").textContent = "Maak verbinding om je naam te wijzigen."; return; }
    if (await exchange("rename", {name})) byId("profile-status").textContent = "Je naam is opgeslagen.";
    return;
  }
  const firstVisit = !profile;
  if (firstVisit) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
      byte.toString(16).padStart(2, "0")).join("");
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      byte.toString(16).padStart(2, "0")).join("");
    profile = {id, token, name, joined: false, syncedBest: 0};
  }
  profile.name = name;
  saveProfile();
  showConnection();
  populateProfile();
  byId("profile-status").textContent = "Je naam is opgeslagen.";
  if (firstVisit) showScreen("info");
};

byId("join-form").onsubmit = async event => {
  event.preventDefault();
  if (!navigator.onLine) { byId("profile-status").textContent = "Maak verbinding om lid te worden."; return; }
  if (await exchange("join", {name: profile.name, invite: byId("invite").value})) {
    byId("invite").value = "";
    byId("join-form").hidden = true;
    byId("profile-status").textContent = "Je bent lid van de vriendengroep.";
  }
};

function countMessage() {
  byId("message-count").textContent = `${fmt(byId("message").value.length)} / 160`;
}

byId("ticker-open").onclick = () => {
  byId("message").value = ownMessage;
  const canEdit = !!endpoint && !!profile?.joined && navigator.onLine;
  byId("message-form").hidden = !canEdit;
  byId("message-status").textContent = canEdit ? ""
    : !endpoint ? "De vriendengroep is nog niet ingesteld."
      : !profile?.joined ? "Word lid via Profiel om een bericht te plaatsen."
        : "Maak verbinding om je bericht te wijzigen.";
  countMessage();
  byId("composer").showModal();
  if (canEdit && !lastRefresh) refresh();
};
byId("message").oninput = countMessage;
async function saveMessage(message) {
  if (!navigator.onLine) { byId("message-status").textContent = "Maak verbinding om je bericht te wijzigen."; return; }
  if (await exchange("message", {message})) {
    byId("message").value = ownMessage;
    countMessage();
    byId("message-status").textContent = message ? "Je bericht is opgeslagen." : "Je bericht is gewist.";
  }
}
byId("message-form").onsubmit = event => {
  event.preventDefault();
  void saveMessage(byId("message").value);
};
byId("message-clear").onclick = () => void saveMessage("");

function shuffled(lines) {
  const copy = lines.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class NewsTicker {
  constructor() {
    this.line = byId("ticker-line");
    this.played = readLocal(COOLDOWN_KEY) || {};
    this.regular = [];
    this.deck = [];
    this.friends = [];
    this.regularCount = 0;
    this.active = false;
    this.timer = null;
    this.animation = null;
    this.current = null;
    this.isPlayerNews = false;
    this.inGap = false;
    document.addEventListener("visibilitychange", () => this.resumeOrPause());
    motion.addEventListener("change", () => {
      if (this.current) this.show(this.current, this.isPlayerNews);
    });
    this.setFeed(null);
  }

  setFeed(feed) {
    this.active = !!feed;
    if (!feed) {
      this.stopClock();
      this.animation?.cancel();
      this.animation = null;
      this.current = null;
      this.inGap = false;
      this.line.textContent = "Bericht plaatsen";
      this.line.className = "still";
      return;
    }
    if (JSON.stringify(this.regular) !== JSON.stringify(feed.regular)) {
      this.regular = feed.regular;
      this.deck = shuffled(this.regular);
    }
    this.friends = feed.players;
    if (!this.regular.length && !this.current && !this.inGap) {
      this.line.textContent = "Bericht plaatsen";
      this.line.className = "still";
    }
    if (!this.current && !this.inGap) this.next();
  }

  stopClock() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.remaining = Math.max(0, this.deadline - performance.now());
    }
  }

  schedule(duration, callback) {
    this.stopClock();
    this.remaining = duration;
    this.callback = callback;
    this.resumeOrPause();
  }

  resumeOrPause() {
    if (!this.active) return;
    if (document.hidden || byId("play").hidden) {
      this.stopClock();
      this.animation?.pause();
      return;
    }
    if (this.animation?.playState === "paused") this.animation.play();
    if (!this.current && !this.inGap) { this.next(); return; }
    if (this.timer !== null) return;
    this.deadline = performance.now() + this.remaining;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.callback();
    }, this.remaining);
  }

  next() {
    if (!this.active || document.hidden || byId("play").hidden || !this.regular.length) return;
    if (this.regularCount === 3) {
      this.regularCount = 0;
      const now = Date.now();
      for (const key of Object.keys(this.played)) {
        if (now - this.played[key] >= FIVE_MINUTES) delete this.played[key];
      }
      const eligible = this.friends.filter(line => !(line.key in this.played));
      if (eligible.length) {
        const chosen = eligible[randomIndex(eligible.length)];
        this.played[chosen.key] = now;
        writeLocal(COOLDOWN_KEY, this.played);
        this.show(`${chosen.name}: ${chosen.message}`, true);
        return;
      }
    }
    if (!this.deck.length) this.deck = shuffled(this.regular);
    this.regularCount++;
    this.show(this.deck.pop());
  }

  show(text, isPlayerNews = false) {
    this.animation?.cancel();
    this.animation = null;
    this.current = text;
    this.isPlayerNews = isPlayerNews;
    this.line.classList.toggle("player-news", isPlayerNews);
    this.line.textContent = text;
    this.line.classList.toggle("still", motion.matches);
    const width = byId("ticker-open").clientWidth;
    const distance = width + this.line.offsetWidth;
    const duration = motion.matches ? Math.max(6000, text.length * 70) : Math.max(6500, distance / 48 * 1000);
    if (!motion.matches) {
      this.animation = this.line.animate([
        {transform: `translateX(${width}px)`},
        {transform: `translateX(-${this.line.offsetWidth + 16}px)`}
      ], {duration, easing: "linear", fill: "both"});
    }
    this.schedule(duration, () => {
      this.animation?.cancel();
      this.animation = null;
      this.line.textContent = "";
      this.current = null;
      this.inGap = true;
      this.schedule(5000, () => {
        this.inGap = false;
        this.next();
      });
    });
  }
}

const ticker = new NewsTicker();
if (profile) saveProfile();
populateProfile();
if (!profile) showScreen("profile");
showConnection();
refresh();

function hasPendingRecords() {
  return profile?.joined && (game.best > (profile.syncedBest ?? 0) ||
    (game.recordCoin?.level ?? 0) > (profile.syncedCoinLevel ?? 0));
}

window.addEventListener("zen-score", () => {
  if (!hasPendingRecords()) return;
  if (busy) scoreChangedDuringRequest = true;
  else refresh();
});
window.addEventListener("online", () => { showConnection(); refresh(); });
window.addEventListener("offline", () => {
  onlineError = "Je bent offline.";
  ticker.setFeed(null);
  showConnection();
  renderRanking();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (Date.now() - lastRefresh >= FIVE_MINUTES ||
      onlineError || hasPendingRecords())) refresh();
});
setInterval(() => {
  if (Date.now() - lastRefresh >= FIVE_MINUTES || onlineError ||
      hasPendingRecords()) refresh();
}, 15_000);
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {
    byId("connection").textContent = "Offline installeren is hier tijdelijk niet beschikbaar.";
  });
}
