# Hollow — Online Werewolf

Real-time multiplayer Werewolf/Mafia party game. Node.js + Express + Socket.io backend, single-page Tailwind/vanilla-JS frontend.

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000 on your computer, and http://YOUR-LOCAL-IP:3000 on phones on the same Wi-Fi.

## Deploy free (Render)
1. Push this folder to a GitHub repo.
2. On render.com: New -> Web Service -> connect the repo.
3. Build command: `npm install`  Start command: `npm start`
4. Deploy. Share the generated URL + a room code with friends anywhere (not just same Wi-Fi).

## Deploy free (Replit)
1. Create a Node.js Repl, upload these files (or import from GitHub).
2. Run `npm install` in the shell, then hit Run (uses `npm start`).
3. Share the webview URL.

## How it works
- `server.js` holds all game state in memory per room code (no database needed).
- `public/index.html` is the entire frontend: Tailwind (CDN) + vanilla JS + socket.io-client.
- Roles: Werewolf, Villager, Seer, Witch, Hunter, Cupid (host toggles each on/off, sets wolf count 1-6, and a discussion timer).
- Night is a sequential state machine (Cupid -> Werewolves -> Seer -> Witch -> resolve) so each role gets a private turn; other players see a "waiting" screen.
- Hunter: if eliminated (night or day), gets an immediate prompt to take one more player down.
- Cupid: lovers picked night 1; if one dies the other dies of heartbreak (no separate "lovers" win condition — kept simple).
- Win check runs after every death: werewolves win once they equal/outnumber the rest; villagers win once all werewolves are dead.
- "Play Again" resets everyone to the lobby with the same room code.

## Known simplifications (easy to extend)
- Werewolf night target is decided by majority vote among wolves (ties broken by first-seen).
- No text chat during discussion — it's meant to be played with voice/video alongside this screen. Could add a chat panel via a `discussChat` socket event if you want it.
- No persistence across server restarts (in-memory only) — fine for Render/Replit free tier single-instance use.
