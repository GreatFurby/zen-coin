  "use strict";

  const fmt = new Intl.NumberFormat("nl-NL").format;
  const CAPACITY = 10;
  const MIN_SPAWN_COUNT = 5;
  const MAX_SPAWN_COUNT = 15;
  const START_SLOTS = 3;
  const PALETTE_SIZE = 100;
  const MAX_LEVEL = 50_000;
  const PAGE_SIZE = 12;
  const EMPTY_STACK = Object.freeze([]);
  const SAVE_KEY = "zen-coin-sorting-v1";

  const BOARD_VIEW_KEY = "zen-coin-board-view-v1";
  let compactView = false;
  try {
    compactView = localStorage.getItem(BOARD_VIEW_KEY) === "compact";
  } catch {
    // The toggle still works for this session when storage is blocked.
  }

  const viewButton = document.getElementById("board-view");
  const board = document.getElementById("board");
  const spawnButton = document.getElementById("spawn");
  const gameStatus = document.getElementById("status");
  const storageNotice = document.getElementById("storage");
  const highestDisplay = document.getElementById("highest");
  const unlockedDisplay = document.getElementById("unlocked");
  const freeDisplay = document.getElementById("free");
  const paging = document.getElementById("paging");
  const pageInput = document.getElementById("page-input");
  const previousPage = document.getElementById("page-prev");
  const nextPage = document.getElementById("page-next");
  const nextOccupied = document.getElementById("page-occupied");
  let selectedSlot = null;
  let currentPage = 0;

  function randomIndex(length) {
    return Math.floor(Math.random() * length);
  }

  function makePalette() {
    // Separate colors by hue, saturation and lightness, then shuffle their levels.
    const offset = randomIndex(360);
    const palette = [];
    for (let hue = 0; hue < 20; hue++) {
      for (const [saturation, lightness] of [[72, 57], [77, 71], [78, 84], [37, 61], [36, 76]]) {
        palette.push(`hsl(${(offset + hue * 18) % 360}, ${saturation}%, ${lightness}%)`);
      }
    }
    for (let index = palette.length - 1; index > 0; index--) {
      const other = randomIndex(index + 1);
      [palette[index], palette[other]] = [palette[other], palette[index]];
    }
    return palette;
  }

  function extendedPalette(palette) {
    // Keep the original palette's visible RGB values reserved.
    const reserved = new Set();
    let seed = 2166136261;
    for (const color of palette) {
      for (const character of color) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
      const [hue, saturation, lightness] = color.match(/\d+/g).map(Number);
      const light = lightness / 100;
      const amplitude = saturation / 100 * Math.min(light, 1 - light);
      const rgb = [0, 8, 4].map(offset => {
        const k = (offset + hue / 30) % 12;
        return Math.round(255 * (light - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
      });
      if (rgb.every(channel => channel >= 128 && channel % 2 === 0)) {
        const [r, g, b] = rgb.map(channel => (channel - 128) / 2);
        reserved.add((r << 12) | (g << 6) | b);
      }
    }
    return {seed, reserved: [...reserved].sort((a, b) => a - b)};
  }

  function coinColor(level) {
    if (level <= PALETTE_SIZE) return game.palette[level - 1];

    // Odd multipliers and xor shifts permute the 18-bit RGB index space.
    const mask = 0x3ffff;
    let index = level - PALETTE_SIZE - 1;
    do {
      index = (index + colors.seed) & mask;
      index = Math.imul(index ^ (index >>> 9), 0x2c1b3) & mask;
      index = Math.imul(index ^ (index >>> 7), 0x297a5) & mask;
      index ^= index >>> 8;
    } while (index >= mask + 1 - colors.reserved.length);
    for (const reserved of colors.reserved) {
      if (reserved > index) break;
      index++;
    }
    const rgb = [12, 6, 0].map(shift => 128 + 2 * ((index >>> shift) & 63));
    return `rgb(${rgb.join(", ")})`;
  }

  function newGame() {
    return {stacks: {}, highestEver: 0, palette: makePalette(), score: 0, best: 0};
  }

  function slotCountForLevel(level) {
    return Math.max(START_SLOTS, level + 1);
  }

  function slotCount() {
    return slotCountForLevel(game.highestEver);
  }

  function normalizeSave(saved) {
    if (!saved || !Number.isInteger(saved.highestEver) ||
        saved.highestEver < 0 || saved.highestEver > MAX_LEVEL) return null;
    const {highestEver, palette} = saved;
    if (!Array.isArray(palette) || palette.length !== PALETTE_SIZE ||
        new Set(palette).size !== PALETTE_SIZE || !palette.every(color =>
          typeof color === "string" &&
          /^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$/.test(color) && CSS.supports("color", color))) return null;

    const legacy = Array.isArray(saved.stacks);
    if (!saved.stacks || typeof saved.stacks !== "object") return null;
    if (legacy && (highestEver > PALETTE_SIZE || saved.stacks.length !== saved.unlockedSlots ||
        ![Math.max(START_SLOTS, highestEver), Math.min(PALETTE_SIZE, slotCountForLevel(highestEver))]
          .includes(saved.unlockedSlots))) return null;
    const stacks = {};
    for (const [key, stack] of Object.entries(saved.stacks)) {
      const index = Number(key);
      if (!Number.isInteger(index) || String(index) !== key || index < 0 ||
          index >= slotCountForLevel(highestEver) || !Array.isArray(stack) ||
          stack.length > CAPACITY || !stack.every(level =>
            Number.isInteger(level) && level >= 1 && level <= highestEver)) return null;
      if (stack.length) stacks[index] = stack;
    }
    const score = validScore(saved.score) ? saved.score : 0;
    const best = Math.max(score, validScore(saved.best) ? saved.best : 0);
    return {stacks, highestEver, palette, score, best};
  }

  function validScore(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function showStorageNotice(message) {
    storageNotice.textContent = message;
    storageNotice.hidden = !message;
  }

  function loadGame() {
    let raw;
    try {
      raw = localStorage.getItem(SAVE_KEY);
    } catch {
      showStorageNotice("Deze browser blokkeert lokaal opslaan. Je kunt hier wel spelen.");
      return null;
    }
    if (raw === null) return null;

    try {
      const saved = normalizeSave(JSON.parse(raw));
      if (saved) return saved;
    } catch {
      // A damaged save is handled the same way as an invalid one.
    }
    gameStatus.textContent = "Je opgeslagen spel kon niet worden geopend. Je begint met een leeg bord.";
    return null;
  }

  function saveGame() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(game));
      showStorageNotice("");
    } catch {
      showStorageNotice("Je voortgang kon niet worden opgeslagen in deze browser.");
    }
  }

  let game = loadGame() ?? newGame();
  let colors = extendedPalette(game.palette);

  function freeSpaces() {
    return slotCount() * CAPACITY -
      Object.values(game.stacks).reduce((total, stack) => total + stack.length, 0);
  }

  function frontRun(stack) {
    const level = stack.at(-1);
    let count = 0;
    while (count < stack.length && stack[stack.length - 1 - count] === level) count++;
    return count;
  }

  function settleBoard() {
    const merged = new Map();
    for (const [key, stack] of Object.entries(game.stacks)) {
      const level = stack.at(-1);
      if (stack.length === CAPACITY && level < MAX_LEVEL && frontRun(stack) === CAPACITY) {
        game.stacks[key] = [level + 1];
        merged.set(Number(key), level + 1);
        game.score += level;
        game.highestEver = Math.max(game.highestEver, level + 1);
      }
    }
    return merged;
  }

  function finishAction(message) {
    selectedSlot = null;
    const oldSlotCount = slotCount();
    const merged = settleBoard();
    if (merged.size) {
      const levels = [...merged.values()];
      message += levels.length === 1
        ? ` Samengevoegd tot niveau ${fmt(levels[0])}.`
        : ` Samengevoegd tot niveau ${levels.map(fmt).join(", ")}.`;
    }
    if (slotCount() > oldSlotCount) message += " Er is een plek vrijgespeeld.";
    game.best = Math.max(game.best, game.score);
    saveGame();
    render(merged);
    window.dispatchEvent(new Event("zen-score"));
    gameStatus.textContent = message;
  }

  function clickSlot(index) {
    const destination = game.stacks[index] ?? [];
    if (selectedSlot === index) {
      selectedSlot = null;
      gameStatus.textContent = "Selectie opgeheven.";
      render();
      return;
    }
    if (selectedSlot === null) {
      if (destination.length === 0) return;
      selectedSlot = index;
      const count = frontRun(destination);
      gameStatus.textContent = `Plek ${fmt(index + 1)} geselecteerd: ${fmt(count)} ${count === 1 ? "munt" : "munten"} van niveau ${fmt(destination.at(-1))}.`;
      render();
      return;
    }

    const source = game.stacks[selectedSlot];
    if (destination.length === CAPACITY) {
      gameStatus.textContent = "Die plek is vol.";
      return;
    }
    if (destination.length && destination.at(-1) !== source.at(-1)) {
      gameStatus.textContent = "Kies een lege plek of een stapel met hetzelfde niveau aan de rechterkant.";
      return;
    }

    const count = Math.min(frontRun(source), CAPACITY - destination.length);
    destination.push(...source.splice(source.length - count, count));
    game.stacks[index] = destination;
    if (!source.length) delete game.stacks[selectedSlot];
    finishAction(`${fmt(count)} ${count === 1 ? "munt verplaatst" : "munten verplaatst"}.`);
  }

  function spawnCoins() {
    const maxCount = Math.min(MAX_SPAWN_COUNT, freeSpaces());
    if (maxCount < MIN_SPAWN_COUNT) return;
    const spawnCount = MIN_SPAWN_COUNT + randomIndex(maxCount - MIN_SPAWN_COUNT + 1);

    let highestOnBoard = 0;
    for (const stack of Object.values(game.stacks)) {
      for (const level of stack) highestOnBoard = Math.max(highestOnBoard, level);
    }
    const maxSpawnLevel = Math.max(1, highestOnBoard - 1);
    const available = [];
    for (let index = 0; index < slotCount(); index++) {
      if ((game.stacks[index]?.length ?? 0) < CAPACITY) available.push(index);
    }
    // Pick uniformly from every non-full slot before settling the batch.
    for (let index = 0; index < spawnCount; index++) {
      const level = 1 + randomIndex(maxSpawnLevel);
      const target = randomIndex(available.length);
      const slot = available[target];
      const stack = game.stacks[slot] ??= [];
      stack.push(level);
      game.highestEver = Math.max(game.highestEver, level);
      if (stack.length === CAPACITY) {
        available[target] = available.at(-1);
        available.pop();
      }
    }
    finishAction(`${fmt(spawnCount)} nieuwe munten.`);
  }

  function hasLegalMove(occupied) {
    if (!occupied.length) return false;
    if (occupied.length < slotCount()) return true;

    // A repeated front level is playable if either stack has room.
    const seen = new Map();
    for (const stack of occupied) {
      const level = stack.at(-1);
      const hasRoom = stack.length < CAPACITY;
      if (seen.has(level) && (hasRoom || seen.get(level))) return true;
      seen.set(level, hasRoom);
    }
    return false;
  }

  function pageCount() {
    return Math.ceil(slotCount() / PAGE_SIZE);
  }

  function changePage(page) {
    currentPage = Math.max(0, Math.min(page, pageCount() - 1));
    render();
  }

  function nextOccupiedPage(indices) {
    let first = Infinity;
    let next = Infinity;
    for (const index of indices) {
      const page = Math.floor(Number(index) / PAGE_SIZE);
      if (page !== currentPage) first = Math.min(first, page);
      if (page > currentPage) next = Math.min(next, page);
    }
    return next === Infinity ? first : next;
  }

  function render(merged = new Map()) {
    board.classList.toggle("compact", compactView);
    viewButton.setAttribute("aria-pressed", String(compactView));
    const free = freeSpaces();
    highestDisplay.textContent = game.highestEver ? fmt(game.highestEver) : "—";
    unlockedDisplay.textContent = fmt(slotCount());
    freeDisplay.textContent = fmt(free);
    spawnButton.disabled = free < MIN_SPAWN_COUNT;

    document.getElementById("score").textContent = fmt(game.score);
    document.getElementById("best").textContent = fmt(game.best);
    const noMoves = document.getElementById("no-moves");
    const occupied = Object.values(game.stacks);
    noMoves.textContent = occupied.length && !hasLegalMove(occupied)
      ? free >= MIN_SPAWN_COUNT
        ? "Je kunt geen munten verplaatsen. Voeg nieuwe munten toe om verder te spelen."
        : "Je kunt geen munten meer verplaatsen of toevoegen. Begin opnieuw voor een nieuwe ronde."
      : "";

    const pages = pageCount();
    currentPage = Math.min(currentPage, pages - 1);
    paging.hidden = pages === 1;
    pageInput.max = pages;
    pageInput.value = currentPage + 1;
    document.getElementById("page-total").textContent = `van ${fmt(pages)}`;
    previousPage.disabled = currentPage === 0;
    nextPage.disabled = currentPage === pages - 1;
    nextOccupied.disabled = nextOccupiedPage(Object.keys(game.stacks)) === Infinity;
    const start = currentPage * PAGE_SIZE;
    const visible = Math.min(PAGE_SIZE, slotCount() - start);

    // Keep the slot buttons in place so keyboard focus survives each action.
    while (board.children.length > visible) board.lastElementChild.remove();
    for (let offset = 0; offset < visible; offset++) {
      const index = start + offset;
      const stack = game.stacks[index] ?? EMPTY_STACK;
      let button = board.children[offset];
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "slot";
        button.addEventListener("click", () => clickSlot(currentPage * PAGE_SIZE + offset));
        board.append(button);
      }

      const picked = selectedSlot === index;
      const pickedFrom = picked ? stack.length - frontRun(stack) : stack.length;
      const label = `Plek ${fmt(index + 1)}, ${fmt(stack.length)} van ${fmt(CAPACITY)} munten`;
      button.setAttribute("aria-label", stack.length
        ? `${label}. ${compactView ? "Van achter naar voren" : "Van links naar rechts"}: ${stack.map(fmt).join(", ")}`
        : label);
      button.setAttribute("aria-pressed", String(picked));

      const heading = document.createElement("span");
      heading.className = "slot-heading";
      heading.innerHTML = `<span>Plek ${fmt(index + 1)}</span><span class="count">${fmt(stack.length)}/${CAPACITY}</span>`;

      const track = document.createElement("span");
      track.className = "track";
      track.setAttribute("aria-hidden", "true");
      const cellCount = compactView ? Math.max(1, stack.length) : CAPACITY;
      for (let position = 0; position < cellCount; position++) {
        const cell = document.createElement("span");
        cell.className = "cell";
        const level = stack[position];
        if (level !== undefined) {
          cell.classList.add("coin");
          const showNumber = !compactView || position === stack.length - 1;
          const number = showNumber ? fmt(level) : "";
          if (showNumber && level >= 1000) {
            cell.classList.add("coin-large");
            const split = number.lastIndexOf(".") + 1;
            const leading = document.createElement("span");
            const trailing = document.createElement("span");
            leading.textContent = number.slice(0, split);
            trailing.textContent = number.slice(split);
            cell.append(leading, trailing);
          } else {
            cell.textContent = number;
          }
          cell.style.setProperty("--coin-color", coinColor(level));
          if (position >= pickedFrom) cell.classList.add("picked");
          if (merged.has(index)) cell.classList.add("merged");
        }
        if (compactView) cell.style.setProperty("--stack-offset", `${position * 7}px`);
        track.append(cell);
      }
      button.replaceChildren(heading, track);
    }
  }

  previousPage.addEventListener("click", () => changePage(currentPage - 1));
  nextPage.addEventListener("click", () => changePage(currentPage + 1));
  nextOccupied.addEventListener("click", () => {
    const page = nextOccupiedPage(Object.keys(game.stacks));
    if (page !== Infinity) changePage(page);
  });
  paging.addEventListener("submit", event => {
    event.preventDefault();
    if (Number.isInteger(pageInput.valueAsNumber)) changePage(pageInput.valueAsNumber - 1);
  });

  viewButton.addEventListener("click", () => {
    compactView = !compactView;
    try {
      localStorage.setItem(BOARD_VIEW_KEY, compactView ? "compact" : "classic");
    } catch {
      // The current view remains usable.
    }
    render();
  });

  spawnButton.addEventListener("click", spawnCoins);
  document.getElementById("reset").addEventListener("click", () => {
    document.getElementById("reset-dialog").showModal();
  });
  document.getElementById("reset-confirm").addEventListener("click", () => {
    const best = game.best;
    game = newGame();
    colors = extendedPalette(game.palette);
    currentPage = 0;
    game.best = best;
    finishAction("Je nieuwe ronde is begonnen.");
  });

  saveGame();
  render();
