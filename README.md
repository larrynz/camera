# io.github.larry.webcam

Native `omarchy-shell` bar widget and settings popup that turns any Linux V4L2/UVC camera into a full webcam hub: hardware-driven camera controls, still photos, video recording, and a **virtual camera** your conferencing apps can use — all from the Omarchy bar.

## How It Works

The plugin wraps `v4l2-ctl`, `ffmpeg`, and (optionally) `cameractrls`. Nothing is hardcoded against a particular camera: control names, ranges, steps, defaults, and menu labels are read from the connected hardware, and the UI renders only what the device actually exposes.

```
                    ┌──────────────────────────┐
 physical camera ──▶ │  ffmpeg hub (rawvideo)   │ ──▶ /dev/video8 "Virtual Camera"  ──▶ calls, OBS, browsers
 (e.g. /dev/video0) │  launched while on      │ ──▶ /dev/video9 "Capture Helper"   ──▶ popup preview, photos, recordings
                    └──────────────────────────┘
```

- **Discovery**: `v4l2-ctl --list-devices` groups nodes per card; each node is probed once with `v4l2-ctl --info` and classified as a *capture* node, a *v4l2loopback* node, or a metadata-only node. Cameras are addressed by their capture node; loopback nodes are candidates for the hub output.
- **Hub**: while the virtual camera is on, a single `ffmpeg` process mirrors the physical camera into the v4l2loopback device(s) as raw YUYV frames. The main loopback ("Virtual Camera") is what conferencing apps open; the helper loopback ("Capture Helper") serves the popup snapshot preview, photos, and recordings so the main node never has to be shared mid-call. Two nodes are required for the full experience: v4l2loopback (with `exclusive_caps=1`, verified on 0.15.4) allows exactly **one reader per node**, so with only one loopback device the virtual camera still works, but photos/recordings/preview fail with *device busy* while a call holds the node.
- **Self-healing start**: before the hub spawns, the plugin kills any stale hub `ffmpeg` processes left behind by a crashed shell (matched by their writer signature `-f v4l2 /dev/videoN`, with a self-exclusion guard so the kill can never hit the wrong process). A shell crash can therefore never leave the virtual camera parked in *failed* — an off/on cycle (or restarting the shell) always recovers.
- **Command queue**: all writes to the physical device (control sets, capture-mode changes) are serialized through one queue so concurrent `v4l2-ctl` calls can never race each other or the hub.
- **Lifecycle**: changing the capture mode or switching cameras transparently stops the hub, applies the change, and restarts it. The hub keeps running with the popup closed.

## Features

- **Virtual Camera**: a button in the viewfinder row shows **Off** while the camera runs (red accent) and **Start Virtual Camera** when it's off; right-clicking the bar icon or IPC does the same. The bar icon turns accent-colored while it runs.
- **Photos & Recordings**: `Photo` saves to `~/Pictures/webcam-<timestamp>.jpg` (or `.png`) — either the on-screen frame as you see it (mirroring applied) or the raw camera feed, per the popup's Photo format setting; `Record` writes H.264 MP4 to `~/Videos/webcam-<timestamp>.mp4` with a live REC timer. Stopping a recording sends SIGINT so ffmpeg finalizes the file properly (a watchdog escalates if it hangs). Both read from the hub when it's running (helper loopback), otherwise straight from the camera.
- **Live Viewfinder**: while the virtual camera runs and the popup is open, a true live video stream (QtMultimedia `CaptureSession`) renders from the helper loopback. The **Mirror** toggle flips the preview only — the stream other apps receive is never mirrored, so mirror ON matches a conferencing app's self-view.
- **Dynamic Settings**: every slider, toggle, and segmented control is generated from what the device reports — real min/max/step, real defaults, menu labels from the driver (e.g. *Manual Mode* / *Aperture Priority Mode*). Controls are grouped into Optics, Exposure, Color, and Utilities; anything unrecognized lands in **Advanced** and still works. Un-settable types (e.g. region-of-interest `rect`/`bitmask` controls on some laptops) are hidden rather than rendered broken.
- **Dependency-Aware Controls**: manual sliders (focus, exposure time, color temperature) disable themselves while their parent auto mode is on, using each control's reported inactive flag and known dependency pairs.
- **Multi-Camera**: a picker appears when more than one capture device is discovered; switching restarts the hub on the new camera.
- **Capture Mode**: default resolution / frame rate for apps that don't negotiate their own, applied via `v4l2-ctl --set-fmt-video`/`--set-parm`. Mode changes automatically stop and restart the hub.
- **Hardware-Aware Reset**: "Reset defaults" restores every control the camera reports a default for, in dependency-safe phase order, plus the vendor FOV when available.
- **Full IPC**: scripts and keybindings can toggle the virtual camera, shoot photos, start/stop recordings, and read/write any control (see below).

