const RULES = {
  goal: 2,
  assist: 1,
  winPlayer: 1,
  cleanSheetPlayer: 1,
  yellow_card: -1,
  red_card: -2,
  teamWin: 2,
  teamCleanSheet: 1
};

const state = {
  familyMembers: [],
  cards: [],
  matches: [],
  playerImages: [],
  provider: "local",
  fetchedAt: null,
  currentMember: null,
  sortCards: "points",
  collectionView: "cards",
  selectedCardId: null,
  selectedMatchId: null,
  overlayCardId: null,
  imageStatus: "all"
};

const byId = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
const normal = (value) => String(value || "").trim().toLowerCase();
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
const keyForCard = (card) => `${normal(card.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim()}__${String(card.teamCode || "UNK").toUpperCase()}`;
const isDefensive = (card) => ["defender", "goalkeeper"].includes(normal(card.position));
const matchPosition = (card, match) => {
  const lineup = (match.lineups || []).find((item) => normal(item.player) === normal(card.name) && normal(item.team) === normal(card.team));
  return lineup?.position || card.position;
};
const isDefensiveInMatch = (card, match) => ["defender", "goalkeeper"].includes(normal(matchPosition(card, match)));
const fmtDate = (date) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)) : "TBC";

async function loadData(sync = false) {
  const [ownership, matches, imageStore] = await Promise.all([
    fetch("/api/ownership").then((r) => r.json()),
    fetch(sync ? "/api/sync" : "/api/matches").then((r) => r.json()),
    fetch("/api/player-images").then((r) => r.json())
  ]);
  state.familyMembers = ownership.familyMembers;
  state.cards = ownership.cards;
  state.playerImages = imageStore.records || [];
  if (!state.currentMember && state.familyMembers[0]) state.currentMember = state.familyMembers[0].id;
  state.matches = matches.matches;
  state.provider = matches.provider;
  state.fetchedAt = matches.fetchedAt;
  render();
}

function imageRecordForCard(card) {
  return state.playerImages.find((record) => record.id === keyForCard(card));
}

function isPlayerCard(card) {
  return card.category !== "Team Crest" && card.position !== "Team" && !normal(card.name).endsWith(" crest");
}

function initials(name) {
  return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function categoryClass(category) {
  return `cat-${normal(category).replace(/[^a-z0-9]+/g, "-") || "base"}`;
}

function isBlingCategory(category) {
  return ["golden ballers", "icon", "goal machines", "defensive rocks", "midfield maestros", "master rookies", "limited edition", "contenders", "fan favourite"].includes(normal(category));
}

function imageUrlForCard(card) {
  const record = imageRecordForCard(card);
  if (!record || record.status === "rejected") return "";
  return record.manualOverrideUrl || record.thumbnailUrl || record.imageUrl || "";
}

function imageMarkup(card, size = "card") {
  const url = imageUrlForCard(card);
  const label = esc(card.name);
  const classes = `card-image ${size} ${categoryClass(card.category)}`;
  if (url) {
    return `<div class="${classes}"><img src="${esc(url)}" alt="${label}" loading="lazy" onerror="this.closest('.card-image').classList.add('broken'); this.remove();"><span>${esc(initials(card.name))}</span></div>`;
  }
  return `<div class="${classes} placeholder"><span>${esc(initials(card.name))}</span><small>${esc(card.teamCode || card.team || "")}</small></div>`;
}

function compactCard(card, ownerMap) {
  return `<button class="link-card compact-card" type="button" data-open-card="${esc(card.id)}">${imageMarkup(card, "avatar")}<span><strong>${esc(card.name)}</strong><small>${esc(ownerMap?.[card.ownerId]?.name || card.team)}</small></span></button>`;
}

function activateView(viewId) {
  document.querySelectorAll(".tabs button").forEach((item) => item.classList.toggle("active", item.dataset.view === viewId));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === viewId));
}

function openOwnerCollection(ownerId) {
  state.currentMember = ownerId;
  state.collectionView = "cards";
  state.selectedCardId = null;
  const scored = scoreTournament();
  renderCollections(scored);
  activateView("collections");
}

function openCardOverlay(cardId) {
  state.overlayCardId = cardId;
  renderCardOverlay(scoreTournament());
}

function closeCardOverlay() {
  state.overlayCardId = null;
  renderCardOverlay(scoreTournament());
}

function matchOwnerPoints(scored, matchId) {
  return scored.leaderboard
    .map((owner) => ({ ...owner, matchPoints: scored.owners[owner.id].matchScores[matchId] || 0 }))
    .filter((owner) => owner.matchPoints !== 0)
    .sort((a, b) => b.matchPoints - a.matchPoints);
}

function cardMatchPoints(card, matchId) {
  return card.history.filter((entry) => entry.matchId === matchId).reduce((sum, entry) => sum + entry.points, 0);
}

function teamGroupsForCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    const key = card.teamCode || card.team;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        team: card.team,
        teamCode: card.teamCode || key,
        points: 0,
        cards: [],
        players: [],
        crests: []
      });
    }
    const group = groups.get(key);
    group.points += card.points;
    group.cards.push(card);
    if (card.category === "Team Crest") group.crests.push(card);
    else group.players.push(card);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      hero: [...group.cards].sort((a, b) => b.points - a.points || (imageUrlForCard(b) ? 1 : 0) - (imageUrlForCard(a) ? 1 : 0))[0],
      topCards: [...group.cards].sort((a, b) => b.points - a.points)
    }))
    .sort((a, b) => b.points - a.points || b.cards.length - a.cards.length || a.team.localeCompare(b.team));
}

