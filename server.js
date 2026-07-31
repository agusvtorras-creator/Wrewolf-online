/**
 * WEREWOLF ONLINE — server.js
 * Node.js + Express + Socket.io real-time backend.
 *
 * Run: npm install && npm start
 * Then open http://localhost:3000 (or your Render/Replit URL) on multiple
 * devices. One player creates a room (host), everyone else joins with the code.
 *
 * All game state lives in memory (the `rooms` object below). That's enough
 * for a free single-instance deploy (Render/Replit/Glitch). If you need it to
 * survive restarts or scale to multiple server instances, swap the `rooms`
 * object for Redis/Firebase — the socket event contracts stay the same.
 *
 * ROLES: werewolf, villager, seer, witch, hunter, cupid, minion, mason,
 * robber, troublemaker, drunk, insomniac, tanner, medic.
 *
 * IDENTITY & RECONNECTION
 * ------------------------
 * Every player has a stable `id` (a client-generated UUID persisted in the
 * browser's localStorage) that survives page reloads and dropped connections.
 * `socketId` is the CURRENT live Socket.io connection and changes every time
 * the browser reconnects. All game logic (votes, targets, lovers, host,
 * pending hunter, etc.) references the stable `id`, never `socketId` — so a
 * player who briefly loses signal keeps their seat, their role, and their
 * place in the vote count. On disconnect we start a grace period (see
 * DISCONNECT_GRACE_MS) before actually removing someone from the game.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/** @type {Object<string, Room>} */
const rooms = {};

