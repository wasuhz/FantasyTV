# FantasyTV

> **Public beta.** FantasyTV works, but it's new and tested on a handful of TVs and phones. Expect rough edges, and
> please report what breaks in [Issues](https://github.com/wasuhz/FantasyTV/issues). The app installs fixes itself.

**NFL RedZone, but for your own fantasy teams.** FantasyTV is an Android app, for TVs and for phones (foldables
included), for people who watch football through IPTV (Dispatcharr or an Xtream Codes login). It follows your fantasy leagues, finds the games your players are in on
your own channels, and switches to the one most likely to score you points, with your live fantasy scores on screen.

It reads ESPN's live play-by-play, which usually runs ahead of an IPTV stream, so it can switch to a game just before a
big play reaches your picture, and it keeps every popup in step with your stream so nothing is spoiled.

## Compatibility

One APK for every device, **Android 8.0 or newer**. It checks what it's running on and sets itself up for it.

| Device | Status |
|---|---|
| **Android TV / Google TV** (Nvidia Shield, onn 4K, Chromecast with Google TV, most Google TVs) | Supported. The Shield gets every feature; lower-powered sticks run a lighter mode automatically |
| **Fire TV** (Fire OS 7/8) | Should work, untested |
| **Android phones and tablets** | Supported: touch controls, settings in the app, stacked layout upright, full screen sideways, picture-in-picture |
| **Foldables** (Galaxy Fold) | Supported: folded, unfolded and half-open; the layout follows the screen without restarting the stream |
| **iPhone, iPad, Apple TV** | Not supported (an iPhone can still be the remote for a TV, in its browser) |

## Install

Same app and same code, **1790534**, on a TV or a phone. It's always the latest release from
[FantasyTV-releases](https://github.com/wasuhz/FantasyTV-releases/releases), and the app updates itself once installed.

**On a TV:**

1. Install **Downloader** (by AFTVnews) from the TV's app store.
2. Enter code **1790534**.
3. Open FantasyTV and scan the QR code with your phone (same Wi-Fi) to set it up.

**On an Android phone or Fold:**

1. In the phone's browser, open **aftv.news/1790534** (or
   [download the APK](https://github.com/wasuhz/FantasyTV-releases/releases/latest/download/FantasyTV.apk)).
2. Allow installs from the browser when Android asks, then install.
3. Open FantasyTV: it walks you through setup on the phone (your stream server first, then your fantasy teams).

## What you need

- **Fantasy leagues:** Sleeper (username) and/or ESPN (league ID; private leagues with the `espn_s2`/`SWID` cookies).
  Up to 4 leagues at once. Yahoo is built in but waiting on Yahoo's API approval.
- **IPTV:** your local **Dispatcharr** address (e.g. `http://192.168.x.x:9191`) or an **Xtream Codes** login. Game
  channels are found from your guide and channel names (works best with Teamarr); you can pick any game's channel
  yourself on the phone.

## What it does

| | |
|---|---|
| **AutoTune** | Ranks every live drive by your starters on offense, field position and down; switches with a 5 s countdown you can cancel, and leaves commercials for a game that's playing |
| **Stream-safe** | Learns each channel's delay behind ESPN (by reading the game clock off the picture); the score bug, popups and switching follow your stream, never ahead of it |
| **Overlay** | Score bug, your players' cards with live points and headshots, your matchups with live win chances (two at a time, scrolling) |
| **Moments** | Points popups, touchdown pop-outs, injury alerts for your starters, 🔥 for hot runs, final-score cards |
| **Remote** | Up: AutoTune on/off · Down: all games · Left/Right: rewind 10 s / live · OK: replay or watch a popup's game. A first-launch tour explains it all |
| **Phone remote** | Settings, channels per game, rewind, split screen, Practice Sunday (simulated games any day) |
| **On a phone** | Tap a popup to watch that game, tap AutoTune, swipe left/right to rewind / go live, ☰ for all games, ⚙ for settings; picture-in-picture when you leave the app |

## Privacy

Your logins (IPTV, ESPN cookies, Yahoo sign-in) are stored only on the device FantasyTV runs on. There is no
FantasyTV server and no account. The app talks only to your IPTV server, ESPN, Sleeper, Yahoo (if connected) and GitHub
(for updates). On a TV, the phone remote reaches it over your home Wi-Fi; on a phone, the app's local server answers
only the app itself.

## Building from source

- **The app (TV and phone):** `android/` (Gradle, JDK 17). `install.ps1 <device-address:port>` builds and installs over
  adb (a TV's network debugging, or a phone's Wireless debugging). The screens are the web pages in `web/`, packed into
  the APK; on a phone `tv.html` switches to touch and the phone layouts.
- **PC test version:** `start.ps1` runs the same screens in a browser at http://localhost:8765/ (TV on the left,
  phone remote on the right). Practice Sunday works without any IPTV.
- **Release signing** uses a key kept outside the project; without it, builds use the debug key.
- **Yahoo:** FantasyTV's Yahoo app keys go in a git-ignored `yahoo.properties` (`clientId=`, `clientSecret=`); without
  it, Yahoo needs your own Yahoo app's keys entered on the phone.

| Path | What |
|---|---|
| `web/tv.html`, `web/js/tv.js` | The screen: score bug, cards, matchups, popups, All Games, tour; touch and phone layouts |
| `web/remote.html` | The phone remote and settings (also the settings screen inside the phone app) |
| `site/` | fantasytvapp.com |
| `web/js/engine.js` | AutoTune: ranking and switching rules |
| `web/js/data.js` | Sleeper, ESPN (scoreboard and fantasy leagues), Yahoo merge |
| `web/js/iptv.js` | Finding each game's channel in Dispatcharr / Xtream |
| `web/js/sim.js` | Practice Sunday (simulated games) |
| `android/app/src/main/java/...` | Player, rewind buffer, clock reading, local server, Yahoo sign-in, updater |
| `pages/yahoo.html` | Yahoo sign-in return page (served by GitHub Pages) |

## License

MIT. See [LICENSE](LICENSE).