function scoreTournament() {
  const owners = byId(state.familyMembers);
  const cards = state.cards.map((card) => ({ ...card, points: 0, history: [], recent: 0 }));
  const ownerScores = Object.fromEntries(state.familyMembers.map((owner) => [owner.id, { ...owner, total: 0, recent: 0, cards: 0, matchScores: {} }]));
  const cardByName = Object.fromEntries(cards.map((card) => [normal(card.name), card]));
  const events = [];

  for (const match of state.matches) {
    const matchCardIds = new Set();
    const addScore = (card, points, label, minute = 90, type = "bonus") => {
      if (!card || !points) return;
      const owner = owners[card.ownerId];
      const entry = { matchId: match.id, match: `${match.homeTeam} vs ${match.awayTeam}`, minute, type, label, points };
      card.points += points;
      card.history.push(entry);
      matchCardIds.add(card.id);
      ownerScores[card.ownerId].total += points;
      ownerScores[card.ownerId].matchScores[match.id] = (ownerScores[card.ownerId].matchScores[match.id] || 0) + points;
      if (match.status === "live" || new Date(match.kickoff) > Date.now() - 7 * 86400000) {
        ownerScores[card.ownerId].recent += points;
        card.recent += points;
      }
      events.push({ ...entry, cardId: card.id, cardName: card.name, ownerName: owner.name, team: card.team, matchId: match.id });
    };

    for (const event of match.events || []) {
      if (event.type === "goal") {
        addScore(cardByName[normal(event.player)], RULES.goal, `${event.player} goal`, event.minute, "goal");
        addScore(cardByName[normal(event.assist)], RULES.assist, `${event.assist} assist`, event.minute, "assist");
      }
      if (event.type === "yellow_card") addScore(cardByName[normal(event.player)], RULES.yellow_card, `${event.player} yellow card`, event.minute, "yellow_card");
      if (event.type === "red_card") addScore(cardByName[normal(event.player)], RULES.red_card, `${event.player} red card`, event.minute, "red_card");
    }

    if (match.status === "completed" && Number.isFinite(match.homeScore) && Number.isFinite(match.awayScore)) {
      const homeWon = match.homeScore > match.awayScore;
      const awayWon = match.awayScore > match.homeScore;
      const cleanTeams = [];
      if (match.awayScore === 0) cleanTeams.push(match.homeTeam);
      if (match.homeScore === 0) cleanTeams.push(match.awayTeam);
      for (const card of cards) {
        const won = (card.team === match.homeTeam && homeWon) || (card.team === match.awayTeam && awayWon);
        const clean = cleanTeams.includes(card.team);
        if (card.category === "Team Crest") {
          if (won) addScore(card, RULES.teamWin, `${card.team} win`, 90, "team_win");
          if (clean) addScore(card, RULES.teamCleanSheet, `${card.team} clean sheet`, 90, "team_clean_sheet");
        } else {
          if (won) addScore(card, RULES.winPlayer, `${card.team} win`, 90, "player_win");
          if (clean && isDefensiveInMatch(card, match)) addScore(card, RULES.cleanSheetPlayer, `${card.name} clean sheet`, 90, "player_clean_sheet");
        }
      }
    }
    match.cardIds = [...matchCardIds];
  }

  for (const card of cards) ownerScores[card.ownerId].cards += 1;
  const leaderboard = Object.values(ownerScores).sort((a, b) => b.total - a.total);
  leaderboard.forEach((owner, index) => {
    owner.rank = index + 1;
    owner.movement = owner.recent > 2 ? "up" : owner.recent < 0 ? "down" : "same";
  });

  return { cards, owners: ownerScores, leaderboard, events: events.sort((a, b) => b.minute - a.minute) };
}

function render() {
  const scored = scoreTournament();
  document.querySelector("#providerBadge").textContent = `${state.provider || "local"} cache ${state.fetchedAt ? "• " + new Date(state.fetchedAt).toLocaleTimeString() : ""}`;
  renderHome(scored);
  renderDashboard(scored);
  renderCollections(scored);
  renderMatches(scored);
  renderStats(scored);
  renderRecords(scored);
  renderImages(scored);
  renderArchitecture();
  renderCardOverlay(scored);
}