const DEFAULT_SETTINGS = {
  werewolves: 1,
  seer: true,
  witch: true,
  hunter: true,
  cupid: false,
  minion: false,
  masons: false, // adds a PAIR of masons
  robber: false,
  troublemaker: false,
  drunk: false,
  insomniac: false,
  tanner: false,
  medic: false,
  discussionSeconds: 90, // 0 = disabled
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 20;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no O/I to avoid confusion
const DISCONNECT_GRACE_MS = 90 * 1000; // how long a dropped player can reconnect
const ROLE_REVEAL_MAX_MS = 60 * 1000; // safety-net timeout if not everyone clicks "Ready"

function genCode(len = 5) {
  let code;
  do {
    code = '';
    for (let i = 0; i < len; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms[code]);
  return code;
}

function makeRoom(code, hostId) {
  return {
    code,
    hostId, // stable player id, NOT a socket id
    players: [], // {id (stable), socketId (live), name, alive, role, connected, disconnectTimer, ...}
    settings: { ...DEFAULT_SETTINGS },
    phase: 'lobby', // lobby -> reveal -> night -> day-announce -> day-discuss -> day-vote -> day-result -> gameover
    nightNumber: 0,
    night: freshNight(),
    dayVotes: {}, // voterId -> targetId (both stable ids)
    lovers: [], // [id, id]
    centerCards: [], // hidden roles not assigned to any player (used by Drunk)
    lastMedicTarget: null, // enforce "can't protect the same person twice in a row"
    witchPotions: { healUsed: false, poisonUsed: false }, // persists for the WHOLE game
    readyPlayers: new Set(), // stable ids who clicked "Ready" during role reveal
    lastAnnouncement: null, // for reconnect catch-up
    lastVoteResult: null, // for reconnect catch-up
    lastGameOver: null, // for reconnect catch-up
    log: [],
    timer: null, // active setTimeout handle
    timerEndsAt: null,
    pendingHunter: null, // stable player id awaiting hunter-shot resolution
    afterHunterPhase: null, // phase to continue to once hunter resolves
  };
}

function freshNight() {
  return {
    wolfVotes: {}, // wolfId -> targetId
    wolfTarget: null,
    seerTarget: null,
    seerResult: null,
    witchHeal: false, // this night's choice only
    witchPoisonTarget: null, // this night's choice only
    medicTarget: null,
    cupidDone: false,
    stepOrder: [],
    stepIndex: 0,
    step: 'resolve',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRoom(code) {
  return code ? rooms[(code || '').toUpperCase()] : undefined;
}

function publicPlayers(room) {
  return room.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isHost: p.id === room.hostId,
    connected: p.connected,
    // role only exposed once game is over or to the player themself (handled elsewhere)
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    players: publicPlayers(room),
    hostId: room.hostId,
    nightNumber: room.nightNumber,
  });
}

function alivePlayers(room) {
  return room.players.filter((p) => p.alive);
}

function aliveWolves(room) {
  return alivePlayers(room).filter((p) => p.role === 'werewolf');
}

function aliveVillageTeam(room) {
  return alivePlayers(room).filter((p) => p.role !== 'werewolf');
}

function findPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function alivePlayerWithRole(room, role) {
  return room.players.find((p) => p.role === role && p.alive);
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
    room.timerEndsAt = null;
  }
}

function log(room, message) {
  room.log.push({ t: Date.now(), message });
}

/** Emit an event to a single player's CURRENT live socket, if they're connected. */
function toPlayer(player, event, payload) {
  if (player && player.socketId) io.to(player.socketId).emit(event, payload);
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function assignRoles(room) {
  const n = room.players.length;
  const s = room.settings;
  const roles = [];

  const wolfCount = Math.max(1, Math.min(s.werewolves, Math.floor(n / 2) || 1));
  for (let i = 0; i < wolfCount; i++) roles.push('werewolf');
  if (s.seer) roles.push('seer');
  if (s.witch) roles.push('witch');
  if (s.hunter) roles.push('hunter');
  if (s.cupid) roles.push('cupid');
  if (s.minion) roles.push('minion');
  if (s.masons) roles.push('mason', 'mason');
  if (s.robber) roles.push('robber');
  if (s.troublemaker) roles.push('troublemaker');
  if (s.drunk) roles.push('drunk');
  if (s.insomniac) roles.push('insomniac');
  if (s.tanner) roles.push('tanner');
  if (s.medic) roles.push('medic');
  while (roles.length < n) roles.push('villager');

  const shuffled = shuffle(roles).slice(0, n);
  const order = shuffle(room.players);
  order.forEach((p, i) => {
    p.role = shuffled[i];
    p.alive = true;
    p.diedAt = null;
    p.diedPhase = null;
    p.hunterFired = false;
  });

  // Center cards: only relevant if Drunk is in play. A fixed, simple pair
  // (one villager, one werewolf) gives Drunk real tension without needing
  // to touch a real player's role.
  room.centerCards = s.drunk ? shuffle(['villager', 'werewolf']) : [];
  room.lastMedicTarget = null;
  room.witchPotions = { healUsed: false, poisonUsed: false };
}

const ROLE_INFO = {
  werewolf: {
    team: 'werewolves',
    label: 'Werewolf',
    instructions: 'Each night, vote with your fellow werewolves to devour a villager. During the day, blend in and avoid suspicion.',
  },
  villager: {
    team: 'villagers',
    label: 'Villager',
    instructions: 'You have no special powers. Use discussion and deduction during the day to find and vote out the werewolves.',
  },
  seer: {
    team: 'villagers',
    label: 'Seer',
    instructions: 'Each night, choose one player to secretly inspect. You will learn whether they are a Werewolf or a Villager.',
  },
  witch: {
    team: 'villagers',
    label: 'Witch',
    instructions: 'You have one healing potion and one poison potion for the whole game (not per night). Each night you see the werewolves\u2019 victim and may save them, and/or poison someone else.',
  },
  hunter: {
    team: 'villagers',
    label: 'Hunter',
    instructions: 'If you die (night or day), you get to fire one shot and take another player down with you.',
  },
  cupid: {
    team: 'villagers',
    label: 'Cupid',
    instructions: 'On the first night, choose two players to fall in love. If one lover dies, the other dies of heartbreak.',
  },
  minion: {
    team: 'werewolves',
    label: 'Minion',
    instructions: 'You are on the werewolves\u2019 team and you know who they are — but they don\u2019t know you. You can\u2019t be killed at night by the wolves. Mislead the village to protect your team.',
  },
  mason: {
    team: 'villagers',
    label: 'Mason',
    instructions: 'You know your fellow Mason(s). You have no night action beyond knowing each other — use that trust to help the village during the day.',
  },
  robber: {
    team: 'villagers',
    label: 'Robber',
    instructions: 'On the first night only, you may swap roles with another player and secretly look at your new role. You become whatever you stole.',
  },
  troublemaker: {
    team: 'villagers',
    label: 'Troublemaker',
    instructions: 'On the first night only, you may swap the roles of two OTHER players, without seeing what either of them becomes.',
  },
  drunk: {
    team: 'villagers',
    label: 'Drunk',
    instructions: 'On the first night only, you swap your role with a hidden card, without knowing what you become. Play cautiously — you might not be who you think you are.',
  },
  insomniac: {
    team: 'villagers',
    label: 'Insomniac',
    instructions: 'On the first night, after the shuffling is done, you wake up and check your OWN current role, in case it changed.',
  },
  tanner: {
    team: 'independent',
    label: 'Tanner',
    instructions: 'You want to die! You win alone if the village votes to eliminate you during the day (not if you die at night).',
  },
  medic: {
    team: 'villagers',
    label: 'Medic',
    instructions: 'Each night, choose one player to protect from the werewolves. You cannot protect the same person on two nights in a row.',
  },
};

function roleRevealPayloadFor(room, p) {
  const info = ROLE_INFO[p.role];
  const wolfTeammates =
    p.role === 'werewolf'
      ? room.players.filter((o) => o.role === 'werewolf' && o.id !== p.id).map((o) => o.name)
      : undefined;
  const werewolfNames =
    p.role === 'minion'
      ? room.players.filter((o) => o.role === 'werewolf').map((o) => o.name)
      : undefined;
  const masonTeammates =
    p.role === 'mason'
      ? room.players.filter((o) => o.role === 'mason' && o.id !== p.id).map((o) => o.name)
      : undefined;
  return {
    role: p.role,
    team: info.team,
    label: info.label,
    instructions: info.instructions,
    wolfTeammates,
    werewolfNames,
    masonTeammates,
  };
}

function roleReveal(room) {
  room.players.forEach((p) => {
    toPlayer(p, 'roleAssigned', roleRevealPayloadFor(room, p));
  });
}

// ---------------------------------------------------------------------------
// Night step engine
// ---------------------------------------------------------------------------

function computeNightSteps(room) {
  const isNight1 = room.nightNumber === 1;
  const has = (role) => alivePlayerWithRole(room, role);
  const steps = [];
  if (isNight1 && has('cupid')) steps.push('cupid');
  if (isNight1 && has('robber')) steps.push('robber');
  if (isNight1 && has('troublemaker')) steps.push('troublemaker');
  if (isNight1 && has('drunk')) steps.push('drunk');
  if (isNight1 && has('insomniac')) steps.push('insomniac');
  steps.push('wolves');
  if (has('seer')) steps.push('seer');
  if (has('medic')) steps.push('medic');
  if (has('witch')) steps.push('witch');
  steps.push('resolve');
  return steps;
}

/** True if the current night step can never be completed (its sole actor
 * disconnected-and-was-removed, or similar), meaning we should skip past it. */
function isStepStuck(room) {
  if (room.phase !== 'night') return false;
  const soloStepRole = {
    cupid: 'cupid', robber: 'robber', troublemaker: 'troublemaker', drunk: 'drunk',
    insomniac: 'insomniac', seer: 'seer', medic: 'medic', witch: 'witch',
  }[room.night.step];
  if (soloStepRole) return !alivePlayerWithRole(room, soloStepRole);
  if (room.night.step === 'wolves') return aliveWolves(room).length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Phase transitions
// ---------------------------------------------------------------------------

function startGame(room) {
  assignRoles(room);
  room.phase = 'reveal';
  room.nightNumber = 0;
  room.lovers = [];
  room.log = [];
  room.readyPlayers = new Set();
  broadcastRoom(room);
  roleReveal(room);
  // Safety net only — normally everyone clicks "Ready" and we advance sooner.
  clearTimer(room);
  room.timer = setTimeout(() => beginNight(room), ROLE_REVEAL_MAX_MS);
  room.timerEndsAt = Date.now() + ROLE_REVEAL_MAX_MS;
}

function beginNight(room) {
  clearTimer(room);
  room.nightNumber += 1;
  room.night = freshNight();
  room.phase = 'night';
  room.night.stepOrder = computeNightSteps(room);
  room.night.stepIndex = 0;
  room.night.step = room.night.stepOrder[0];

  broadcastRoom(room);
  emitNightState(room);
}

function nightStatePayloadFor(room, p) {
  const n = room.night;
  if (!p.alive) {
    return { step: n.step, youAre: p.role, alive: false };
  }
  const payload = { step: n.step, youAre: p.role, alive: true };

  if (n.step === 'cupid' && p.role === 'cupid') {
    payload.action = 'cupid';
    payload.options = room.players.filter((o) => o.alive).map((o) => ({ id: o.id, name: o.name }));
  } else if (n.step === 'robber' && p.role === 'robber') {
    payload.action = 'robber';
    payload.options = alivePlayers(room).filter((o) => o.id !== p.id).map((o) => ({ id: o.id, name: o.name }));
  } else if (n.step === 'troublemaker' && p.role === 'troublemaker') {
    payload.action = 'troublemaker';
    payload.options = alivePlayers(room).filter((o) => o.id !== p.id).map((o) => ({ id: o.id, name: o.name }));
  } else if (n.step === 'drunk' && p.role === 'drunk') {
    payload.action = 'drunk';
  } else if (n.step === 'insomniac' && p.role === 'insomniac') {
    payload.action = 'insomniac';
    payload.currentRole = ROLE_INFO[p.role].label;
  } else if (n.step === 'wolves' && p.role === 'werewolf') {
    payload.action = 'wolves';
    payload.options = alivePlayers(room)
      .filter((o) => o.role !== 'werewolf')
      .map((o) => ({ id: o.id, name: o.name }));
    payload.wolfVotes = n.wolfVotes;
    payload.wolfTeam = aliveWolves(room).map((w) => w.name);
  } else if (n.step === 'seer' && p.role === 'seer') {
    payload.action = 'seer';
    payload.options = alivePlayers(room).filter((o) => o.id !== p.id).map((o) => ({ id: o.id, name: o.name }));
    payload.lastResult = n.seerResult;
  } else if (n.step === 'medic' && p.role === 'medic') {
    payload.action = 'medic';
    payload.options = alivePlayers(room)
      .filter((o) => o.id !== room.lastMedicTarget)
      .map((o) => ({ id: o.id, name: o.name }));
  } else if (n.step === 'witch' && p.role === 'witch') {
    payload.action = 'witch';
    payload.wolfTargetName = n.wolfTarget ? findPlayer(room, n.wolfTarget)?.name : null;
    payload.canHeal = !room.witchPotions.healUsed;
    payload.canPoison = !room.witchPotions.poisonUsed;
    payload.poisonOptions = alivePlayers(room)
      .filter((o) => o.id !== p.id)
      .map((o) => ({ id: o.id, name: o.name }));
  } else {
    payload.action = 'wait';
  }
  return payload;
}

function emitNightState(room) {
  room.players.forEach((p) => {
    toPlayer(p, 'nightState', nightStatePayloadFor(room, p));
  });
}

function advanceNightStep(room) {
  const n = room.night;
  n.stepIndex += 1;
  n.step = n.stepOrder[n.stepIndex] || 'resolve';
  while (n.step !== 'resolve' && isStepStuck(room)) {
    n.stepIndex += 1;
    n.step = n.stepOrder[n.stepIndex] || 'resolve';
  }
  if (n.step === 'resolve') {
    resolveNight(room);
    return;
  }
  emitNightState(room);
}

function resolveNight(room) {
  const n = room.night;
  const deaths = new Set();

  const wolfKilled = n.wolfTarget && !n.witchHeal && n.wolfTarget !== n.medicTarget;
  if (wolfKilled) deaths.add(n.wolfTarget);
  if (n.witchPoisonTarget) deaths.add(n.witchPoisonTarget);

  // Minions are on the werewolves' team and can't be killed by their own pack.
  [...deaths].forEach((id) => {
    const p = findPlayer(room, id);
    if (p && p.role === 'minion' && id === n.wolfTarget) deaths.delete(id);
  });

  // lovers heartbreak chain
  applyLoverDeaths(room, deaths);

  const deathList = [...deaths]
    .map((id) => findPlayer(room, id))
    .filter((p) => p && p.alive);

  deathList.forEach((p) => {
    p.alive = false;
    p.diedAt = room.nightNumber;
    p.diedPhase = 'night';
  });

  log(room, `Night ${room.nightNumber}: ${deathList.length ? deathList.map((p) => p.name).join(', ') + ' died.' : 'nobody died.'}`);

  room.phase = 'day-announce';
  room.lastAnnouncement = {
    nightNumber: room.nightNumber,
    deaths: deathList.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  };
  broadcastRoom(room);
  io.to(room.code).emit('dayAnnouncement', room.lastAnnouncement);

  // hunter chain-check
  const hunterDied = deathList.find((p) => p.role === 'hunter' && !p.hunterFired);
  if (hunterDied) {
    triggerHunter(room, hunterDied, 'day-discuss');
    return;
  }

  if (checkWin(room)) return;
  goToDiscussion(room);
}

function applyLoverDeaths(room, deaths) {
  if (room.lovers.length !== 2) return;
  const [a, b] = room.lovers;
  if (deaths.has(a)) {
    const bp = findPlayer(room, b);
    if (bp && bp.alive) deaths.add(b);
  }
  if (deaths.has(b)) {
    const ap = findPlayer(room, a);
    if (ap && ap.alive) deaths.add(a);
  }
}

function triggerHunter(room, hunterPlayer, nextPhase) {
  room.pendingHunter = hunterPlayer.id;
  room.afterHunterPhase = nextPhase;
  room.phase = 'hunter-shot';
  broadcastRoom(room);
  toPlayer(hunterPlayer, 'hunterPrompt', {
    options: alivePlayers(room).filter((o) => o.id !== hunterPlayer.id).map((o) => ({ id: o.id, name: o.name })),
  });
  io.to(room.code).emit('phaseNote', { message: `${hunterPlayer.name} was the Hunter and is choosing a final target...` });
}

function goToDiscussion(room) {
  room.phase = 'day-discuss';
  room.dayVotes = {};
  broadcastRoom(room);
  const secs = room.settings.discussionSeconds;
  if (secs && secs > 0) {
    room.timerEndsAt = Date.now() + secs * 1000;
    io.to(room.code).emit('discussionStarted', { endsAt: room.timerEndsAt });
    clearTimer(room);
    room.timer = setTimeout(() => goToVote(room), secs * 1000);
  } else {
    room.timerEndsAt = null;
    io.to(room.code).emit('discussionStarted', { endsAt: null });
  }
}

function goToVote(room) {
  clearTimer(room);
  room.phase = 'day-vote';
  room.dayVotes = {};
  broadcastRoom(room);
  io.to(room.code).emit('voteStarted', {
    options: alivePlayers(room).map((p) => ({ id: p.id, name: p.name })),
  });
}

function tallyVotes(room) {
  const counts = {};
  Object.values(room.dayVotes).forEach((targetId) => {
    counts[targetId] = (counts[targetId] || 0) + 1;
  });
  return counts;
}

function maybeResolveVotes(room) {
  const alive = alivePlayers(room);
  const votesIn = Object.keys(room.dayVotes).length;
  if (votesIn >= alive.length) resolveVotes(room);
}

function resolveVotes(room) {
  clearTimer(room);
  const counts = tallyVotes(room);
  let max = -1;
  let leaders = [];
  Object.entries(counts).forEach(([id, c]) => {
    if (c > max) {
      max = c;
      leaders = [id];
    } else if (c === max) {
      leaders.push(id);
    }
  });

  let eliminatedId = null;
  if (leaders.length === 1 && max > 0) eliminatedId = leaders[0];

  room.phase = 'day-result';
  const eliminated = eliminatedId ? findPlayer(room, eliminatedId) : null;

  // Tanner: wins alone, immediately, if lynched by day vote (not via hunter
  // chain or lover heartbreak, and never from a night death).
  if (eliminated && eliminated.role === 'tanner') {
    eliminated.alive = false;
    eliminated.diedAt = room.nightNumber;
    eliminated.diedPhase = 'day';
    log(room, `Day ${room.nightNumber}: the village lynched ${eliminated.name} — the Tanner!`);
    room.lastVoteResult = {
      counts,
      tie: false,
      eliminated: [{ id: eliminated.id, name: eliminated.name, role: eliminated.role }],
    };
    broadcastRoom(room);
    io.to(room.code).emit('voteResult', room.lastVoteResult);
    room.phase = 'gameover';
    clearTimer(room);
    room.lastGameOver = {
      winner: 'tanner',
      winnerName: eliminated.name,
      players: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, alive: p.alive })),
    };
    io.to(room.code).emit('gameOver', room.lastGameOver);
    broadcastRoom(room);
    return;
  }

  const deaths = new Set();
  if (eliminated) deaths.add(eliminated.id);
  applyLoverDeaths(room, deaths);
  const deathList = [...deaths].map((id) => findPlayer(room, id)).filter((p) => p && p.alive);
  deathList.forEach((p) => {
    p.alive = false;
    p.diedAt = room.nightNumber;
    p.diedPhase = 'day';
  });

  log(room, `Day ${room.nightNumber}: vote result — ${deathList.length ? deathList.map((p) => p.name).join(', ') + ' eliminated.' : 'no one eliminated (tie).'}`);

  room.lastVoteResult = {
    counts,
    tie: leaders.length > 1,
    eliminated: deathList.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  };
  broadcastRoom(room);
  io.to(room.code).emit('voteResult', room.lastVoteResult);

  const hunterDied = deathList.find((p) => p.role === 'hunter' && !p.hunterFired);
  if (hunterDied) {
    triggerHunter(room, hunterDied, 'next-night');
    return;
  }

  if (checkWin(room)) return;

  clearTimer(room);
  room.timer = setTimeout(() => beginNight(room), 5000);
}

