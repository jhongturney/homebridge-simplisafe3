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
2. **1.11.5-jhongturney.2 — compatible dependency and security refresh.** Update
   `follow-redirects`, Axios, WebSocket and LiveKit protocol dependencies, and
   compatible transitive security fixes. Recheck authentication and cameras.
3. **1.11.5-jhongturney.3 — supported runtimes and native login command.** Align
   Node requirements and CI with supported Homebridge versions. Replace the
   single-command Oclif dependency with Node's built-in argument parser to remove
   the remaining production security findings.
4. **Then — remaining dependency migrations.** Separately upgrade UI, retry and
   camera dependencies. Test each affected path before proceeding.
5. **Then — request and polling performance.** Share in-flight requests and
   credential refreshes; prevent overlapping polls; add network deadlines.
6. **Then — camera cleanup and reconnect behavior.** Cancel timed-out camera
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
- The release asset includes `npm-shrinkwrap.json` recording the source dependency
  graph. Later clean-install checks found that tarball installations resolved
  allowed newer versions; checkpoint 3 pins the direct runtime dependencies.
  Package installation and plugin registration are checked independently.
- User field test passed: Home app snapshots, live video and audio work on both
  a battery-powered outdoor camera and a plugged-in indoor camera after enabling
  camera support. Exact camera models/provider paths were not supplied; do not
  infer either from their power source. Shutter privacy, notifications, alarm
  controls and sensor updates have not been separately confirmed.

## Second checkpoint validation

- Updated only Axios 1.20.0 → 1.21.0, ws 8.21.0 → 8.22.1,
  @livekit/protocol 1.52.1 → 1.53.4, follow-redirects 1.16.1 → 1.16.2,
  and @babel/runtime 7.17.9 → 7.29.13. No packages were added or removed.
- No application source changes; camera implementation, FFmpeg and Werift stay
  at the first checkpoint's tested versions.
- All 79 tests passed on Node 22, 24 and 26; lint and type checks passed.
- Production audit reduced from 5 findings to 3 moderate findings, all in the
  Oclif/minimatch CLI dependency chain. No high or critical production findings.
- User field test passed: "Everything still working after the update."

## Third checkpoint validation

- Replace Oclif's single-command CLI framework with Node's native argument
  parser. Preserve `login`, `-d`/`--homebridgeDir`, help, version and storage-path
  defaults. No runtime matcher overrides are needed.
- Successful CLI login stores credentials through the existing auth manager and
  ends its background refresh timer. It reports success without printing tokens.
- Require Node 22.12+ within 22.x, 24.x or 26.x; Homebridge 1.11.4+ within 1.x or
  2.5+ within 2.x. Node 18 and 20 are no longer supported by this fork.
- Match Node typings to Node 22 and update the Homebridge development host to
  2.5.0. Expand CI to five supported Node/Homebridge combinations, including
  real host registration and camera-controller setup checks. Update CI actions.
- Camera implementation, UI login and polling stay unchanged. Pin direct runtime
  dependencies to the versions resolved by clean checkpoint 2 installs, including
  FFmpeg 2.2.2, Werift 0.24.4 and LiveKit protocol 1.53.4. This corrects the earlier
  assumption that simply including the source shrinkwrap pinned tarball installs.
  Indirect dependency resolution can still depend on the host installation.
- All 90 tests pass on Node 22.12.0, 24 and 26; lint and type checks pass.
- Both the source lockfile and a clean installed release package audit with zero
  production findings. The clean production installation contains 84 packages,
  compared with 121 at checkpoint 2.
- Field testing of the third checkpoint is pending.

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