function renderHome(scored) {
  const topOwner = scored.leaderboard[0];
  const topCard = scored.cards.toSorted((a, b) => b.points - a.points)[0];
  const liveMatches = state.matches.filter((match) => match.status === "live").length;
  const completedMatches = state.matches.filter((match) => match.status === "completed").length;
  const imageCount = state.playerImages.filter((record) => record.imageUrl || record.thumbnailUrl || record.manualOverrideUrl).length;
  const owners = byId(state.familyMembers);
  const latestEvents = scored.events.slice(0, 3);
  const panels = [
    { view: "dashboard", kicker: "Leaderboard", title: `${topOwner?.name || "No leader"} leads`, body: `${topOwner?.total || 0} points total, ${topOwner?.recent >= 0 ? "+" : ""}${topOwner?.recent || 0} recent.`, metric: `${scored.leaderboard.length}`, label: "owners" },
    { view: "collections", kicker: "Collections", title: `${state.cards.length} cards in play`, body: `Browse by owner, team, card, rarity, and scoring history.`, metric: `${new Set(state.cards.map((card) => card.teamCode || card.team)).size}`, label: "teams" },
    { view: "matches", kicker: "Match Centre", title: `${liveMatches} live, ${completedMatches} complete`, body: `See match points per owner and card-level fantasy impact.`, metric: `${state.matches.length}`, label: "matches" },
    { view: "stats", kicker: "Statistics", title: `${topCard?.name || "Top card"} is hot`, body: `${topCard?.team || ""} • ${topCard?.points || 0} fantasy points.`, metric: `${topCard?.points || 0}`, label: "top pts" },
    { view: "records", kicker: "Records", title: "Awards and milestones", body: `Achievements, weekly awards, and hall-of-fame records.`, metric: "10", label: "records" },
    { view: "images", kicker: "Images", title: `${imageCount} player images`, body: `Review image candidates and manual overrides.`, metric: `${imageCount}`, label: "images" }
  ];
  document.querySelector("#home").innerHTML = `
    <section class="home-hero">
      <div class="home-hero-copy">
        <p class="eyebrow">Tournament dashboard</p>
        <h2>Follow the cards, the points, and the family bragging rights.</h2>
        <p>Live storylines, match impact, collections, awards, and card art in one place.</p>
        <div class="home-actions">
          <button type="button" data-home-view="dashboard">View leaderboard</button>
          <button type="button" data-home-view="matches">Open match centre</button>
        </div>
      </div>
      <div class="hero-score-stack">
        ${scored.leaderboard.slice(0, 3).map((owner) => `
          <button type="button" class="hero-owner" data-owner-id="${esc(owner.id)}">
            <span class="rank" style="background:${owner.colour}">${owner.rank}</span>
            <strong>${esc(owner.name)}</strong>
            <b>${owner.total}</b>
          </button>`).join("")}
      </div>
    </section>
    <section class="home-summary-grid">
      ${panels.map((panel) => `
        <button class="home-link-card" type="button" data-home-view="${panel.view}">
          <span>${esc(panel.kicker)}</span>
          <strong>${esc(panel.title)}</strong>
          <p>${esc(panel.body)}</p>
          <b>${esc(panel.metric)} <small>${esc(panel.label)}</small></b>
        </button>`).join("")}
    </section>
    <section class="grid home-lower">
      <div class="panel span-7">
        <h2>Latest fantasy impact</h2>
        ${latestEvents.map((event) => {
          const card = scored.cards.find((item) => item.id === event.cardId);
          return `<div class="feed-row">
            ${card ? imageMarkup(card, "avatar") : ""}
            <div><strong><button class="inline-link" type="button" data-open-card="${esc(event.cardId)}">${esc(event.cardName)}</button></strong><br><span class="muted">${esc(event.team)} • ${esc(event.type.replaceAll("_", " "))} • ${esc(event.ownerName)}</span></div>
            <span class="points ${event.points > 0 ? "positive" : "negative"}">${event.points > 0 ? "+" : ""}${event.points}</span>
          </div>`;
        }).join("") || `<p class="muted">No fantasy events yet.</p>`}
      </div>
      <div class="panel span-5">
        <h2>Quick owners</h2>
        ${state.familyMembers.map((owner) => {
          const score = scored.owners[owner.id];
          return `<button class="owner-score-row" type="button" data-owner-id="${esc(owner.id)}"><span>${esc(owner.name)} <small class="muted">${score.cards} cards</small></span><strong>${score.total}</strong></button>`;
        }).join("")}
      </div>
    </section>`;
}

function storyline(scored) {
  const [first, second] = scored.leaderboard;
  const topCard = scored.cards.toSorted((a, b) => b.points - a.points)[0];
  const bigRecent = scored.leaderboard.toSorted((a, b) => b.recent - a.recent)[0];
  const lines = [];
  if (first && second) lines.push(`${second.name} is only ${Math.max(0, first.total - second.total)} points behind ${first.name}.`);
  if (topCard) lines.push(`${topCard.name} is now the highest-scoring card with ${topCard.points} points.`);
  if (bigRecent?.recent > 0) lines.push(`${bigRecent.name} just gained ${bigRecent.recent} recent points.`);
  return lines;
}

function renderDashboard(scored) {
  const scoredCardById = byId(scored.cards);
  const ownerMap = byId(state.familyMembers);
  const feed = scored.events.slice(0, 8).map((event) => `
    <div class="feed-row">
      ${event.cardId ? imageMarkup(scoredCardById[event.cardId], "avatar") : `<span class="${event.points > 0 ? "positive" : "negative"}">${event.points > 0 ? "+" : ""}${event.points}</span>`}
      <div>
        <strong>${event.cardId ? `<button class="inline-link" type="button" data-open-card="${esc(event.cardId)}">${esc(event.cardName)}</button>` : esc(event.label)}</strong>
        <br>
        <span class="muted">${esc(event.team)} • ${esc(event.type.replaceAll("_", " "))} • ${esc(event.match)} • <button class="inline-link muted-link" type="button" data-owner-id="${esc(scoredCardById[event.cardId]?.ownerId || "")}">${esc(event.ownerName)}</button></span>
      </div>
      <span class="points ${event.points > 0 ? "positive" : "negative"}">${event.points > 0 ? "+" : ""}${event.points}</span>
    </div>`).join("");

  document.querySelector("#dashboard").innerHTML = `
    <div class="grid">
      <section class="panel span-7">
        <h2>Main leaderboard</h2>
        ${scored.leaderboard.map((owner) => `
          <div class="leader-row">
            <span class="rank" style="background:${owner.colour}">${owner.rank}</span>
            <div><strong><button class="inline-link owner-link" type="button" data-owner-id="${esc(owner.id)}">${esc(owner.name)}</button></strong><br><span class="muted">${owner.cards} cards • ${owner.movement === "up" ? "Moving up" : owner.movement === "down" ? "Dropped points" : "Holding steady"}</span></div>
            <div class="points">${owner.total} <span class="${owner.recent >= 0 ? "positive" : "negative"}">${owner.recent >= 0 ? "+" : ""}${owner.recent}</span></div>
          </div>`).join("")}
      </section>
      <section class="panel span-5">
        <h2>Storylines</h2>
        ${storyline(scored).map((line) => `<p class="storyline">${line}</p>`).join("")}
      </section>
      <section class="panel span-12">
        <h2>Live match impact feed</h2>
        ${feed || `<p class="muted">No fantasy events yet.</p>`}
      </section>
    </div>`;
}

