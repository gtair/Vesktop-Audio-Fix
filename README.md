# Vesktop Audio Fix

Stop your viewers from hearing themselves in your screen share.

## What it does

When streaming on Discord with Vesktop, viewers hear their own audio played back to them (Vesktop audio feedback). This plugin removes that:

- **Screen shares** — Viewers hear the exact audio you're hearing only without vesktop in the mix.
- **Window shares** — Only the audio from that window is shared
- Clean streaming experience with no echo or self-audio for your audience

## Setup

1. Extract to your Vencord plugins folder
```
.\src\userplugins
```
2. build
3. point Vesktop to the Vencord dist
4. Enable in Vencord settings → Plugins → Show UserPlugins → Vesktop Audio Fix
5. Start a screen or window share

## Permanent files

The plugin relies on an external compiled binary, the code of which is [here](https://github.com/gtair/Vesktop-Audio-Fix/blob/main/capture.cc). It downloads this from the releases of this very github page. This file alongside it's own logs in `%Appdata%\Vesktop Audio Fix`

# Settings
* Buffer Size