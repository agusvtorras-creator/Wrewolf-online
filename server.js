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
  discussionSeconds: 90, // 0 = disabled
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 20;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no O/I to avoid confusion

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

function makeRoom(code, hostSocketId) {
  return {
    code,
    hostId: hostSocketId,
    players: [], // {id, name, alive, role, isHost, votedOutHistory...}
    settings: { ...DEFAULT_SETTINGS },
    phase: 'lobby', // lobby -> reveal -> night -> day-announce -> day-discuss -> day-vote -> day-result -> gameover
    nightNumber: 0,
    night: freshNight(),
    dayVotes: {}, // voterId -> targetId
    lovers: [], // [id, id]
    log: [],
    timer: null, // active setTimeout handle
    timerEndsAt: null,
    pendingHunter: null, // playerId awaiting hunter-shot resolution
    afterHunterPhase: null, // phase to continue to once hunter resolves
  };
}

function freshNight() {
  return {
    wolfVotes: {}, // wolfId -> targetId
    wolfTarget: null,
    seerTarget: null,
    seerResult: null,
    witchHealUsed: false,
    witchPoisonUsed: false,
    witchHeal: false,
    witchPoisonTarget: null,
    cupidDone: false,
    step: 'cupid', // cupid -> wolves -> seer -> witch -> resolve
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

  const wolfCount = Math.max(1, Math.min(s.werewolves, Math.floor(n / 2) - (s.witch || s.seer ? 0 : -1) || 1));
  for (let i = 0; i < wolfCount; i++) roles.push('werewolf');
  if (s.seer) roles.push('seer');
  if (s.witch) roles.push('witch');
  if (s.hunter) roles.push('hunter');
  if (s.cupid) roles.push('cupid');
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
    instructions: 'You have one healing potion and one poison potion for the whole game. Each night you see the werewolves\u2019 victim and may save them, and/or poison someone else.',
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
};

function roleReveal(room) {
  room.players.forEach((p) => {
    const info = ROLE_INFO[p.role];
    const wolfTeammates =
      p.role === 'werewolf'
        ? room.players.filter((o) => o.role === 'werewolf' && o.id !== p.id).map((o) => o.name)
        : undefined;
    io.to(p.id).emit('roleAssigned', {
      role: p.role,
      team: info.team,
      label: info.label,
      instructions: info.instructions,
      wolfTeammates,
    });
  });
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
  broadcastRoom(room);
  roleReveal(room);
  // give everyone a few seconds to read their role, then begin night 1
  clearTimer(room);
  room.timer = setTimeout(() => beginNight(room), 6000);
  room.timerEndsAt = Date.now() + 6000;
}

function beginNight(room) {
  clearTimer(room);
  room.nightNumber += 1;
  room.night = freshNight();
  room.phase = 'night';

  // skip cupid step unless it's night 1 and cupid role is in play and alive
  const cupid = room.players.find((p) => p.role === 'cupid');
  if (!(room.nightNumber === 1 && cupid && cupid.alive)) {
    room.night.step = 'wolves';
  }

  broadcastRoom(room);
  emitNightState(room);
}

function emitNightState(room) {
  const n = room.night;
  room.players.forEach((p) => {
    if (!p.alive) {
      io.to(p.id).emit('nightState', { step: n.step, youAre: p.role, alive: false });
      return;
    }
    const payload = { step: n.step, youAre: p.role, alive: true };

    if (n.step === 'cupid' && p.role === 'cupid') {
      payload.action = 'cupid';
      payload.options = room.players.filter((o) => o.alive).map((o) => ({ id: o.id, name: o.name }));
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
    } else if (n.step === 'witch' && p.role === 'witch') {
      payload.action = 'witch';
      payload.wolfTargetName = n.wolfTarget ? findPlayer(room, n.wolfTarget)?.name : null;
      payload.canHeal = !n.witchHealUsed;
      payload.canPoison = !n.witchPoisonUsed;
      payload.poisonOptions = alivePlayers(room)
        .filter((o) => o.id !== p.id)
        .map((o) => ({ id: o.id, name: o.name }));
    } else {
      payload.action = 'wait';
    }
    io.to(p.id).emit('nightState', payload);
  });
}

function advanceNightStep(room) {
  const n = room.night;
  if (n.step === 'cupid') n.step = 'wolves';
  else if (n.step === 'wolves') n.step = room.players.some((p) => p.role === 'seer' && p.alive) ? 'seer' : 'witch';
  else if (n.step === 'seer') n.step = 'witch';
  else if (n.step === 'witch') {
    resolveNight(room);
    return;
  }
  // if witch role doesn't exist/alive, skip straight to resolve
  if (n.step === 'witch' && !room.players.some((p) => p.role === 'witch' && p.alive)) {
    resolveNight(room);
    return;
  }
  emitNightState(room);
}

function resolveNight(room) {
  const n = room.night;
  const deaths = new Set();

  if (n.wolfTarget && !(n.witchHeal)) {
    deaths.add(n.wolfTarget);
  }
  if (n.witchPoisonTarget) {
    deaths.add(n.witchPoisonTarget);
  }

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
  broadcastRoom(room);
  io.to(room.code).emit('dayAnnouncement', {
    nightNumber: room.nightNumber,
    deaths: deathList.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  });

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
  io.to(hunterPlayer.id).emit('hunterPrompt', {
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

  broadcastRoom(room);
  io.to(room.code).emit('voteResult', {
    counts,
    tie: leaders.length > 1,
    eliminated: deathList.map((p) => ({ id: p.id, name: p.name, role: p.role })),
  });

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
    io.to(room.code).emit('gameOver', {
      winner,
      players: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role, alive: p.alive })),
    });
    broadcastRoom(room);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, ack) => {
    name = (name || '').trim().slice(0, 20) || 'Host';
    const code = genCode();
    const room = makeRoom(code, socket.id);
    room.players.push({ id: socket.id, name, alive: true, role: null });
    rooms[code] = room;
    socket.join(code);
    socket.data.roomCode = code;
    ack && ack({ success: true, code, hostId: socket.id });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ name, code }, ack) => {
    const room = getRoom(code);
    name = (name || '').trim().slice(0, 20);
    if (!room) return ack && ack({ success: false, error: 'Room code not found.' });
    if (room.phase !== 'lobby') return ack && ack({ success: false, error: 'Game already in progress.' });
    if (room.players.length >= MAX_PLAYERS) return ack && ack({ success: false, error: 'Room is full.' });
    if (!name) return ack && ack({ success: false, error: 'Please enter a name.' });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return ack && ack({ success: false, error: 'That name is already taken in this room.' });
    }
    room.players.push({ id: socket.id, name, alive: true, role: null });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    ack && ack({ success: true, code: room.code, hostId: room.hostId });
    broadcastRoom(room);
  });

  socket.on('updateSettings', ({ code, settings }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    room.settings = {
      werewolves: Math.max(1, Math.min(8, parseInt(settings.werewolves) || 1)),
      seer: !!settings.seer,
      witch: !!settings.witch,
      hunter: !!settings.hunter,
      cupid: !!settings.cupid,
      discussionSeconds: [0, 60, 90, 120, 180].includes(parseInt(settings.discussionSeconds))
        ? parseInt(settings.discussionSeconds)
        : 90,
    };
    broadcastRoom(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id || room.phase !== 'lobby') return;
    if (room.players.length < MIN_PLAYERS) return;
    startGame(room);
  });

  // ---- Night actions ----

  socket.on('cupidChoose', ({ code, targets }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'cupid') return;
    const me = findPlayer(room, socket.id);
    if (!me || me.role !== 'cupid' || !me.alive) return;
    if (!Array.isArray(targets) || targets.length !== 2) return;
    room.lovers = targets;
    room.night.cupidDone = true;
    io.to(targets[0]).emit('loversRevealed', { partnerId: targets[1], partnerName: findPlayer(room, targets[1])?.name });
    io.to(targets[1]).emit('loversRevealed', { partnerId: targets[0], partnerName: findPlayer(room, targets[0])?.name });
    advanceNightStep(room);
  });

  socket.on('wolfVote', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'wolves') return;
    const me = findPlayer(room, socket.id);
    if (!me || me.role !== 'werewolf' || !me.alive) return;
    room.night.wolfVotes[socket.id] = targetId;

    // broadcast live tally to wolves
    aliveWolves(room).forEach((w) => io.to(w.id).emit('wolfVoteUpdate', { wolfVotes: room.night.wolfVotes }));

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
    const me = findPlayer(room, socket.id);
    if (!me || me.role !== 'seer' || !me.alive) return;
    const target = findPlayer(room, targetId);
    if (!target) return;
    const result = target.role === 'werewolf' ? 'werewolf' : 'villager';
    room.night.seerTarget = targetId;
    room.night.seerResult = { name: target.name, result };
    io.to(socket.id).emit('seerResult', room.night.seerResult);
    advanceNightStep(room);
  });

  socket.on('witchAction', ({ code, heal, poisonTargetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'night' || room.night.step !== 'witch') return;
    const me = findPlayer(room, socket.id);
    if (!me || me.role !== 'witch' || !me.alive) return;
    if (heal && !room.night.witchHealUsed) {
      room.night.witchHeal = true;
      room.night.witchHealUsed = true;
    }
    if (poisonTargetId && !room.night.witchPoisonUsed) {
      room.night.witchPoisonTarget = poisonTargetId;
      room.night.witchPoisonUsed = true;
    }
    advanceNightStep(room);
  });

  // ---- Hunter ----
  socket.on('hunterShoot', ({ code, targetId }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'hunter-shot' || room.pendingHunter !== socket.id) return;
    const hunter = findPlayer(room, socket.id);
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
    const me = findPlayer(room, socket.id);
    if (!me || !me.alive) return;
    room.dayVotes[socket.id] = targetId;
    io.to(room.code).emit('voteTally', { counts: tallyVotes(room), votesIn: Object.keys(room.dayVotes).length, totalAlive: alivePlayers(room).length });
    maybeResolveVotes(room);
  });

  socket.on('hostSkipTimer', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase === 'day-discuss') goToVote(room);
  });

  socket.on('playAgain', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.hostId !== socket.id) return;
    clearTimer(room);
    room.phase = 'lobby';
    room.nightNumber = 0;
    room.lovers = [];
    room.dayVotes = {};
    room.night = freshNight();
    room.players.forEach((p) => {
      p.alive = true;
      p.role = null;
      p.hunterFired = false;
    });
    broadcastRoom(room);
  });

  socket.on('leaveRoom', () => handleDisconnect(socket));
  socket.on('disconnect', () => handleDisconnect(socket));

  function handleDisconnect(socket) {
    const code = socket.data.roomCode;
    const room = getRoom(code);
    if (!room) return;
    const idx = room.players.findIndex((p) => p.id === socket.id);
    if (idx === -1) return;
    const wasHost = room.hostId === socket.id;
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
    if (room.phase !== 'lobby') {
      // a player leaving mid-game — re-check win conditions in case it swings the balance
      checkWin(room);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Werewolf Online server running on port ${PORT}`);
});