## Prerequisites

The plugin never installs anything itself; use Omarchy's package helper:

- **`v4l-utils`** (`v4l2-ctl`): **Required** — device discovery and control.
- **`ffmpeg`**: **Required** — hub mirroring, photos, recordings, preview snapshots.
- **`v4l2loopback` kernel module**: **Required for the virtual camera** (still photos and recordings work without it). On Arch: `omarchy pkg add v4l2loopback-dkms` — it's in the official `extra` repo; DKMS builds it against your kernel, so matching headers must be installed (e.g. `linux-omarchy-headers` for the omarchy kernel). The `v4l2loopback-utils` package is **not** needed — this plugin only uses `v4l2-ctl` from `v4l-utils`, never `v4l2loopback-ctl`.
- **`cameractrls`**: **Optional** — vendor FOV control (65°/78°/90°) on cameras exposing the `logitech_brio_fov` control. Without it (or on other cameras) the FOV row is simply omitted.

```bash
omarchy pkg add v4l-utils ffmpeg
```

## One-Time Virtual Camera Setup

The virtual camera needs the v4l2loopback driver loaded. Load it (root) with the node numbers and card labels this plugin expects:

```bash
sudo modprobe v4l2loopback video_nr=8,9 card_label="Virtual Camera","Capture Helper" exclusive_caps=1
```

`video_nr` picks the `/dev/videoN` nodes; `exclusive_caps=1` is required for Chrome/Firefox/Chromium-based apps to list the device. The popup shows this command verbatim whenever the driver is not loaded, with a **Re-check** button after you run it.

To persist across reboots:

```bash
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback video_nr=8,9 card_label="Virtual Camera","Capture Helper" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
```

Nodes 8/9 are a convention, not a requirement — the plugin discovers whatever loopback nodes exist and picks the card labeled *Virtual Camera* as the main output and *Capture Helper* as the helper, falling back to the first two loopback nodes by number when labels are absent. Use two nodes: with a single loopback device, photos/recordings/preview can't run while a conference app holds the node (one reader per node).

## Installation

```bash
omarchy plugin add https://github.com/larry/webcam.git --enable
```

### Development (local checkout)

```bash
git clone https://github.com/larry/webcam.git
ln -sfn "$PWD/webcam" ~/.config/omarchy/plugins/io.github.larry.webcam
```

## Uninstall / Remove

```bash
omarchy plugin remove io.github.larry.webcam
```

Removal leaves nothing behind: the plugin is stateless and writes no configuration or cache. Photos and recordings you took are ordinary files in `~/Pictures` and `~/Videos`.

## Capture Mode Notes

- The configured mode persists in the `uvcvideo` driver as the default for non-negotiating tools; negotiating apps (browsers, Zoom, OBS, PipeWire) keep requesting their own.
- Mode cannot change while an external app streams the physical device (`EBUSY`) — the popup reports "Camera is in use".
- Changing the mode while the virtual camera runs restarts the hub automatically (brief gap in the virtual stream).

