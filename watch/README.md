# Claw Remote

Pebble Time 2 (emery) Alloy app that remotes a local OpenClaw agent through the PC watch-bridge.

```sh
pebble package install
pebble build
pebble install --emulator emery
```

Set `src/embeddedjs/config.js` to this PC's LAN bridge URL and token, or use the phone settings page served by the bridge at `/config`.