function renderCollections(scored) {
  const owners = [{ id: "all", name: "All owners" }, ...state.familyMembers];
  let cards = scored.cards.filter((card) => state.currentMember === "all" || card.ownerId === state.currentMember);
  cards = cards.toSorted((a, b) => {
    if (state.sortCards === "points") return b.points - a.points;
    return String(a[state.sortCards]).localeCompare(String(b[state.sortCards]));
  });
  const ownerMap = byId(state.familyMembers);
  if (!state.selectedCardId && cards[0]) state.selectedCardId = cards[0].id;
  const selected = scored.cards.find((card) => card.id === state.selectedCardId) || cards[0];
  document.querySelector("#collections").innerHTML = `
    <div class="toolbar">
      <h2>Collections</h2>
      <div>
        <div class="segmented" role="group" aria-label="Collection view">
          <button type="button" class="${state.collectionView === "cards" ? "active" : ""}" data-collection-view="cards">Cards</button>
          <button type="button" class="${state.collectionView === "teams" ? "active" : ""}" data-collection-view="teams">Teams</button>
        </div>
        <select id="memberSelect">${owners.map((owner) => `<option value="${owner.id}" ${owner.id === state.currentMember ? "selected" : ""}>${owner.name}</option>`).join("")}</select>
        <select id="sortSelect">
          ${["points", "team", "category", "name"].map((item) => `<option value="${item}" ${item === state.sortCards ? "selected" : ""}>Sort by ${item}</option>`).join("")}
        </select>
      </div>
    </div>
    ${state.collectionView === "teams" ? renderTeamCollection(cards, ownerMap) : `
    <div class="grid">
      <section class="span-8">
        <div class="card-list">
          ${cards.map((card) => `
        <button class="card player-card card-button ${categoryClass(card.category)} ${isBlingCategory(card.category) ? "bling-card" : ""}" data-card-id="${card.id}" style="--owner:${ownerMap[card.ownerId].colour}">
          <div class="collectible-stage">
            ${imageMarkup(card)}
            <div class="card-foil"></div>
            <div class="card-border"></div>
            <span class="team-chip">${esc(card.teamCode || card.team)}</span>
            <span class="score-chip">${card.points}</span>
            <div class="nameplate">
              <strong>${esc(card.name)}</strong>
              <span>${esc(card.team)} • ${esc(ownerMap[card.ownerId].name)}</span>
            </div>
          </div>
          <div class="card-meta">
            <div class="badge-row"><span class="pill rarity-pill">${esc(card.category)}</span><span class="pill">${esc(card.position)}</span></div>
          <div>
            <div class="history">${card.history.slice(-3).map((h) => `<div><span>${h.label}</span><strong>${h.points > 0 ? "+" : ""}${h.points}</strong></div>`).join("") || `<div><span>No scoring history</span><strong>0</strong></div>`}</div>
          </div>
          </div>
        </button>`).join("")}
        </div>
      </section>
      <section class="panel span-4 card-detail-panel">
        <h2>Card detail</h2>
        ${selected ? `
          <div class="detail-collectible ${categoryClass(selected.category)} ${isBlingCategory(selected.category) ? "bling-card" : ""}">
            <div class="collectible-stage">
              ${imageMarkup(selected, "detail")}
              <div class="card-foil"></div>
              <div class="card-border"></div>
              <span class="team-chip">${esc(selected.teamCode || selected.team)}</span>
              <span class="score-chip">${selected.points}</span>
              <div class="nameplate">
                <strong>${esc(selected.name)}</strong>
                <span>${esc(selected.team)} • ${esc(ownerMap[selected.ownerId].name)}</span>
              </div>
            </div>
          </div>
          <h3>${esc(selected.name)}</h3>
          <p class="muted">${esc(ownerMap[selected.ownerId].name)} • ${esc(selected.team)} • ${esc(selected.category)} • ${esc(selected.position)}</p>
          <p class="points">${selected.points} points</p>
          <p class="muted">${imageRecordForCard(selected)?.source ? `${esc(imageRecordForCard(selected).source)} • ${esc(imageRecordForCard(selected).confidence)}` : "Placeholder image"}</p>
          <h3>Match-by-match history</h3>
          <div class="history">
            ${selected.history.map((h) => `<div><span>${h.match}: ${h.label}</span><strong>${h.points > 0 ? "+" : ""}${h.points}</strong></div>`).join("") || `<div><span>No scoring history yet</span><strong>0</strong></div>`}
          </div>
        ` : `<p class="muted">No card selected.</p>`}
      </section>
    </div>`}
    `;
  document.querySelector("#memberSelect").addEventListener("change", (event) => { state.currentMember = event.target.value; renderCollections(scored); });
  document.querySelector("#sortSelect").addEventListener("change", (event) => { state.sortCards = event.target.value; renderCollections(scored); });
  document.querySelectorAll("[data-collection-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.collectionView = button.dataset.collectionView;
      renderCollections(scored);
    });
  });
  document.querySelectorAll(".card-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCardId = button.dataset.cardId;
      renderCollections(scored);
    });
  });
}

function renderTeamCollection(cards, ownerMap) {
  const groups = teamGroupsForCards(cards);
  return `
    <section class="team-grid">
      ${groups.map((group) => {
        const ownerNames = [...new Set(group.cards.map((card) => ownerMap[card.ownerId]?.name).filter(Boolean))];
        return `
          <article class="team-card">
            <div class="team-card-hero ${categoryClass(group.hero?.category || "Base")}">
              ${group.hero ? imageMarkup(group.hero, "team") : ""}
              <div class="card-foil"></div>
              <div class="card-border"></div>
              <span class="team-chip">${esc(group.teamCode)}</span>
              <span class="score-chip">${group.points}</span>
              <div class="nameplate">
                <strong>${esc(group.team)}</strong>
                <span>${group.players.length} player${group.players.length === 1 ? "" : "s"} • ${group.crests.length} crest${group.crests.length === 1 ? "" : "s"}</span>
              </div>
            </div>
            <div class="team-card-body">
              <div class="team-card-summary">
                <div><strong>${group.cards.length}</strong><span>cards</span></div>
                <div><strong>${group.players.length}</strong><span>players</span></div>
                <div><strong>${group.points}</strong><span>points</span></div>
              </div>
              <p class="muted">${esc(ownerNames.join(", ") || "All owners")}</p>
              <div class="team-player-list">
                ${group.topCards.map((card) => `
                  <button type="button" data-open-card="${esc(card.id)}">
                    ${imageMarkup(card, "avatar")}
                    <span><strong>${esc(card.name)}</strong><small>${esc(card.category)}</small></span>
                    <b>${card.points}</b>
                  </button>`).join("")}
              </div>
            </div>
          </article>`;
      }).join("")}
    </section>`;
}

