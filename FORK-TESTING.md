# Staged testing fork

This fork keeps the `homebridge-simplisafe3` package name and platform identity so
an installed test build can reuse existing configuration and accessory pairing.
Install release `.tgz` assets, which contain the compiled plugin. The source
branch itself is not an installable build.

## Checkpoints

1. **1.11.5-jhongturney.1 — legacy camera snapshot replacement.** Remove
   `jpeg-extract` and its deprecated `request` dependency tree. Use Node HTTPS
   with certificate verification, a seven-second total deadline, a 4 MiB response
   limit, and immediate connection cleanup after the first JPEG. Preserve shutter
   privacy checks and the existing LiveKit streaming path.
2. **Next — compatible dependency and security refresh.** Update
   `follow-redirects`, Axios, WebSocket and LiveKit protocol dependencies, and
   compatible transitive security fixes. Recheck authentication and cameras.
3. **Then — runtime policy and dependency migrations.** Align Node requirements
   and CI with supported Homebridge versions before separately upgrading UI,
   CLI/retry and camera dependencies. Test each affected path before proceeding.
4. **Then — request and polling performance.** Share in-flight requests and
   credential refreshes; prevent overlapping polls; add network deadlines.
5. **Then — camera cleanup and reconnect behavior.** Cancel timed-out camera
   work and bound reconnect backoff with jitter.

Each checkpoint waits for Homebridge field-test results before the next build.
No upstream PR or npm registry release is created by this workflow. Fork release
events are excluded from the upstream npm publishing job.

## First checkpoint validation

- Baseline: 67 existing unit tests passed before editing.
- Updated build: 79 tests passed on Node 22, 24 and 26.
- ESLint, TypeScript checking and whitespace checks passed.
- Production lockfile audit: 11 findings (2 critical, 1 high, 8 moderate) reduced
  to 5 (0 critical, 1 high, 4 moderate). Remaining findings are deferred to the
  dependency checkpoints; the fork is not claimed to be vulnerability-free.
- The release asset includes `npm-shrinkwrap.json` to pin the tested dependency
  graph. Package installation and plugin registration are checked independently.
- Real SimpliSafe hardware and certificate behavior still require field testing.

## Field checks

After installing the release asset and restarting Homebridge:

- Confirm the fork version in the installed package and plugin startup logs.
- Check ordinary arm/disarm operation and sensor updates.
- For legacy SimpliCam / Video Doorbell Pro cameras, check fresh Home app
  thumbnails, live video and audio, and normal motion/doorbell notifications.
- Check that a closed privacy shutter still returns the privacy image without
  opening the shutter.
- If using LiveKit cameras, verify thumbnails, live video/audio and notifications
  still work; their media path is unchanged in this checkpoint.
- Report the camera model, Node/Homebridge versions and relevant errors, with
  credentials and tokens removed.

## Rollback

From `hb-shell`, in `/var/lib/homebridge`, run:

```sh
npm install --save-exact homebridge-simplisafe3@1.11.4
```

Then leave the shell and restart Homebridge. Keep the existing plugin
configuration and accessory pairing.
