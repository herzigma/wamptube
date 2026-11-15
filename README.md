# wamptube

A small Mac app for listening to music from YouTube, with the look and feel of classic
Winamp 2. You give it YouTube playlists or videos. It plays just the audio in a Winamp-style player.

<img width="1560" height="2084" alt="CleanShot 2026-11-15 at 13 42 59@2x" src="https://github.com/user-attachments/assets/aed4950b-c4f3-41ef-b58f-4164b170a618" />

## Download

**[Download wamptube for Mac (Apple Silicon)](https://github.com/kenliu/wamptube/releases/download/latest/wamptube-macos-arm64.zip)**

A new build is made automatically every time the code changes. The
[release page](https://github.com/kenliu/wamptube/releases/tag/latest) also has a `.dmg`
installer. Builds are for Apple Silicon Macs (M1 and later) only.

1. Unzip the download and drag **wamptube** into your **Applications** folder.
2. Install the two tools wamptube relies on (this needs [Homebrew](https://brew.sh)):

   ```bash
   brew install deno yt-dlp
   ```

   - **yt-dlp** finds the audio for each YouTube video.
   - **Deno** is needed by yt-dlp to work with YouTube.

3. Open the app. The first time, macOS will warn that the app is from an unidentified
   developer, because it isn't signed. To open it anyway, right-click **wamptube** in
   Applications and choose **Open**. Or run this once in Terminal:

   ```bash
   xattr -dr com.apple.quarantine /Applications/wamptube.app
   ```

Keep yt-dlp up to date. YouTube changes often, and an old copy may find songs that then
refuse to play:

```bash
brew upgrade yt-dlp
```

## Build it yourself

If you'd rather run it from the code, you also need [Rust](https://rustup.rs). Then, from
this folder, the first time:

```bash
deno install
```

And every time:

```bash
deno task tauri dev
```

The first start takes a few minutes while everything is built. After that it opens in
seconds.

## Add your music

There are three ways to add music:

- **Paste a link.** In the playlist window, click **ADD**, then **URL**, and paste a YouTube
  playlist or video link.
- **Drop a link.** Drag a YouTube link from your browser onto the playlist window.
- **Edit the settings file** (below).

Whatever you add is saved, so it's there the next time you open the app.

Playlists must be **Public** or **Unlisted**. Private playlists won't load, because wamptube
doesn't sign in to YouTube.

### The settings file

Your list of playlists and videos lives in:

```
~/.config/wamptube/config.toml
```

The app creates this file the first time it runs. It looks like this:

```toml
sources = [
  "https://www.youtube.com/playlist?list=PL...",
  "https://www.youtube.com/watch?v=...",
]
```

Everything listed is loaded in order when the app starts. To remove something, delete its
line and restart the app.

## Using the player

It works like Winamp:

- **Play, pause, skip** with the buttons on the main window, or double-click a song in the
  playlist.
- **EQ** and **PL** on the main window show or hide the equalizer and the playlist. The app
  window shrinks or grows to fit.
- **Double-click a window's title bar** to fold it down to a thin strip.
- **Drag the bottom-right corner of the playlist** to make it taller or shorter.
- **Drag the main window's title bar** to move the app around your screen.
- The **X** in the top-right corner quits the app.

## Known issues

- **Song lengths can look doubled.** The Mac's built-in web engine sometimes reports a song
  as twice its real length, so the time display and seek bar can be off. Playback itself is
  fine.
- **The first song takes a few seconds to start.** Each song is looked up on YouTube just
  before it plays, and YouTube makes new links wait a few seconds before they work.
- **Resizing the playlist is a bit choppy.** It grows one row at a time
  ([issue #2](https://github.com/kenliu/wamptube/issues/2)).
- **A song that won't play** usually means yt-dlp is out of date. Run
  `brew upgrade yt-dlp` and restart the app.

## What wamptube won't do

- Download or save audio. It only streams.
- Show video.
- Sign in to YouTube or change anything on your account.

## For developers

How the app is put together, and the commands for tests and checks, are in
[CLAUDE.md](CLAUDE.md). What the prototype found, including open problems, is in
[NOTES.md](NOTES.md).

Built with [Webamp](https://github.com/captbaritone/webamp), [Tauri](https://tauri.app) and
[yt-dlp](https://github.com/yt-dlp/yt-dlp).
