# 304

A playable web version of **304** (තුන් සිය හතර), the Sri Lankan trick-taking card game — dealt onto a green baize table with a brass rail, because it deserves one.

Four players, two teams, thirty-two cards worth exactly three hundred and four points, and a trump that nobody can see until somebody calls for it.

**Today:** the complete rules engine, a casino-style table, practice against bots, and **online rooms**: open a table, send three friends a five-letter code (or a one-tap invite link), and bots fill any empty seats.
**Next:** Bluetooth for people in the same room. The groundwork is in place — see [Roadmap](#roadmap).

---

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # engine + room-server test suites
npm run sim 500  # play 500 whole matches headless and report on them
npm run build    # static bundle in dist/ — drop it on any host
npm run server   # local room server on ws://localhost:8787 (zero dependencies)
```

With `npm run dev` and `npm run server` both running, the Online mode works
entirely on your machine — open two browser windows and play yourself.

---

## Hosting it

The build is a plain static site with no backend, so it costs nothing to host. Two good options:

**GitHub Pages** — nothing extra to sign up for. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) is already in the repo: push to `main`, then set **Settings → Pages → Source → GitHub Actions** once, and every push republishes. Limits are a 1 GB site and a soft 100 GB/month of bandwidth. Two catches: on a free GitHub account, Pages only works from a **public** repo, and GitHub's terms rule out commercial use.

**Cloudflare Pages** — connect the repo, build command `npm run build`, output directory `dist`. Works with private repos on the free plan, and bandwidth is unmetered. It is also where the multiplayer server will want to live, which makes it the better long-run choice.

Either way `vite.config.ts` sets `base: './'`, so the build works from a subpath (`user.github.io/304/`) without changes.

### The room server

Online rooms run on a **Cloudflare Worker with a Durable Object per room** — one object holds the room's roster, seed and action list; the WebSocket Hibernation API means an idle table costs nothing. Durable Objects are on the Workers free plan (SQLite-backed), which allows 100,000 requests a day — orders of magnitude more than a few friends will ever use.

Deploying it:

```bash
npx wrangler login    # once — opens the browser to your Cloudflare account
npx wrangler deploy   # prints https://three-oh-four.<your-subdomain>.workers.dev
```

Then put that URL (as `wss://…`) in `PRODUCTION_SERVER` in [`src/net/config.ts`](src/net/config.ts) and push — Pages rebuilds and the Online button goes live. Any build can also be pointed at any server with `?server=wss://…` in the address bar.

**How sync works:** the server is the authority. It validates each move against the engine, numbers it, plays the bot seats itself, and relays the ordered log; clients replay `{seed, actions}` through the same pure engine, so every screen agrees and a reconnecting player (their seat is held, their token reclaims it) just replays to catch up. No hands cross the wire — though since every client holds the seed, a friend with dev tools open could in principle deal themselves knowledge. This is a table for people you'd play cards with, not a casino.

The same room logic also runs as a plain Node process (`npm run server`) with the WebSocket framing hand-rolled — no dependencies — which is what local play and the end-to-end tests use, and would do fine on any small Node host.

Bluetooth needs no hosting at all. It is phone-to-phone, so the only cost there is getting the native build onto devices: TestFlight is free, a Google Play developer account is a one-off fee, and Apple's is annual.

---

## The rules, as implemented

**The deck** — 32 cards: 7, 8, 9, 10, J, Q, K, A in each suit.

**Card values** — J 30 · 9 20 · A 11 · 10 10 · K 3 · Q 2 · 8 and 7 nothing.
That is 76 a suit and **304** in the deck, which is where the game gets its name.

**Card strength** — `J > 9 > A > 10 > K > Q > 8 > 7`. The Jack and the Nine outranking the Ace is the thing that catches new players out, and it is not a coincidence that they are also the two biggest point cards.

**Seating** — four players, partners opposite: North–South against East–West.

**The deal** — four cards each. Then the auction. Then the other four.

**The auction** — opens to the dealer's left, minimum 130, up in fives, maximum 304. Pass and you are out of it. You are bidding on half a hand, which is the whole tension of the game. If the other three pass with no bid on the table, the last player in has to take it.

**The trump** — the winning bidder picks one card from their first four and lays it **face down**. Its suit is the trump. Nobody else knows what it is; the declarer plays the rest of the hand a card short until it comes back.

**Calling** — you must follow the led suit if you can. If you cannot, and the trump is still face down, you may either **call** for it to be turned up or throw a card away blind. Calling turns the trump card over and it counts as trump for the trick in progress, including cards already played into it — so a heart somebody discarded two players ago can suddenly win the trick. Whoever calls must then play a trump if they hold one.

If nobody ever calls, the face-down card returns to the declarer's hand before the last trick and the deal simply finishes with no trump at all.

**Scoring** — the declaring team needs at least its bid in card points across the tricks it takes.

| Outcome | Game points |
| --- | --- |
| Contract made | +1 to the declaring team |
| Contract broken | +1 to the defenders |
| Contract of 250 or more | doubled, win or lose |
| All eight tricks to the declaring team | +1 bonus |

First team to 5 game points takes the match. Minimum bid and match length are both adjustable on the setup screen; the rest live in `DEFAULT_RULES` in [`src/game/rules.ts`](src/game/rules.ts) and are easy to bend to your table's house rules.

### House rules this version picks a side on

304 is a folk game and every table plays it slightly differently. Where sources disagree, this is what the code does — all of it is one edit away from the other choice:

- **The player to the dealer's left leads the first trick.** Some tables let the declarer lead: `firstLead: 'declarer'`.
- **Whoever calls for the trump must play a trump, but not necessarily a high one.** Some tables require it to beat every trump already in the trick.
- **No obligation to trump.** Once the trump is up, a player who cannot follow suit may trump or discard freely.
- **Contracts of 250+ are doubled and a capot pays a bonus.** Both are configurable, including switching them off.

---

## How it is put together

```
src/
  game/        pure TypeScript rules engine — no React, no DOM, no I/O
    cards.ts     the deck, values, strengths, sorting
    rules.ts     legal moves, trick resolution, scoring
    engine.ts    the reducer: (state, action) => state
    bots.ts      a modest opponent
    rng.ts       seeded shuffle
  net/
    transport.ts the seam multiplayer plugs into
  ui/            React components: the table, the lobby, the online flow
```

Two decisions carry the whole thing:

**The engine is a pure reducer.** Every change to the game is an action applied to state — no timers, no mutation, no I/O. That is what makes it testable (the suite drives thousands of complete matches), and it is what makes networking tractable later.

**Deals come from a seed.** A whole match is reproducible from `{ seed, actions[] }`. So a networked table never has to send anybody's cards over the wire — peers exchange the seed and the ordered actions, replay them, and arrive at identical state. A remote player physically cannot read your hand, and a reconnecting device catches up by replaying.

---

## Roadmap

**Bluetooth, four to six in the same room.** This needs a native shell — Web Bluetooth cannot do phone-to-phone, so a browser will never manage it. The plan is an Expo build wrapping this codebase: `src/game` and `src/net` move across untouched, the components get rewritten against React Native primitives, and `BleTransport` implements the same `Transport` interface — one phone advertises as host and orders the actions, the rest connect as centrals and exchange JSON over a GATT characteristic.

**Six-handed 304.** The six-player game is played with two 24-card decks (9 through Ace), 48 cards, eight each, two teams of three, and 608 points on the table. The engine takes seat count as a parameter in several places already, but the deck, the partnership map and the scoring all need widening before it is honest to offer it — hence four-handed only for now.

**Also wanted:** a running score sheet across a session, undo for a misclick, sound, and a stronger bot that counts the cards it has seen.

---

## Licence

MIT — see [LICENSE](LICENSE).