function matchPoints(scored, matchId) {
  return scored.events.filter((event) => event.matchId === matchId).reduce((sum, event) => sum + event.points, 0);
}

function renderMatches(scored) {
  const cardsByTeam = (team) => scored.cards.filter((card) => card.team === team);
  const ownerMap = byId(state.familyMembers);
  const upcoming = state.matches.filter((match) => match.status === "scheduled").slice(0, 3);
  const selectedMatch = state.matches.find((match) => match.id === state.selectedMatchId) || state.matches.find((match) => match.status === "completed");
  document.querySelector("#matches").innerHTML = `
    <div class="grid">
      <section class="panel span-8">
        <h2>Match centre</h2>
        ${["live", "scheduled", "completed"].map((status) => `
          <h3>${status[0].toUpperCase() + status.slice(1)} matches</h3>
          ${state.matches.filter((match) => match.status === status).map((match) => `
            <button class="match-row match-link ${state.selectedMatchId === match.id ? "active" : ""}" type="button" data-match-id="${esc(match.id)}" ${match.status !== "completed" ? "disabled" : ""}>
              <span class="match-status ${match.status}">${match.status}</span>
              <div>
                <strong>${match.homeTeam} ${match.homeScore ?? ""} vs ${match.awayScore ?? ""} ${match.awayTeam}</strong>
                <br><span class="muted">${fmtDate(match.kickoff)} • ${[...cardsByTeam(match.homeTeam), ...cardsByTeam(match.awayTeam)].length} cards involved</span>
                ${match.status === "completed" ? `<div class="owner-points-strip">${matchOwnerPoints(scored, match.id).map((owner) => `<span>${esc(owner.name)} <b>${owner.matchPoints > 0 ? "+" : ""}${owner.matchPoints}</b></span>`).join("") || "<span>No owner points</span>"}</div>` : ""}
              </div>
              <span class="points">${matchPoints(scored, match.id)} pts</span>
            </button>`).join("") || `<p class="muted">None.</p>`}`).join("")}
      </section>
      <section class="panel span-4 radar">
        ${selectedMatch?.status === "completed" ? renderMatchDetail(selectedMatch, scored, ownerMap) : `
        <h2>Match Radar</h2>
        ${upcoming.map((match) => {
          const involved = [...cardsByTeam(match.homeTeam), ...cardsByTeam(match.awayTeam)];
          const owners = [...new Set(involved.map((card) => byId(state.familyMembers)[card.ownerId].name))];
          const potential = involved.reduce((sum, card) => sum + (card.category === "Team Crest" ? 3 : isDefensiveInMatch(card, match) ? 4 : 3), 0);
          return `<div class="card">
            <h3>${match.homeTeam} vs ${match.awayTeam}</h3>
            <p><strong>Affected owners:</strong> ${owners.join(", ") || "None yet"}</p>
            <div class="mini-card-list">${involved.slice(0, 8).map((card) => compactCard(card, ownerMap)).join("") || "<p>No owned cards</p>"}</div>
            <p class="points">Potential fantasy points: ${potential}</p>
          </div>`;
        }).join("") || `<p class="muted">No upcoming radar matches.</p>`}`}
      </section>
    </div>`;
}

