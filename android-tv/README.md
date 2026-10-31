# IPTV Player for Android TV

A small Android TV app that opens the IPTV Player web app full screen and plays
its videos with ExoPlayer (Media3), the TV's own player.

- **The interface is the web app** served by the Raspberry Pi, so each deploy
  updates the TV too. Inside the app the page sees `window.AndroidTV` and:
  - moves the focus with the remote (arrows, OK, Back);
  - hands every video to the native player (channels, recordings, video club,
    series and Discover). Programmes from the archive still play in the page.
- **The player is native**: MKV, HEVC, AC3/E-AC3 (decoded by the TV or passed
  to the amplifier) play as they are, so channels need no conversion on the
  server and Discover plays Real-Debrid's original file (with the converted
  version if the TV cannot play it, or cannot play its sound).

## Remote

| Where | Key | Does |
|---|---|---|
| Pages | Arrows / OK | Move the focus / press |
| Pages | Back | Closes what is open, goes back to the groups, then to Home; twice on Home leaves |
| Channel | Up / Down, CH+ / CH− | Next / previous channel of the same group |
| Film, episode | Left / Right | Back 10 s / forward 30 s |
| Player | OK | Shows the controls (audio and subtitle tracks in ⚙ and CC) |
| Player | Back | Hides the controls, then closes the video |

The buttons at the top right of the player (with the controls shown) change
version (original / compatible), look for subtitles on OpenSubtitles, and go
to the next episode.

## Building

Needs JDK 17+ and the Android SDK (Android Studio installs both).

- Android Studio: open this folder and use Build → Build APK(s).
- Command line (the Gradle wrapper downloads Gradle by itself; `local.properties`
  says where the SDK is, e.g. `sdk.dir=/usr/local/share/android-commandlinetools`):

```bash
cd android-tv
./gradlew assembleRelease
```

The APK is `app/build/outputs/apk/release/app-release.apk` (signed with the
debug key, ready to install).

## Installing on the TV

1. On the TV: Settings → Device Preferences → About, press Build seven times,
   then Developer options → USB debugging / Network debugging on.
2. From the computer:

```bash
adb connect <tv-ip>
adb install -r app/build/outputs/apk/release/app-release.apk
```

The first time the app asks for the server address (at home
`http://192.168.1.159`, away `https://tv.bacalhau.cc`). It can be changed in
the app's Preferences ("Change the server address").
