# Rumfa mockups

Static design mockups for every page, using sample data. Open `index.html` to browse them all, or look in `screenshots/`.

- `room-*`: Rumfa Room (dashboard), 1440 wide
- `agent-*`: agent app, phone size (390 × 844, shot at 2×)
- `console-*`: Rumfa Console (platform staff)

The pages are generated. To change one, edit `src/room.mjs`, `src/agent.mjs` or `src/console.mjs`, then run:

```bash
node design/mockups/src/build.mjs && node design/mockups/src/shoot.mjs && node design/mockups/src/shoot.mjs index
```

`shoot.mjs` uses the installed Google Chrome in headless mode; pass a prefix (for example `room-case`) to reshoot only some pages.