function renderMatchDetail(match, scored, ownerMap) {
  const cards = scored.cards
    .filter((card) => card.team === match.homeTeam || card.team === match.awayTeam)
    .map((card) => ({ ...card, matchPoints: cardMatchPoints(card, match.id) }))
    .sort((a, b) => b.matchPoints - a.matchPoints || a.name.localeCompare(b.name));
  const goals = (match.events || []).filter((event) => event.type === "goal");
  const yellows = (match.events || []).filter((event) => event.type === "yellow_card");
  const reds = (match.events || []).filter((event) => event.type === "red_card");
  return `
    <h2>Match detail</h2>
    <div class="match-detail-head">
      <strong>${esc(match.homeTeam)} ${match.homeScore ?? ""} vs ${match.awayScore ?? ""} ${esc(match.awayTeam)}</strong>
      <span class="muted">${fmtDate(match.kickoff)}</span>
    </div>
    <div class="team-card-summary match-summary">
      <div><strong>${goals.length}</strong><span>goals</span></div>
      <div><strong>${yellows.length}</strong><span>yellow cards</span></div>
      <div><strong>${matchPoints(scored, match.id)}</strong><span>fantasy pts</span></div>
    </div>
    <h3>Owner points</h3>
    <div class="owner-points-list">
      ${matchOwnerPoints(scored, match.id).map((owner) => `<button class="owner-score-row" type="button" data-owner-id="${esc(owner.id)}"><span>${esc(owner.name)}</span><strong>${owner.matchPoints > 0 ? "+" : ""}${owner.matchPoints}</strong></button>`).join("") || `<p class="muted">No owner points from this match.</p>`}
    </div>
    <h3>Fantasy cards involved</h3>
    <div class="match-card-list">
      ${cards.map((card) => `
        <button type="button" class="match-card-row" data-open-card="${esc(card.id)}">
          ${imageMarkup(card, "avatar")}
          <span><strong>${esc(card.name)}</strong><small>${esc(card.team)} • ${esc(ownerMap[card.ownerId]?.name || "")}</small></span>
          <b>${card.matchPoints > 0 ? "+" : ""}${card.matchPoints}</b>
        </button>`).join("")}
    </div>
    <h3>Match events</h3>
    <div class="history">
      ${(match.events || []).map((event) => `<div><span>${event.minute}' ${esc(event.team)} • ${esc(event.player || "")} ${esc(event.type.replaceAll("_", " "))}${event.assist ? ` • assist ${esc(event.assist)}` : ""}</span><strong></strong></div>`).join("") || `<div><span>No recorded events.</span><strong></strong></div>`}
    </div>`;
}

function renderStats(scored) {
  const ownerRows = scored.leaderboard.map((owner) => `<div class="stat-row"><strong>${owner.name}</strong><span class="muted">Average ${(owner.total / Math.max(1, owner.cards)).toFixed(1)} per card</span><span class="points">${owner.total}</span></div>`).join("");
  const topCards = scored.cards.toSorted((a, b) => b.points - a.points).slice(0, 8);
  const teamScores = Object.entries(scored.cards.reduce((acc, card) => {
    acc[card.team] = (acc[card.team] || 0) + card.points;
    return acc;
  }, {})).toSorted((a, b) => b[1] - a[1]);
  const crests = scored.cards.filter((card) => card.category === "Team Crest").toSorted((a, b) => b.points - a.points);
  document.querySelector("#stats").innerHTML = `
    <div class="grid">
      <section class="panel span-6"><h2>Top scoring cards</h2>${topCards.map((card) => `<div class="stat-row">${compactCard(card, byId(state.familyMembers))}<span class="muted">${esc(card.team)}</span><span class="points">${card.points}</span></div>`).join("")}</section>
      <section class="panel span-6"><h2>Top family members</h2>${ownerRows}</section>
      <section class="panel span-4"><h2>Best pulls</h2>${topCards.slice(0, 4).map((card) => `<div class="storyline award-line">${imageMarkup(card, "avatar")}<strong>${esc(card.name)}: ${card.points} points</strong></div>`).join("")}</section>
      <section class="panel span-4"><h2>Top scoring teams</h2>${teamScores.map(([team, points]) => `<div class="stat-row"><strong>${team}</strong><span></span><span class="points">${points}</span></div>`).join("")}</section>
      <section class="panel span-4"><h2>Best team crests</h2>${crests.map((card) => `<div class="stat-row"><strong>${card.name}</strong><span class="muted">${card.team}</span><span class="points">${card.points}</span></div>`).join("")}</section>
    </div>`;
}

function renderRecords(scored) {
  const topCard = scored.cards.toSorted((a, b) => b.points - a.points)[0];
  const firstGoal = scored.events.filter((e) => e.type === "goal").at(-1);
  const bestMatchCard = scored.cards.flatMap((card) => Object.entries(card.history.reduce((acc, h) => {
    acc[h.matchId] = (acc[h.matchId] || 0) + h.points;
    return acc;
  }, {})).map(([matchId, points]) => ({ card: card.name, matchId, points }))).toSorted((a, b) => b.points - a.points)[0];
  const achievements = [
    ["First Goal", Boolean(firstGoal)],
    ["First Assist", scored.events.some((e) => e.type === "assist")],
    ["Hat Trick Hero", scored.cards.some((card) => card.history.filter((h) => h.type === "goal").length >= 3)],
    ["Clean Sheet King", scored.cards.some((card) => card.history.filter((h) => h.type.includes("clean")).length >= 2)],
    ["Goal Machine", scored.cards.some((card) => card.history.filter((h) => h.type === "goal").length >= 2)],
    ["Yellow Card Magnet", scored.cards.some((card) => card.history.filter((h) => h.type === "yellow_card").length >= 2)],
    ["First Card to 10 Points", scored.cards.some((card) => card.points >= 10)],
    ["Most Valuable Card", Boolean(topCard)]
  ];
  const goalMachine = scored.cards.toSorted((a, b) => b.history.filter((h) => h.type === "goal").length - a.history.filter((h) => h.type === "goal").length)[0];
  const defensiveWall = scored.cards.filter(isDefensive).toSorted((a, b) => b.points - a.points)[0];
  const playerOfWeek = scored.cards.toSorted((a, b) => b.recent - a.recent)[0];
  const weekly = [
    { label: `Hot Streak: ${scored.leaderboard.toSorted((a, b) => b.recent - a.recent)[0]?.name || "TBC"}` },
    { label: `Goal Machine: ${goalMachine?.name || "TBC"}`, card: goalMachine },
    { label: `Defensive Wall: ${defensiveWall?.name || "TBC"}`, card: defensiveWall },
    { label: `Unluckiest Owner: ${scored.leaderboard.toSorted((a, b) => a.recent - b.recent)[0]?.name || "TBC"}` },
    { label: `Player of the Week: ${playerOfWeek?.name || "TBC"}`, card: playerOfWeek }
  ];
  document.querySelector("#records").innerHTML = `
    <div class="grid">
      <section class="panel span-4"><h2>Achievements</h2>${achievements.map(([name, unlocked]) => `<p><span class="pill">${unlocked ? "Unlocked" : "Locked"}</span> <strong>${name}</strong></p>`).join("")}</section>
      <section class="panel span-4"><h2>Weekly awards</h2>${weekly.map((item) => `<div class="storyline award-line">${item.card ? imageMarkup(item.card, "avatar") : ""}<strong>${esc(item.label)}</strong></div>`).join("")}</section>
      <section class="panel span-4"><h2>Hall of Fame</h2>
        ${topCard ? `<div class="hall-card">${imageMarkup(topCard, "avatar")}<p><strong>Highest scoring card ever:</strong> ${esc(topCard.name)} (${topCard.points})</p></div>` : "<p><strong>Highest scoring card ever:</strong> TBC</p>"}
        <p><strong>Biggest single-match card score:</strong> ${bestMatchCard?.card || "TBC"} (${bestMatchCard?.points || 0})</p>
        <p><strong>First goal:</strong> ${firstGoal?.label || "TBC"}</p>
        <p><strong>Best team crest:</strong> ${scored.cards.filter((c) => c.category === "Team Crest").toSorted((a, b) => b.points - a.points)[0]?.name || "TBC"}</p>
        <p><strong>Highest scoring match:</strong> ${state.matches.toSorted((a, b) => matchPoints(scored, b.id) - matchPoints(scored, a.id))[0]?.homeTeam || "TBC"}</p>
      </section>
    </div>`;
}

function imageSummary() {
  return state.playerImages.reduce((acc, record) => {
    acc[record.status] = (acc[record.status] || 0) + 1;
    return acc;
  }, {});
}

function renderImages() {
  const summary = imageSummary();
  const available = state.playerImages.filter((record) => record.manualOverrideUrl || record.thumbnailUrl || record.imageUrl).length;
  const records = state.playerImages
    .filter((record) => state.imageStatus === "all" || record.status === state.imageStatus)
    .slice(0, 120);
  document.querySelector("#images").innerHTML = `
    <div class="toolbar">
      <div>
        <h2>Image review</h2>
        <p class="muted">${state.playerImages.length} player image records • ${available} images available • ${summary.found || 0} accepted • ${summary.needs_review || 0} need review • ${summary.missing || 0} missing • ${summary.manual || 0} manual</p>
      </div>
      <div>
        <select id="imageStatusSelect">
          ${["all", "found", "needs_review", "missing", "manual", "rejected"].map((status) => `<option value="${status}" ${status === state.imageStatus ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <button id="rerunMissingButton" type="button">Lookup 5 missing</button>
      </div>
    </div>
    <div class="review-grid">
      ${records.map((record) => `
        <article class="panel review-card" data-image-id="${esc(record.id)}">
          <div class="review-head">
            <div class="card-image detail ${record.imageUrl || record.manualOverrideUrl ? "" : "placeholder"}">
              ${(record.manualOverrideUrl || record.thumbnailUrl || record.imageUrl) ? `<img src="${esc(record.manualOverrideUrl || record.thumbnailUrl || record.imageUrl)}" alt="${esc(record.displayName)}" loading="lazy" onerror="this.closest('.card-image').classList.add('broken'); this.remove();">` : `<span>${esc(initials(record.displayName))}</span><small>${esc(record.teamCode)}</small>`}
            </div>
            <div>
              <h3>${esc(record.displayName)}</h3>
              <p class="muted">${esc(record.teamCode)} • ${esc(record.source || "No source")} • ${esc(record.confidence)}</p>
              <p><span class="pill">${esc(record.status)}</span></p>
            </div>
          </div>
          <p class="muted">${esc(record.notes || "")}</p>
          ${record.sourcePageUrl ? `<p><a href="${esc(record.sourcePageUrl)}" target="_blank" rel="noreferrer">Source page</a></p>` : ""}
          <p class="muted">${esc(record.licence || "")} ${record.attribution ? `• ${esc(record.attribution)}` : ""}</p>
          <input class="manual-url" placeholder="Manual override image URL" value="${esc(record.manualOverrideUrl || "")}">
          <div class="button-row">
            <button data-action="accept" type="button">Accept</button>
            <button data-action="needs_review" type="button">Needs review</button>
            <button data-action="reject" type="button">Reject</button>
            <button data-action="manual" type="button">Save URL</button>
            <button data-action="clear" type="button">Clear</button>
            <button data-action="lookup" type="button">Re-run</button>
          </div>
        </article>`).join("")}
    </div>`;

  document.querySelector("#imageStatusSelect").addEventListener("change", (event) => {
    state.imageStatus = event.target.value;
    renderImages();
  });
  document.querySelector("#rerunMissingButton").addEventListener("click", async () => {
    await postJson("/api/player-images/enrich", { limit: 5, only: "missing-low", strategy: "sportsdb-only" });
    await reloadImages();
  });
  document.querySelectorAll(".review-card button").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest(".review-card");
      const id = card.dataset.imageId;
      const action = button.dataset.action;
      const manualUrl = card.querySelector(".manual-url").value.trim();
      if (action === "lookup") await postJson("/api/player-images/enrich", { id });
      if (action === "accept") await postJson("/api/player-images/update", { id, patch: { status: "found", confidence: "high", notes: "Accepted in image review." } });
      if (action === "needs_review") await postJson("/api/player-images/update", { id, patch: { status: "needs_review", notes: "Marked for review." } });
      if (action === "reject") await postJson("/api/player-images/update", { id, patch: { status: "rejected", notes: "Rejected in image review." } });
      if (action === "manual") await postJson("/api/player-images/update", { id, patch: { manualOverrideUrl: manualUrl, notes: "Manual override saved." } });
      if (action === "clear") await postJson("/api/player-images/update", { id, patch: { clearManualOverride: true, notes: "Manual override cleared." } });
      await reloadImages();
    });
  });
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function reloadImages() {
  const imageStore = await fetch("/api/player-images").then((r) => r.json());
  state.playerImages = imageStore.records || [];
  render();
}