## IPC Interface Contract

Target `io.github.larry.webcam`, invoked via `omarchy-shell`:

```bash
# Popup
omarchy-shell io.github.larry.webcam open
omarchy-shell io.github.larry.webcam close
omarchy-shell io.github.larry.webcam toggle

# Virtual camera
omarchy-shell io.github.larry.webcam virtualCam on        # start; prints 1 on success
omarchy-shell io.github.larry.webcam virtualCam off       # stop
omarchy-shell io.github.larry.webcam virtualCam toggle   # prints new state
omarchy-shell io.github.larry.webcam virtualCamStatus
# Output: off | starting | running | error

# Capture
omarchy-shell io.github.larry.webcam takePhoto           # prints the saved path
omarchy-shell io.github.larry.webcam startRecording [format] [mic]  # prints the target path; format mp4|mkv, mic 0|1
omarchy-shell io.github.larry.webcam stopRecording

# Cameras
omarchy-shell io.github.larry.webcam listCameras
# Output: [{"index":0,"path":"/dev/video0","name":"Integrated Camera"}]
omarchy-shell io.github.larry.webcam selectCamera 0
omarchy-shell io.github.larry.webcam getDevice           # active capture node
omarchy-shell io.github.larry.webcam setDevice /dev/video0
omarchy-shell io.github.larry.webcam listDevices         # legacy alias: [{path,name}]

# Controls (only what the active camera exposes)
omarchy-shell io.github.larry.webcam getCtrl brightness
omarchy-shell io.github.larry.webcam setCtrl brightness 150
omarchy-shell io.github.larry.webcam setCtrl logitech_brio_fov 78   # needs cameractrls
omarchy-shell io.github.larry.webcam resetDefaults

# Capture mode
omarchy-shell io.github.larry.webcam getCaptureMode
# Output: 1280x720@30 MJPG
omarchy-shell io.github.larry.webcam setCaptureMode 1920x1080 30

# Mirror (popup preview flip)
omarchy-shell io.github.larry.webcam getMirror            # 0 | 1
omarchy-shell io.github.larry.webcam setMirror 1
```

### Legacy preview commands

The old in-popup Qt preview was replaced by the hub; these commands remain for existing scripts and now map onto the virtual camera:

```bash
omarchy-shell io.github.larry.webcam getPreview
# active | busy | inactive | disconnected | permission
omarchy-shell io.github.larry.webcam setPreviewActive 1   # starts the virtual camera
omarchy-shell io.github.larry.webcam setPreviewActive 0   # stops it
```

## White balance note

The manual color-temperature control only trades red against blue — the sensor's green gain is fixed — so rooms lit by LEDs or fluorescents often cannot be neutralized manually (the measured best case still shows a green-dominant tint). Auto white balance adjusts all three channels and produces a near-perfect neutral; keep it on unless you want a deliberate stylistic warm/cool shift.

## Testing

Two suites live in `tests/`, both plain `node` with no dependencies:

1. **Model unit tests** (`node tests/model.test.js`): offline validation of the discovery chain (`--list-devices` parsing, batched `--info` probe, node classification, loopback picking), control/format parsers against captured fixtures of real hardware (probe output in `tests/fixtures/`), the dynamic settings layout, dependency activity rules, hardware-driven defaults/reset command phasing, and all command builders including the hub, the stale-hub cleanup, photo, record, and preview pipelines.

2. **Live hardware tests** (`node tests/hardware.test.js`): discovers whatever capture device is connected (skips cleanly with exit 0 when none), then exercises a set/read/restore round trip for brightness and the capture mode, a JPEG photo capture, and a short SIGINT-finalized MP4 recording. Virtual-camera hub tests run only when v4l2loopback nodes are present. The camera must be idle (no other app streaming) and state is restored on exit.

```bash
node tests/model.test.js
node tests/hardware.test.js
```

## License

MIT License. See [LICENSE](LICENSE) for details.
