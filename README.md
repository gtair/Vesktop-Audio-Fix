# Vesktop Audio Fix

Stop your viewers from hearing themselves in your screen share (ON WINDOWS ONLY!).

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
> [!TIP]
> Better explanation [in the discord for Vesktop](https://discord.com/channels/1015060230222131221/1257038407503446176)


6. Start a screen or window share

## Permanent files

The plugin ***generates*** a powershell file ***from it's own code***. This file, alongside the logs of the plugin, are stored in `%appdata%\Vesktop Audio Fix`.

## Settings
* Buffer Size - best kept alone unless your viewers are experiencing audio stuttering / buffering