function checkWin(room) {
  const wolves = aliveWolves(room).length;
  const others = aliveVillageTeam(room).length;

  let winner = null;
  if (wolves === 0) winner = 'villagers';
  else if (wolves >= others) winner = 'werewolves';

  if (winner) {
    room.phase = 'gameover';
    clearTimer(room);
    room.lastGameOver = {
      winner,
      players: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, alive: p.alive })),
    };
    io.to(room.code).emit('gameOver', room.lastGameOver);
    broadcastRoom(room);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Reconnection catch-up: re-sends whatever the reconnecting player's screen
// should currently show, based on the room's phase.
// ---------------------------------------------------------------------------

function sendCatchUp(room, player) {
  broadcastRoom(room);

  if (room.phase === 'lobby') return;

  if (player.role) {
    toPlayer(player, 'roleAssigned', roleRevealPayloadFor(room, player));
  }

  if (room.phase === 'reveal') {
    toPlayer(player, 'revealReadyUpdate', { ready: room.readyPlayers.size, total: alivePlayers(room).length });
  } else if (room.phase === 'night') {
    toPlayer(player, 'nightState', nightStatePayloadFor(room, player));
  } else if (room.phase === 'hunter-shot') {
    if (room.pendingHunter === player.id) {
      toPlayer(player, 'hunterPrompt', {
        options: alivePlayers(room).filter((o) => o.id !== player.id).map((o) => ({ id: o.id, name: o.name })),
      });
    }
  } else if (room.phase === 'day-announce') {
    if (room.lastAnnouncement) toPlayer(player, 'dayAnnouncement', room.lastAnnouncement);
  } else if (room.phase === 'day-discuss') {
    toPlayer(player, 'discussionStarted', { endsAt: room.timerEndsAt || null });
  } else if (room.phase === 'day-vote') {
    toPlayer(player, 'voteStarted', { options: alivePlayers(room).map((o) => ({ id: o.id, name: o.name })) });
    toPlayer(player, 'voteTally', { counts: tallyVotes(room), votesIn: Object.keys(room.dayVotes).length, totalAlive: alivePlayers(room).length });
  } else if (room.phase === 'day-result') {
    if (room.lastVoteResult) toPlayer(player, 'voteResult', room.lastVoteResult);
  } else if (room.phase === 'gameover') {
    if (room.lastGameOver) toPlayer(player, 'gameOver', room.lastGameOver);
  }
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, clientId }, ack) => {
    name = (name || '').trim().slice(0, 20) || 'Host';
    if (!clientId) return ack && ack({ success: false, error: 'Missing client id.' });
    const code = genCode();
    const room = makeRoom(code, clientId);
    room.players.push({ id: clientId, socketId: socket.id, name, alive: true, role: null, connected: true, disconnectTimer: null });
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.pid = clientId;
    ack && ack({ success: true, code, hostId: clientId });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ name, code, clientId }, ack) => {
    const room = getRoom(code);
    name = (name || '').trim().slice(0, 20);
    if (!clientId) return ack && ack({ success: false, error: 'Missing client id.' });
    if (!room) return ack && ack({ success: false, error: 'Room code not found.' });
    if (room.phase !== 'lobby') return ack && ack({ success: false, error: 'Game already in progress.' });
    if (room.players.length >= MAX_PLAYERS) return ack && ack({ success: false, error: 'Room is full.' });
    if (!name) return ack && ack({ success: false, error: 'Please enter a name.' });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return ack && ack({ success: false, error: 'That name is already taken in this room.' });
    }
    room.players.push({ id: clientId, socketId: socket.id, name, alive: true, role: null, connected: true, disconnectTimer: null });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.pid = clientId;
    ack && ack({ success: true, code: room.code, hostId: room.hostId });
    broadcastRoom(room);
  });

  // Reattach a returning browser (reload, dropped wifi, backgrounded tab) to
  // its existing seat, without losing role/votes/game progress.
  socket.on('rejoinRoom', ({ code, clientId }, ack) => {
    const room = getRoom(code);
    if (!room || !clientId) return ack && ack({ success: false, error: 'Room not found.' });
    const player = findPlayer(room, clientId);
    if (!player) return ack && ack({ success: false, error: 'You are not part of this room.' });

    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    player.socketId = socket.id;
    player.connected = true;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.pid = clientId;

    ack && ack({ success: true, code: room.code, hostId: room.hostId, phase: room.phase, name: player.name });
    sendCatchUp(room, player);
  });

  socket.on('updateSettings', ({ code, settings }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.data.pid || room.phase !== 'lobby') return;
    room.settings = {
      werewolves: Math.max(1, Math.min(8, parseInt(settings.werewolves) || 1)),
      seer: !!settings.seer,
      witch: !!settings.witch,
      hunter: !!settings.hunter,
      cupid: !!settings.cupid,
      minion: !!settings.minion,
      masons: !!settings.masons,
      robber: !!settings.robber,
      troublemaker: !!settings.troublemaker,
      drunk: !!settings.drunk,
      insomniac: !!settings.insomniac,
      tanner: !!settings.tanner,
      medic: !!settings.medic,
      discussionSeconds: [0, 60, 90, 120, 180].includes(parseInt(settings.discussionSeconds))
        ? parseInt(settings.discussionSeconds)
        : 90,
    };
    broadcastRoom(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.data.pid || room.phase !== 'lobby') return;
    if (room.players.length < MIN_PLAYERS) return;
    startGame(room);
  });

  // ---- Role reveal ----
  socket.on('roleReady', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'reveal') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me) return;
    room.readyPlayers.add(me.id);
    const total = alivePlayers(room).length;
    io.to(room.code).emit('revealReadyUpdate', { ready: room.readyPlayers.size, total });
    if (room.readyPlayers.size >= total) {
      beginNight(room);
    }
  });

  // ---- Night actions ----

  socket.on('cupidChoose', ({ code, targets }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'cupid') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'cupid' || !me.alive) return;
    if (!Array.isArray(targets) || targets.length !== 2) return;
    room.lovers = targets;
    room.night.cupidDone = true;
    const p1 = findPlayer(room, targets[0]);
    const p2 = findPlayer(room, targets[1]);
    toPlayer(p1, 'loversRevealed', { partnerId: targets[1], partnerName: p2?.name });
    toPlayer(p2, 'loversRevealed', { partnerId: targets[0], partnerName: p1?.name });
    advanceNightStep(room);
  });

  socket.on('robberSwap', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'robber') return;
    const me = findPlayer(room, socket.data.pid);
    const target = findPlayer(room, targetId);
    if (!me || me.role !== 'robber' || !me.alive || !target || target.id === me.id || !target.alive) return;
    const temp = me.role;
    me.role = target.role;
    target.role = temp;
    const info = ROLE_INFO[me.role];
    toPlayer(me, 'roleUpdated', { role: me.role, label: info.label, team: info.team, instructions: info.instructions });
    advanceNightStep(room);
  });

  socket.on('troublemakerSwap', ({ code, targetAId, targetBId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'troublemaker') return;
    const me = findPlayer(room, socket.data.pid);
    const a = findPlayer(room, targetAId);
    const b = findPlayer(room, targetBId);
    if (!me || me.role !== 'troublemaker' || !me.alive) return;
    if (!a || !b || a.id === b.id || a.id === me.id || b.id === me.id || !a.alive || !b.alive) return;
    const temp = a.role;
    a.role = b.role;
    b.role = temp;
    advanceNightStep(room);
  });

  socket.on('drunkSwap', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'drunk') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'drunk' || !me.alive) return;
    if (room.centerCards.length > 0) {
      const idx = Math.floor(Math.random() * room.centerCards.length);
      const newRole = room.centerCards[idx];
      room.centerCards[idx] = me.role;
      me.role = newRole;
    }
    advanceNightStep(room);
  });

  socket.on('insomniacDone', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'insomniac') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'insomniac' || !me.alive) return;
    advanceNightStep(room);
  });

  socket.on('wolfVote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'wolves') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'werewolf' || !me.alive) return;
    room.night.wolfVotes[me.id] = targetId;

    // broadcast live tally to wolves
    aliveWolves(room).forEach((w) => toPlayer(w, 'wolfVoteUpdate', { wolfVotes: room.night.wolfVotes }));

    const wolves = aliveWolves(room);
    if (Object.keys(room.night.wolfVotes).length >= wolves.length) {
      // resolve majority target among wolves
      const counts = {};
      Object.values(room.night.wolfVotes).forEach((t) => (counts[t] = (counts[t] || 0) + 1));
      let max = -1, target = null;
      Object.entries(counts).forEach(([id, c]) => {
        if (c > max) { max = c; target = id; }
      });
      room.night.wolfTarget = target;
      advanceNightStep(room);
    }
  });

  socket.on('seerInspect', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'seer') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'seer' || !me.alive) return;
    const target = findPlayer(room, targetId);
    if (!target) return;
    const result = target.role === 'werewolf' ? 'werewolf' : 'villager';
    room.night.seerTarget = targetId;
    room.night.seerResult = { name: target.name, result };
    toPlayer(me, 'seerResult', room.night.seerResult);
    advanceNightStep(room);
  });

  socket.on('medicProtect', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'medic') return;
    const me = findPlayer(room, socket.data.pid);
    const target = findPlayer(room, targetId);
    if (!me || me.role !== 'medic' || !me.alive || !target || !target.alive) return;
    if (targetId === room.lastMedicTarget) return; // can't repeat
    room.night.medicTarget = targetId;
    room.lastMedicTarget = targetId;
    advanceNightStep(room);
  });

  socket.on('witchAction', ({ code, heal, poisonTargetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'witch') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || me.role !== 'witch' || !me.alive) return;
    if (heal && !room.witchPotions.healUsed) {
      room.night.witchHeal = true;
      room.witchPotions.healUsed = true;
    }
    if (poisonTargetId && !room.witchPotions.poisonUsed) {
      room.night.witchPoisonTarget = poisonTargetId;
      room.witchPotions.poisonUsed = true;
    }
    advanceNightStep(room);
  });

  // ---- Hunter ----
  socket.on('hunterShoot', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'hunter-shot' || room.pendingHunter !== socket.data.pid) return;
    const hunter = findPlayer(room, socket.data.pid);
    const target = findPlayer(room, targetId);
    hunter.hunterFired = true;
    if (target && target.alive) {
      target.alive = false;
      target.diedAt = room.nightNumber;
      target.diedPhase = 'hunter';
      io.to(room.code).emit('hunterResult', { hunter: hunter.name, target: target.name, role: target.role });
      log(room, `${hunter.name} (Hunter) took ${target.name} down with them.`);
    }
    broadcastRoom(room);

    const nextPhase = room.afterHunterPhase;
    room.pendingHunter = null;
    room.afterHunterPhase = null;

    if (checkWin(room)) return;

    if (nextPhase === 'day-discuss') {
      goToDiscussion(room);
    } else if (nextPhase === 'next-night') {
      clearTimer(room);
      room.timer = setTimeout(() => beginNight(room), 4000);
    }
  });

  // ---- Day voting ----
  socket.on('dayVote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'day-vote') return;
    const me = findPlayer(room, socket.data.pid);
    if (!me || !me.alive) return;
    room.dayVotes[me.id] = targetId;
    io.to(room.code).emit('voteTally', { counts: tallyVotes(room), votesIn: Object.keys(room.dayVotes).length, totalAlive: alivePlayers(room).length });
    maybeResolveVotes(room);
  });

  socket.on('hostSkipTimer', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.data.pid) return;
    if (room.phase === 'day-discuss') goToVote(room);
  });

  socket.on('playAgain', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.data.pid) return;
    clearTimer(room);
    room.phase = 'lobby';
    room.nightNumber = 0;
    room.lovers = [];
    room.dayVotes = {};
    room.centerCards = [];
    room.lastMedicTarget = null;
    room.witchPotions = { healUsed: false, poisonUsed: false };
    room.readyPlayers = new Set();
    room.lastAnnouncement = null;
    room.lastVoteResult = null;
    room.lastGameOver = null;
    room.night = freshNight();
    room.players.forEach((p) => {
      p.alive = true;
      p.role = null;
      p.hunterFired = false;
    });
    broadcastRoom(room);
  });

  socket.on('leaveRoom', () => removePlayerNow(socket));
  socket.on('disconnect', () => handleDisconnect(socket));

  function handleDisconnect(socket) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const player = findPlayer(room, socket.data.pid);
    if (!player || player.socketId !== socket.id) return; // a newer connection already replaced this one

    player.connected = false;
    broadcastRoom(room); // let others see the "reconnecting..." indicator immediately

    // Lobby: no grace period needed, just drop them — nothing to preserve yet.
    if (room.phase === 'lobby') {
      removePlayerNow(socket);
      return;
    }

    // Mid-game: give them a window to come back before losing their seat.
    player.disconnectTimer = setTimeout(() => {
      finalizeRemoval(room, player.id);
    }, DISCONNECT_GRACE_MS);
  }

  function removePlayerNow(socket) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    finalizeRemoval(room, socket.data.pid);
  }

  function finalizeRemoval(room, pid) {
    const idx = room.players.findIndex((p) => p.id === pid);
    if (idx === -1) return;
    const wasHost = room.hostId === pid;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      clearTimer(room);
      delete rooms[room.code];
      return;
    }

    if (wasHost) {
      room.hostId = room.players[0].id;
    }
    broadcastRoom(room);

    if (room.phase === 'lobby') return;

    // A player leaving mid-game can swing the win condition.
    if (checkWin(room)) return;

    // If it was this removed player's turn to act, don't let the night stall.
    if (room.phase === 'night' && isStepStuck(room)) {
      advanceNightStep(room);
    }
    // If the vote can now resolve because the removed player's vote is no
    // longer awaited, check.
    if (room.phase === 'day-vote') {
      maybeResolveVotes(room);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Werewolf Online server running on port ${PORT}`);
});