function renderArchitecture() {
  document.querySelector("#architecture").innerHTML = `
    <section class="panel">
      <h2>Recommended architecture</h2>
      <ul class="two-col">
        <li><strong>Framework:</strong> dependency-free Node server plus vanilla frontend for this prototype; production can move to Next.js on Vercel or Render with the same scoring model.</li>
        <li><strong>Database:</strong> SQLite or Supabase Postgres. Store owners, cards, matches, raw provider payloads, normalized events, scoring rules, scoring ledger, achievements, and weekly awards.</li>
        <li><strong>Football API:</strong> Sportmonks World Cup 2026 API. It covers fixtures, livescores, in-game events, squads, player details, positions, stats, standings, and brackets. The documented World Cup league filter is <code>fixtureLeagues:732</code>.</li>
        <li><strong>Trade-off:</strong> free APIs can cover fixtures/results, but are usually thin on assists, cards, player positions, live event reliability, and tournament squad data. Sportmonks is paid, but practical and low-maintenance.</li>
        <li><strong>Import plan:</strong> place the attached JSON at <code>data/ownership.json</code>, or set <code>OWNERSHIP_FILE=/path/to/file.json</code>. Normalize family members and cards once, then manage ownership in-app later.</li>
        <li><strong>Live sync:</strong> fetch on app load, cache to <code>data/cache/matches.json</code>, and refresh every <code>LIVE_REFRESH_MS</code> while live matches exist.</li>
        <li><strong>Scoring engine:</strong> convert raw match data into normalized events, generate an append-only fantasy ledger, and derive totals from that ledger so rules can be changed and recalculated.</li>
        <li><strong>Deployment:</strong> Render/Fly/Hetzner for the server, or Vercel plus Supabase and scheduled cron. Keep the API token server-side.</li>
      </ul>
      <h2>Database schema</h2>
      <table class="table">
        <thead><tr><th>Table</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>owners</td><td>Family member profile and display colour.</td></tr>
          <tr><td>cards</td><td>Card identity, owner, category, team, player name, position.</td></tr>
          <tr><td>matches</td><td>Fixture, teams, kickoff, status, score, provider id.</td></tr>
          <tr><td>match_events</td><td>Normalized goals, assists, cards, final result, clean-sheet facts.</td></tr>
          <tr><td>raw_api_cache</td><td>Provider payload, fetched timestamp, endpoint key, expiry.</td></tr>
          <tr><td>scoring_rules</td><td>Versioned scoring values.</td></tr>
          <tr><td>fantasy_ledger</td><td>Card, owner, match, event, rule version, points.</td></tr>
          <tr><td>player_images</td><td>Canonical player/team image records, source metadata, confidence, status, manual override URL, review notes.</td></tr>
          <tr><td>achievements</td><td>Unlock definitions and unlock records.</td></tr>
          <tr><td>weekly_awards</td><td>Generated weekly award snapshots.</td></tr>
        </tbody>
      </table>
      <h2>MVP implementation plan</h2>
      <ol>
        <li>Import ownership JSON and validate card names, teams, positions, and owners.</li>
        <li>Enable Sportmonks token and verify World Cup fixture/event mapping.</li>
        <li>Persist normalized events and scoring ledger in SQLite or Supabase.</li>
        <li>Add admin-only ownership edits and card search.</li>
        <li>Run scheduled sync during match windows and nightly recalculation.</li>
      </ol>
      <h2>Future roadmap</h2>
      <p>Add child-friendly card art, notification pings, in-app trades, private login, finals bracket view, player photos, team filters, historical rule versions, and shareable weekly recap images.</p>
    </section>`;
}

function renderCardOverlay(scored) {
  let overlay = document.querySelector("#cardOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "cardOverlay";
    document.body.appendChild(overlay);
  }
  if (!state.overlayCardId) {
    overlay.className = "card-overlay";
    overlay.innerHTML = "";
    return;
  }
  const ownerMap = byId(state.familyMembers);
  const card = scored.cards.find((item) => item.id === state.overlayCardId);
  if (!card) return closeCardOverlay();
  overlay.className = "card-overlay active";
  overlay.innerHTML = `
    <div class="overlay-backdrop" data-close-overlay="true"></div>
    <section class="overlay-panel" role="dialog" aria-modal="true" aria-label="${esc(card.name)} card detail">
      <div class="detail-collectible ${categoryClass(card.category)} ${isBlingCategory(card.category) ? "bling-card" : ""}">
        <div class="collectible-stage">
          ${imageMarkup(card, "detail")}
          <div class="card-foil"></div>
          <div class="card-border"></div>
          <span class="team-chip">${esc(card.teamCode || card.team)}</span>
          <span class="score-chip">${card.points}</span>
          <div class="nameplate">
            <strong>${esc(card.name)}</strong>
            <span>${esc(card.team)} • ${esc(ownerMap[card.ownerId]?.name || "")}</span>
          </div>
        </div>
      </div>
      <h2>${esc(card.name)}</h2>
      <p class="muted">${esc(ownerMap[card.ownerId]?.name || "")} • ${esc(card.team)} • ${esc(card.category)} • ${esc(card.position)}</p>
      <p class="points">${card.points} points</p>
      <div class="history">
        ${card.history.map((h) => `<div><span>${esc(h.match)}: ${esc(h.label)}</span><strong>${h.points > 0 ? "+" : ""}${h.points}</strong></div>`).join("") || `<div><span>No scoring history yet</span><strong>0</strong></div>`}
      </div>
    </section>`;
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    activateView(button.dataset.view);
  });
});

document.addEventListener("click", (event) => {
  const ownerButton = event.target.closest("[data-owner-id]");
  if (ownerButton?.dataset.ownerId) {
    event.preventDefault();
    openOwnerCollection(ownerButton.dataset.ownerId);
    return;
  }
  const homeButton = event.target.closest("[data-home-view]");
  if (homeButton?.dataset.homeView) {
    event.preventDefault();
    activateView(homeButton.dataset.homeView);
    return;
  }
  const cardButton = event.target.closest("[data-open-card]");
  if (cardButton?.dataset.openCard) {
    event.preventDefault();
    openCardOverlay(cardButton.dataset.openCard);
    return;
  }
  const matchButton = event.target.closest("[data-match-id]");
  if (matchButton?.dataset.matchId) {
    event.preventDefault();
    state.selectedMatchId = matchButton.dataset.matchId;
    renderMatches(scoreTournament());
    return;
  }
  if (event.target.closest("[data-close-overlay]")) {
    event.preventDefault();
    closeCardOverlay();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.overlayCardId) closeCardOverlay();
});

document.querySelector("#syncButton").addEventListener("click", async () => {
  document.querySelector("#syncButton").textContent = "Syncing";
  await loadData(true);
  document.querySelector("#syncButton").textContent = "Sync";
});

loadData();
