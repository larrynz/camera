import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Generic webcam hub module.
//
// State model:
//   - Discovery: `v4l2-ctl --list-devices` groups -> one `--info` probe for all
//     nodes -> classify each node (capture / loopback / other). Cameras are
//     represented by their capture node; loopback nodes feed the virtual hub.
//   - Hub: a single ffmpeg process mirrors the physical camera into the
//     v4l2loopback device(s). hubState: "off" | "starting" | "running" | "error".
//   - Capture: photos and recordings read from the hub when it runs (helper
//     loopback preferred), otherwise straight from the physical device.
//   - Everything on the physical device (control writes, capture-mode
//     changes) goes through a serial command queue so v4l2 ioctls never race.
Item {
  id: root

  property var bar
  property string moduleName: "io.github.larrynz.webcam"
  property var settings

  readonly property bool vertical: bar ? bar.vertical : false
  implicitWidth: vertical ? (bar ? bar.barSize : 26) : row.implicitWidth + 14
  implicitHeight: vertical ? row.implicitHeight + 10 : (bar ? bar.barSize : 26)

  // The shell owns bar legibility: barForeground is the theme color on a
  // solid bar; in transparent mode the shell samples the desktop behind the
  // bar and picks a contrast color (black over light backgrounds). Built-in
  // widgets use the same token (e.g. ActiveWindow, media BarWidget).
  readonly property color iconColor: bar && bar.barForeground !== undefined
    ? bar.barForeground
    : "white"

  // ---- discovery ---------------------------------------------------------
  property string device: "" // active capture node
  property var cameras: [] // [{ name, bus, captureNode }]
  property var loopbacks: [] // [{ node, card }]
  property var pickedLoopbacks: ({ main: null, helper: null })
  property var pendingGroups: []
  property string probedNodesKey: ""
  property bool probeDone: false

  // ---- device state ------------------------------------------------------
  property bool devicePresent: false
  property bool permissionDenied: false
  property bool hasCameractrls: false
  property bool fovAvailable: false
  property var fovControl: ({}) // { value, options }
  property var pendingFov: null
  property bool refreshPending: false
  property int listGeneration: 0
  property var controls: ({})
  property var captureMode: ({})
  property var captureFormats: []
  property bool captureFormatsQueried: false
  property bool captureBusy: false
  property int pendingCaptureCount: 0
  // Capture-mode defaulting: bump to preferred size at highest fps once per
  // camera; explicit user selections win for the rest of the session.
  property bool userSelectedMode: false
  property bool preferredModeAttempted: false
  property string modelName: "No camera connected"
  property var commandQueue: []
  property bool isDragging: false

  // ---- virtual camera hub -----------------------------------------------
  property string hubState: "off" // off | starting | running | error
  property bool hubStopping: false
  property bool pendingHubRestart: false
  property bool loopbackInstalled: false
  property bool loopbackLoaded: false

  // ---- capture ----------------------------------------------------------
  property bool recording: false
  property int recSeconds: 0
  property string recPath: ""
  property bool photoBusy: false
  property string lastCaptureMessage: ""
  property bool mirrorPreview: false

  // Persisted user state (survives shell restarts via the state file)
  property bool rawPhoto: false
  property string photoFormat: "jpg"
  property string recFormat: "mp4"
  property bool micOn: false
  property string micSource: ""
  property bool hubEnabled: false
  property bool orphanCleanupDone: false
  property bool stateLoaded: false
  property string pendingDevice: ""

  // =========================================================================
  // Popup interactions
  // =========================================================================

  function close() {
    popup.open = false
  }

  function open() {
    if (popup.open) {
      refresh()
      return
    }
    popup.open = true
    refresh()
  }

  function toggle() {
    if (popup.open) close()
    else open()
  }

  function triggerPress(button) { root.toggle() }

  // =========================================================================
  // Discovery
  // =========================================================================

  // =========================================================================
  // Persisted state (~/.local/state/io.github.larrynz.webcam.json)
  // =========================================================================

  FileView {
    id: stateFile
    path: Quickshell.env("HOME") + "/.local/state/io.github.larrynz.webcam.json"
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadState(text())
    onLoadFailed: function(error) { root.loadState("") }
  }

  function loadState(text) {
    var s = null
    try { s = JSON.parse(String(text || "{}")) } catch (e) { s = null }
    if (!s || typeof s !== "object") s = {}
    if (s.mirrorPreview !== undefined) root.mirrorPreview = !!s.mirrorPreview
    if (s.rawPhoto !== undefined) root.rawPhoto = !!s.rawPhoto
    if (s.photoFormat === "png" || s.photoFormat === "jpg") root.photoFormat = s.photoFormat
    if (s.recFormat === "mp4" || s.recFormat === "mkv") root.recFormat = s.recFormat
    if (s.micOn !== undefined) root.micOn = !!s.micOn
    if (typeof s.micSource === "string") root.micSource = s.micSource
    if (typeof s.device === "string" && s.device !== "") root.pendingDevice = s.device
    if (s.hubEnabled !== undefined) root.hubEnabled = !!s.hubEnabled
    root.stateLoaded = true
    root.applyPersistedDevice()
    root.maybeAutoStartHub()
  }

  function applyPersistedDevice() {
    if (root.pendingDevice === "") return
    var want = root.pendingDevice
    root.pendingDevice = ""
    if (root.cameras.length === 0) {
      // cameras not discovered yet — keep the wish; applyCameras honors it
      root.pendingDevice = want
      return
    }
    var found = false
    for (var i = 0; i < root.cameras.length; i++) {
      if (root.cameras[i].captureNode === want) { found = true; break }
    }
    if (found) {
      if (root.device !== want) root.switchTo(root.cameras[i])
    } else {
      // persisted camera no longer present — fall back to the first
      if (root.device !== root.cameras[0].captureNode) root.switchTo(root.cameras[0])
    }
  }

  function saveState() {
    var s = {
      mirrorPreview: root.mirrorPreview,
      rawPhoto: root.rawPhoto,
      photoFormat: root.photoFormat,
      recFormat: root.recFormat,
      micOn: root.micOn,
      micSource: root.micSource,
      device: root.device,
      hubEnabled: root.hubEnabled
    }
    stateFile.setText(JSON.stringify(s, null, 2) + "\n")
  }

  // Auto-start the hub when the persisted switch says on and the system is
  // ready (covers shell restarts; the self-healing start clears orphans).
  function maybeAutoStartHub() {
    if (!root.stateLoaded) return
    if (hubProc.running) return
    if (!root.loopbackReady()) return
    if (!root.devicePresent || root.permissionDenied) return
    if (!root.hubEnabled) {
      // Hub disabled, but a crashed shell leaves an orphaned hub ffmpeg
      // still holding the camera (LED on while the app reports off).
      // Clear it once so the app and hardware agree.
      if (!root.orphanCleanupDone) {
        root.orphanCleanupDone = true
        if (!hubCleanupProc.running) {
          hubCleanupProc.spawnAfter = false
          hubCleanupProc.command = Model.buildHubCleanupCommand()
          hubCleanupProc.running = true
        }
      }
      return
    }
    root.startHub()
  }

  function refresh() {
    if (!listDevicesProc.running) listDevicesProc.running = true
    if (!detectCameractrlsProc.running) detectCameractrlsProc.running = true
    root.checkLoopbackState()
    if (root.device !== "") root.startDeviceCheck()
  }

  function checkLoopbackState() {
    if (!loopbackLoadedProc.running) loopbackLoadedProc.running = true
    if (!loopbackInstalledProc.running) loopbackInstalledProc.running = true
  }

  function applyCameras(cams) {
    root.cameras = cams || []
    var selected = null
    for (var i = 0; i < root.cameras.length; i++) {
      if (root.cameras[i].captureNode === root.device) {
        selected = root.cameras[i]
        break
      }
    }
    if (!selected && root.pendingDevice !== "") {
      for (var j = 0; j < root.cameras.length; j++) {
        if (root.cameras[j].captureNode === root.pendingDevice) {
          selected = root.cameras[j]
          break
        }
      }
    }
    if (!selected && root.cameras.length > 0) selected = root.cameras[0]
    if (selected && root.pendingDevice === selected.captureNode) root.pendingDevice = ""

    if (!selected) {
      root.listGeneration++
      root.commandQueue = []
      root.pendingCaptureCount = 0
      if (hubProc.running) {
        root.pendingHubRestart = false
        root.stopHubInternal()
      }
      root.device = ""
      root.modelName = "No camera connected"
      root.devicePresent = false
      root.permissionDenied = false
      root.controls = ({})
      root.fovControl = ({})
      root.fovAvailable = false
      root.pendingFov = null
      root.captureMode = ({})
      root.captureFormats = []
      root.captureFormatsQueried = false
      root.captureBusy = false
      return
    }

    if (selected.captureNode === root.device) {
      root.modelName = selected.name || root.modelName
      if (!root.isDragging) root.readControls()
      return
    }
    root.switchTo(selected)
  }

  function switchTo(cam) {
    if (!cam || !cam.captureNode) return
    root.listGeneration++
    root.commandQueue = []
    root.pendingCaptureCount = 0
    if (root.hubActive()) {
      // restart the hub on the new device once it is verified
      root.pendingHubRestart = true
      root.stopHubInternal()
    }
    root.device = cam.captureNode
    if (/v4l2loopback/i.test(String(cam.captureNode))) {
      // Guard: the pipeline must never select a loopback as the active
      // camera. If this ever fires, the journal shows who did it.
      console.warn("[webcam] device set to loopback node:", cam.captureNode,
          "name:", cam.name, "stack:", new Error().stack)
    }
    root.modelName = cam.name || "Camera"
    root.permissionDenied = false
    root.devicePresent = false
    root.controls = ({})
    root.fovControl = ({})
    root.fovAvailable = false
    root.pendingFov = null
    root.captureMode = ({})
    root.captureFormats = []
    root.captureFormatsQueried = false
    root.captureBusy = false
    root.userSelectedMode = false
    root.preferredModeAttempted = false
    root.startDeviceCheck()
    // Persist the last-used camera, but never before the saved state has
    // loaded (a startup discovery must not overwrite it with defaults).
    if (root.stateLoaded) root.saveState()
  }

  function startDeviceCheck() {
    if (root.device === "") return
    if (checkDeviceProc.running) return
    checkDeviceProc.queryDevice = root.device
    checkDeviceProc.running = true
  }

  function readControls() {
    if (!root.devicePresent || root.permissionDenied) return
    var v4l2Busy = v4l2ListProc.running
    var fovBusy = root.fovAvailable && cameractrlsListProc.running
    if (v4l2Busy || fovBusy) {
      root.refreshPending = true
      return
    }
    if (!v4l2ListProc.running) {
      v4l2ListProc.queryGeneration = root.listGeneration
      v4l2ListProc.queryDevice = root.device
      v4l2ListProc.running = true
    }
    if (popup.open && root.fovAvailable && !cameractrlsListProc.running) {
      cameractrlsListProc.queryGeneration = root.listGeneration
      cameractrlsListProc.queryDevice = root.device
      cameractrlsListProc.running = true
    }
  }

  // =========================================================================
  // Command queue (control writes + capture-mode changes, serialized)
  // =========================================================================

  function queueCommand(cmd, kind, device, photoPath) {
    if (!cmd || !cmd.length) return
    var entry = { cmd: cmd, kind: kind || "control" }
    if (device) entry.device = device
    if (photoPath) entry.photoPath = photoPath
    root.commandQueue.push(entry)
    root.pumpCommandQueue()
  }

  function pumpCommandQueue() {
    if (cmdExecProc.running || root.commandQueue.length === 0) return
    var nextItem = root.commandQueue[0]
    var nextKind = nextItem.kind || "control"
    // capture-mode changes must wait while a physical-device recording is active
    if (nextKind === "capture" && root.recording && root.hubState !== "running") return
    root.commandQueue.shift()
    cmdExecProc.currentKind = nextKind
    cmdExecProc.currentDevice = ""
    cmdExecProc.currentPhotoPath = ""
    if (nextKind === "capture") {
      // wait briefly for whoever holds the device to let go, then run
      var targetDev = nextItem.device || root.device
      cmdExecProc.currentDevice = targetDev
      cmdExecProc.command = ["sh", "-c", "for i in $(seq 1 15); do if ! fuser \"$1\" >/dev/null 2>&1; then break; fi; sleep 0.05; done; shift; exec \"$@\"", "--", targetDev].concat(nextItem.cmd)
    } else {
      if (nextKind === "photo") cmdExecProc.currentPhotoPath = nextItem.photoPath || ""
      cmdExecProc.command = nextItem.cmd
    }
    cmdExecProc.running = true
  }

  // =========================================================================
  // Control reads / writes
  // =========================================================================

  function getCtrl(name) {
    if (name === Model.FOV_CONTROL) {
      if (root.pendingFov !== null) return String(root.pendingFov)
      if (root.fovControl && root.fovControl.value !== undefined) return String(root.fovControl.value)
      return String(Model.CONTROL_META[Model.FOV_CONTROL].defaultVal)
    }
    if (root.controls && root.controls[name] && root.controls[name].value !== undefined) {
      return String(root.controls[name].value)
    }
    return ""
  }

  function setCtrl(name, value) {
    root.setControl(name, value)
  }

  function setControl(name, value) {
    if (name === "mirror" || name === "hflip" || name === "vflip" || name === "horizontal_flip") return
    var numVal = Number(value)
    if (isNaN(numVal)) return
    if (name === Model.FOV_CONTROL) {
      if (!root.fovAvailable) {
        if (root.hasCameractrls && cameractrlsListProc.running) root.pendingFov = numVal
        return
      }
      root.listGeneration++
      root.fovControl = { value: numVal, options: root.fovControl ? root.fovControl.options : undefined }
      root.queueCommand(Model.buildFovSetCommand(root.device, numVal))
      return
    }
    root.listGeneration++
    var updated = Object.assign({}, root.controls)
    if (!updated[name]) updated[name] = { name: name, value: numVal }
    else updated[name] = Object.assign({}, updated[name], { value: numVal })
    root.controls = updated
    root.queueCommand(Model.buildV4l2SetCommand(root.device, name, numVal))
  }

  function resetDefaults() {
    if (!root.device) return
    root.listGeneration++
    var copy = Object.assign({}, root.controls)
    if (root.fovAvailable) {
      copy[Model.FOV_CONTROL] = {
        name: Model.FOV_CONTROL,
        backend: "cameractrls",
        defaultVal: Model.CONTROL_META[Model.FOV_CONTROL].defaultVal,
        default: Model.CONTROL_META[Model.FOV_CONTROL].defaultVal
      }
    } else if (root.hasCameractrls && cameractrlsListProc.running) {
      root.pendingFov = Model.CONTROL_META[Model.FOV_CONTROL].defaultVal
    }
    var cmds = Model.buildResetCommands(root.device, copy)
    for (var i = 0; i < cmds.length; i++) {
      root.queueCommand(cmds[i])
    }
    var defaults = Model.getDefaults(copy)
    var updated = Object.assign({}, root.controls)
    for (var k in defaults) {
      if (!Object.prototype.hasOwnProperty.call(defaults, k)) continue
      if (!updated[k]) updated[k] = { name: k }
      updated[k] = Object.assign({}, updated[k], { value: defaults[k] })
    }
    root.controls = updated
    if (root.fovAvailable) {
      root.fovControl = {
        value: Model.CONTROL_META[Model.FOV_CONTROL].defaultVal,
        options: root.fovControl ? root.fovControl.options : undefined
      }
    }
    // Reset persisted popup settings too — everything back to factory state.
    root.mirrorPreview = false
    root.rawPhoto = false
    root.photoFormat = "jpg"
    root.recFormat = "mp4"
    root.micOn = false
    root.micSource = ""
    root.saveState()
  }

  // =========================================================================
  // Capture mode (resolution / pixel format / frame rate)
  // =========================================================================

  function getCaptureMode() {
    if (root.captureMode && root.captureMode.width !== undefined && root.captureMode.height !== undefined) {
      var fpsStr = root.captureMode.fps !== undefined ? ("@" + root.captureMode.fps) : ""
      var pfStr = root.captureMode.pixelformat ? (" " + root.captureMode.pixelformat) : ""
      return root.captureMode.width + "x" + root.captureMode.height + fpsStr + pfStr
    }
    return ""
  }

  function applyCaptureMode(picked, fromUser) {
    if (!picked) return
    if (fromUser) root.userSelectedMode = true
    var cur = root.captureMode || {}
    if (picked.width === cur.width && picked.height === cur.height
        && picked.fps === cur.fps && picked.pixelformat === cur.pixelformat) return
    root.listGeneration++
    root.pendingCaptureCount++
    root.captureMode = picked
    if (root.hubActive()) {
      // ffmpeg negotiated the old format at open; stop it, apply, restart
      root.pendingHubRestart = true
      root.stopHubInternal()
    }
    root.queueCommand(Model.buildV4l2SetCaptureModeCommand(root.device, picked), "capture", root.device)
  }

  function setCaptureMode(width, height, fps) {
    var picked = Model.pickCaptureMode(root.captureFormats, root.captureMode, width, height, fps)
    root.applyCaptureMode(picked, true)
  }

  // One-time-per-camera default: bump the camera off its power-on mode
  // (e.g. YUYV 1280x720@10) to the preferred size at the highest frame rate
  // the hardware offers for it (e.g. MJPG 1280x720@30 on USB-2 cameras).
  // Explicit user selections win for the rest of the session; switching
  // cameras re-runs the default on the new device. Best-effort: if the
  // camera is busy the set fails once and is not retried this session.
  function maybeApplyPreferredCaptureMode() {
    if (root.userSelectedMode || root.preferredModeAttempted) return
    if (!root.devicePresent || root.permissionDenied) return
    if (!root.captureFormats || !root.captureFormats.length) return
    if (!root.captureMode || root.captureMode.width === undefined) return
    root.preferredModeAttempted = true
    var preferred = Model.pickPreferredCaptureMode(root.captureFormats, root.captureMode)
    if (preferred) root.applyCaptureMode(preferred, false)
  }

  function setCaptureModeFromIpc(resolution, fps) {
    if (!resolution || !/^\d+x\d+$/.test(resolution)) return
    var parts = resolution.split("x")
    var w = parseInt(parts[0], 10)
    var h = parseInt(parts[1], 10)
    if (w <= 0 || h <= 0) return
    var f = undefined
    if (fps !== undefined && fps !== null && fps !== "") {
      var parsedFps = Number(fps)
      if (!isFinite(parsedFps) || isNaN(parsedFps) || parsedFps <= 0) return
      f = parsedFps
    }
    root.setCaptureMode(w, h, f)
  }

  // =========================================================================
  // Virtual camera hub
  // =========================================================================

  function hubActive() {
    return root.hubState === "starting" || root.hubState === "running"
  }

  function loopbackReady() {
    return root.loopbackLoaded
      && root.pickedLoopbacks
      && root.pickedLoopbacks.main != null
      && !!root.pickedLoopbacks.main.node
  }

  function startHub() {
    if (hubProc.running) return false
    if (!root.loopbackReady()) return false
    if (!root.devicePresent || root.permissionDenied) return false
    // Phase 1: kill stale hub ffmpeg processes first. A crashed shell leaves
    // its hub ffmpeg orphaned, still holding the loopback devices — the fresh
    // start then fails with "Device or resource busy" and parks in error.
    // hubCleanupProc.onExited does the actual spawn.
    root.hubState = "starting"
    hubCleanupProc.spawnAfter = true
    hubCleanupProc.command = Model.buildHubCleanupCommand()
    hubCleanupProc.running = true
    return true
  }

  function spawnHub() {
    var p = root.pickedLoopbacks
    var outputs = [p.main.node]
    if (p.helper && p.helper.node && p.helper.node !== p.main.node) {
      outputs.push(p.helper.node)
    }
    // Pass the full capture mode so the hub pins -input_format/-video_size —
    // otherwise ffmpeg's indev renegotiates the device format at open.
    hubProc.command = Model.buildHubCommand(root.device, outputs, root.captureMode)
    root.hubStopping = false
    root.hubState = "starting"
    hubProc.running = true
    hubConfirmTimer.restart()
  }

  function stopHub() {
    root.pendingHubRestart = false
    root.stopHubInternal()
  }

  function stopHubInternal() {
    if (!hubProc.running) {
      root.hubState = "off"
      root.hubStopping = false
      return
    }
    root.hubStopping = true
    hubProc.signal(15) // SIGTERM; ffmpeg flushes and exits
    hubStopWatchdog.restart() // SIGKILL fallback
  }

  function applyCaptureOption(key, value) {
    if (key === "mirrorPreview") root.mirrorPreview = (value === "true" || value === true)
    else if (key === "rawPhoto") root.rawPhoto = (value === "true" || value === true)
    else if (key === "photoFormat") root.photoFormat = (value === "png") ? "png" : "jpg"
    else if (key === "recFormat") root.recFormat = (value === "mkv") ? "mkv" : "mp4"
    else if (key === "micOn") root.micOn = (value === "true" || value === true)
    else if (key === "micSource") root.micSource = String(value || "")
    else return
    root.saveState()
  }

  // Single hub on/off entry point — persists the switch so the state file,
  // the app UI and the hardware (webcam LED) stay in sync across restarts.
  // IPC handlers must use this, not startHub/stopHub directly.
  function setHubEnabled(flag) {
    if (flag) {
      root.hubEnabled = true
      root.saveState()
      return root.startHub()
    }
    root.hubEnabled = false
    root.stopHub()
    root.saveState()
    return true
  }

  function toggleHub() {
    setHubEnabled(!root.hubActive())
  }

  // Restart after a capture-mode change or device switch, once the new state
  // has settled (queue drained, hub process gone, device verified).
  function maybeRestartHub() {
    if (!root.pendingHubRestart) return
    if (hubProc.running) return
    if (root.commandQueue.length > 0) return
    if (!root.devicePresent || root.permissionDenied) return
    root.pendingHubRestart = false
    hubRestartTimer.restart()
  }

  // =========================================================================
  // Photo / recording / preview
  // =========================================================================

  // Photos and recordings read from the hub when it runs (helper loopback
  // preferred so the main virtual camera stays free for consumers), otherwise
  // straight from the physical device.
  function captureSource() {
    // Main loopback first: the helper is the viewfinder's device (held open
    // while the popup is live — a second reader gets "Device or resource
    // busy"). Main verified multi-reader; physical camera when hub is off.
    if (root.hubState === "running") {
      var p = root.pickedLoopbacks || {}
      if (p.main && p.main.node) return p.main.node
    }
    return root.device
  }

  function displayPath(p) {
    var s = String(p || "")
    if (s.indexOf("$HOME") === 0) return "~" + s.slice(5)
    return s
  }

  function takePhoto(format) {
    if (!root.devicePresent || root.permissionDenied) return ""
    if (root.photoBusy) return ""
    if (root.hubState === "starting") return ""
    var src = root.captureSource()
    if (!src) return ""
    var ext = (format === "png") ? ".png" : ".jpg"
    var path = "$HOME/Pictures/webcam-" + Model.formatTimestamp(new Date()) + ext
    root.photoBusy = true
    root.lastCaptureMessage = "Taking photo…"
    root.queueCommand(Model.buildPhotoCommand(src, path), "photo", "", path)
    return path
  }

  function startRecording(format, micSource) {
    if (root.recording) return ""
    if (!root.devicePresent || root.permissionDenied) return ""
    if (root.hubState === "starting") return ""
    var src = root.captureSource()
    if (!src) return ""
    var ext = (format === ".mkv") ? ".mkv" : ".mp4"
    var path = "$HOME/Videos/webcam-" + Model.formatTimestamp(new Date()) + ext
    root.recPath = path
    root.recSeconds = 0
    root.recording = true
    recProc.killed = false
    recProc.command = Model.buildRecordCommand(src, path, micSource || "")
    recProc.running = true
    recTimer.restart()
    return path
  }

  // SIGINT so ffmpeg finalizes the MP4 (writes the moov atom); the watchdog
  // escalates to SIGKILL if it hangs.
  function stopRecording() {
    if (!root.recording) return
    recProc.signal(2)
    recKillWatchdog.restart()
  }

  function toggleRecording() {
    if (root.recording) root.stopRecording()
    else root.startRecording()
  }

  // =========================================================================
  // Legacy preview IPC (maps onto the hub) + mirror
  // =========================================================================

  function getPreview() {
    if (!root.devicePresent) return "disconnected"
    if (root.permissionDenied) return "permission"
    if (root.hubState === "running") return "active"
    if (root.hubState === "starting") return "busy"
    return "inactive"
  }

  function setPreviewActive(active) {
    var flag = Model.parseFlag(active)
    if (flag === null) return
    root.setHubEnabled(flag)
  }

  function getMirror() {
    return root.mirrorPreview ? "1" : "0"
  }

  function setMirror(enabled) {
    var flag = Model.parseFlag(enabled)
    if (flag === null) return
    root.mirrorPreview = flag
    root.saveState()
  }

  // =========================================================================
  // Device / camera selection
  // =========================================================================

  function getDevice() {
    return root.device
  }

  function setDevice(path) {
    if (!path || path === root.device) return
    for (var i = 0; i < root.cameras.length; i++) {
      if (root.cameras[i].captureNode === path) {
        root.switchTo(root.cameras[i])
        return
      }
    }
  }

  function listDevices() {
    var out = []
    for (var i = 0; i < root.cameras.length; i++) {
      out.push({ path: root.cameras[i].captureNode, name: root.cameras[i].name || "" })
    }
    return JSON.stringify(out)
  }

  function listCameras() {
    var out = []
    for (var i = 0; i < root.cameras.length; i++) {
      out.push({ index: i, path: root.cameras[i].captureNode, name: root.cameras[i].name || "" })
    }
    return JSON.stringify(out)
  }

  function selectCamera(index) {
    var i = parseInt(index, 10)
    if (isNaN(i) || i < 0 || i >= root.cameras.length) return
    root.setDevice(root.cameras[i].captureNode)
  }

  // =========================================================================
  // IPC
  // =========================================================================

  IpcHandler {
    target: "io.github.larrynz.webcam"

    function open() { root.open() }
    function close() { root.close() }
    function toggle() { root.toggle() }
    function resetDefaults() { root.resetDefaults() }
    function getCtrl(name: string): string { return root.getCtrl(name) }
    function setCtrl(name: string, value: string) { root.setCtrl(name, value) }
    function getCaptureMode(): string { return root.getCaptureMode() }
    function setCaptureMode(resolution: string, fps: string) { root.setCaptureModeFromIpc(resolution, fps) }
    function getDevice(): string { return root.getDevice() }
    function setDevice(path: string) { root.setDevice(path) }
    function listDevices(): string { return root.listDevices() }
    function listCameras(): string { return root.listCameras() }
    function selectCamera(index: string) { root.selectCamera(index) }
    function virtualCam(mode: string): bool { return root.virtualCam(mode) }
    function virtualCamStatus(): string { return root.hubState }
    function glyphColor(): string { return String(root.iconColor) }
    function takePhoto(): string { return root.takePhoto() }
    function startRecording(format: string, mic: string): string { return root.startRecording(format, mic) }
    function stopRecording() { root.stopRecording() }
    function getPreview(): string { return root.getPreview() }
    function setPreviewActive(active: string) { root.setPreviewActive(active) }
    function getMirror(): string { return root.getMirror() }
    function setMirror(enabled: string) { root.setMirror(enabled) }
  }

  function virtualCam(mode) {
    var m = String(mode === undefined || mode === null ? "" : mode).trim().toLowerCase()
    if (m === "on") return root.setHubEnabled(true)
    if (m === "off") return root.setHubEnabled(false)
    root.toggleHub()
    return root.hubActive()
  }

  // =========================================================================
  // Processes
  // =========================================================================

  Process {
    id: listDevicesProc
    property string stdoutText: ""
    command: Model.buildListDevicesCommand()
    stdout: StdioCollector {
      id: listDevicesOut
      waitForEnd: true
      onStreamFinished: listDevicesProc.stdoutText = text
    }
    onExited: function(exitCode) {
      var raw = listDevicesProc.stdoutText || listDevicesOut.text || ""
      listDevicesProc.stdoutText = ""
      var groups = (exitCode === 0 || raw !== "") ? Model.parseV4l2ListDevices(raw) : []
      root.pendingGroups = groups
      if (groups.length === 0) {
        root.probedNodesKey = ""
        root.probeDone = true
        root.loopbacks = []
        root.pickedLoopbacks = ({ main: null, helper: null })
        root.applyCameras([])
        return
      }
      var nodes = []
      for (var g = 0; g < groups.length; g++) {
        for (var n = 0; n < groups[g].nodes.length; n++) nodes.push(groups[g].nodes[n])
      }
      var key = nodes.join(" ")
      if (root.probeDone && key === root.probedNodesKey) return // node set unchanged
      root.probedNodesKey = key
      probeProc.stdoutText = ""
      probeProc.command = Model.buildProbeCommand(nodes)
      probeProc.running = true
    }
  }

  Process {
    id: probeProc
    property string stdoutText: ""
    command: ["sh", "-c", "exit 0"]
    stdout: StdioCollector {
      id: probeOut
      waitForEnd: true
      onStreamFinished: probeProc.stdoutText = text
    }
    onExited: {
      var raw = probeProc.stdoutText || probeOut.text || ""
      probeProc.stdoutText = ""
      root.probeDone = true
      var infos = Model.parseProbeOutput(raw)
      var groups = root.pendingGroups || []
      var loopbacks = []
      var cams = []
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g]
        var captureNode = ""
        for (var n = 0; n < group.nodes.length; n++) {
          var node = group.nodes[n]
          var info = infos[node]
          var cls = Model.classifyNode(info)
          if (cls === "loopback") {
            loopbacks.push({ node: node, card: (info && info.card) ? info.card : group.name })
          } else if (cls === "capture" && captureNode === "") {
            captureNode = node
          }
        }
        if (captureNode !== "") {
          cams.push({ name: group.name, bus: group.bus, captureNode: captureNode })
        }
      }
      root.loopbacks = loopbacks
      root.pickedLoopbacks = Model.pickLoopbacks(loopbacks)
      root.applyCameras(cams)
    }
  }

  Process {
    id: checkDeviceProc
    property string queryDevice: ""
    command: ["sh", "-c", "test -e \"$1\" || exit 2; test -r \"$1\" && test -w \"$1\" || exit 3; exit 0", "--", root.device]
    onExited: function(exitCode) {
      if (checkDeviceProc.queryDevice !== root.device) {
        root.startDeviceCheck()
        return
      }
      root.devicePresent = (exitCode === 0 || exitCode === 3)
      root.permissionDenied = (exitCode === 3)
      if (root.devicePresent && !root.permissionDenied) {
        if (!root.captureFormatsQueried && !v4l2FormatsProc.running) {
          root.captureFormatsQueried = true
          v4l2FormatsProc.queryDevice = root.device
          v4l2FormatsProc.running = true
        }
        if (root.hasCameractrls && !root.fovAvailable && !cameractrlsListProc.running) {
          cameractrlsListProc.queryGeneration = root.listGeneration
          cameractrlsListProc.queryDevice = root.device
          cameractrlsListProc.running = true
        }
        root.readControls()
        root.maybeRestartHub()
      } else {
        root.fovAvailable = false
        root.pendingFov = null
        root.captureFormats = []
        root.captureFormatsQueried = false
        root.captureMode = ({})
        root.captureBusy = false
        root.commandQueue = []
        root.pendingCaptureCount = 0
      }
    }
  }

  Process {
    id: detectCameractrlsProc
    command: ["sh", "-c", "command -v cameractrls"]
    onExited: function(exitCode) {
      root.hasCameractrls = (exitCode === 0)
      if (root.hasCameractrls && root.devicePresent && (!root.fovAvailable || popup.open)) {
        if (!cameractrlsListProc.running) {
          cameractrlsListProc.queryGeneration = root.listGeneration
          cameractrlsListProc.queryDevice = root.device
          cameractrlsListProc.running = true
        }
      } else if (exitCode !== 0) {
        root.fovAvailable = false
        root.pendingFov = null
      }
    }
  }

  Process {
    id: v4l2FormatsProc
    property string queryDevice: ""
    command: Model.buildV4l2ListFormatsCommand(root.device)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (v4l2FormatsProc.queryDevice !== root.device) return
        var fmts = Model.parseV4l2Formats(text)
        if (fmts && fmts.length > 0) {
          root.captureFormats = fmts
          root.maybeApplyPreferredCaptureMode()
        }
      }
    }
    onExited: {
      if (v4l2FormatsProc.queryDevice !== root.device) {
        root.captureFormatsQueried = false
        if (root.device !== "" && root.devicePresent && !root.permissionDenied && !v4l2FormatsProc.running) {
          root.captureFormatsQueried = true
          v4l2FormatsProc.queryDevice = root.device
          v4l2FormatsProc.running = true
        }
      }
    }
  }

  Process {
    id: v4l2ListProc
    property int queryGeneration: 0
    property string queryDevice: ""
    command: Model.buildV4l2ListCommand(root.device)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (v4l2ListProc.queryGeneration !== root.listGeneration) return
        if (v4l2ListProc.queryDevice !== root.device) return
        if (!text) return
        var parsed = Model.parseV4l2Ctrls(text)
        if (parsed && Object.keys(parsed).length > 0) {
          root.controls = parsed
          root.devicePresent = true
        }
        var parsedMode = Model.parseV4l2CaptureMode(text)
        if (parsedMode && parsedMode.width !== undefined) {
          root.captureMode = parsedMode
          root.maybeApplyPreferredCaptureMode()
        }
      }
    }
    onExited: function(exitCode) {
      var sameRead = v4l2ListProc.queryDevice === root.device && v4l2ListProc.queryGeneration === root.listGeneration
      if (sameRead && exitCode !== 0) root.devicePresent = false
      if (root.refreshPending && !cameractrlsListProc.running) {
        root.refreshPending = false
        root.readControls()
      }
    }
  }

  Process {
    id: cameractrlsListProc
    property int queryGeneration: 0
    property string queryDevice: ""
    property bool foundFov: false
    command: Model.buildFovListCommand(root.device)
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        cameractrlsListProc.foundFov = false
        if (!text) return
        var parsed = Model.parseCameractrls(text)
        if (parsed && parsed[Model.FOV_CONTROL] !== undefined) {
          cameractrlsListProc.foundFov = true
          if (cameractrlsListProc.queryDevice === root.device && cameractrlsListProc.queryGeneration === root.listGeneration) {
            root.fovControl = parsed[Model.FOV_CONTROL]
          }
        }
      }
    }
    onExited: function(exitCode) {
      var sameDevice = cameractrlsListProc.queryDevice === root.device
      if (exitCode === 0 && cameractrlsListProc.foundFov) {
        if (sameDevice) {
          root.fovAvailable = true
          if (root.pendingFov !== null) {
            var val = root.pendingFov
            root.pendingFov = null
            root.setControl(Model.FOV_CONTROL, val)
          }
        }
      } else if (sameDevice && cameractrlsListProc.queryGeneration === root.listGeneration) {
        root.fovAvailable = false
        root.pendingFov = null
      }
      if (root.refreshPending && !v4l2ListProc.running) {
        root.refreshPending = false
        root.readControls()
      }
    }
  }

  Process {
    id: cmdExecProc
    property string currentKind: ""
    property string currentDevice: ""
    property string currentPhotoPath: ""
    onExited: function(exitCode) {
      if (cmdExecProc.currentKind === "capture") {
        root.pendingCaptureCount = Math.max(0, root.pendingCaptureCount - 1)
        if (cmdExecProc.currentDevice === root.device) {
          root.captureBusy = (exitCode !== 0)
        }
      } else if (cmdExecProc.currentKind === "photo") {
        root.photoBusy = false
        if (exitCode === 0 && cmdExecProc.currentPhotoPath !== "") {
          root.lastCaptureMessage = "Saved to " + root.displayPath(cmdExecProc.currentPhotoPath)
        } else {
          root.lastCaptureMessage = "Photo failed"
        }
      }
      if (root.commandQueue.length > 0) {
        root.pumpCommandQueue()
      } else {
        root.maybeRestartHub()
        root.readControls()
      }
    }
  }

  // Two-phase hub start: phase 1 clears stale (orphaned) hub ffmpeg
  // processes that hold the loopback devices; phase 2 spawns the fresh hub.
  Process {
    id: hubCleanupProc
    // When spawnAfter is set (the startHub path) the fresh hub spawns after
    // the cleanup; the startup orphan cleanup leaves it unset so a disabled
    // hub stays off.
    property bool spawnAfter: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) { if (spawnAfter) root.spawnHub() }
  }

  Process {
    id: hubProc
    command: ["sh", "-c", "exit 0"]
    onExited: function(exitCode) {
      hubConfirmTimer.stop()
      hubStopWatchdog.stop()
      var unexpected = !root.hubStopping && exitCode !== 0 && root.devicePresent
      root.hubState = unexpected ? "error" : "off"
      root.hubStopping = false
      root.maybeRestartHub()
    }
  }

  Process {
    id: recProc
    property bool killed: false
    command: ["sh", "-c", "exit 0"]
    onExited: function(exitCode) {
      recKillWatchdog.stop()
      recTimer.stop()
      root.recording = false
      var graceful = !recProc.killed && (exitCode === 0 || exitCode === 255 || exitCode === 130)
      if (graceful) {
        root.lastCaptureMessage = "Saved to " + root.displayPath(root.recPath)
      } else {
        root.lastCaptureMessage = "Recording failed"
      }
      root.pumpCommandQueue()
    }
  }

  Process {
    id: loopbackLoadedProc
    command: Model.buildLoopbackLoadedCommand()
    onExited: function(exitCode) {
      root.loopbackLoaded = (exitCode === 0)
    }
  }

  Process {
    id: loopbackInstalledProc
    command: Model.buildLoopbackInstalledCommand()
    onExited: function(exitCode) {
      root.loopbackInstalled = (exitCode === 0)
    }
  }

  // =========================================================================
  // Timers
  // =========================================================================

  Timer {
    interval: 15000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: 3000
    repeat: true
    running: popup.open && !root.isDragging
    onTriggered: if (root.devicePresent && !root.permissionDenied) root.readControls()
  }

  // ffmpeg takes a moment to open the device and start streaming; treat
  // "starting" as running once it has survived this long.
  Timer {
    id: hubConfirmTimer
    interval: 1200
    onTriggered: if (hubProc.running && root.hubState === "starting") root.hubState = "running"
  }

  // SIGTERM was ignored — escalate.
  Timer {
    id: hubStopWatchdog
    interval: 3000
    onTriggered: if (hubProc.running) hubProc.signal(9)
  }

  // Let the capture-mode change settle before relaunching the hub.
  Timer {
    id: hubRestartTimer
    interval: 600
    onTriggered: root.startHub()
  }

  Timer {
    id: recTimer
    interval: 1000
    repeat: true
    onTriggered: root.recSeconds++
  }

  // SIGINT was ignored — escalate so the UI never sticks in "recording".
  Timer {
    id: recKillWatchdog
    interval: 3000
    onTriggered: if (recProc.running) {
      recProc.killed = true
      recProc.signal(9)
    }
  }

  // =========================================================================
  // UI
  // =========================================================================

  Grid {
    id: row
    anchors.centerIn: parent
    columns: 1

    Text {
      text: "󰄀"
      color: root.hubState === "running" ? Color.accent : root.iconColor
      font.family: bar ? bar.fontFamily : "monospace"
      font.pixelSize: 14
      opacity: root.devicePresent ? 1.0 : 0.4
      horizontalAlignment: Text.AlignHCenter
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onClicked: function(mouse) {
      if (mouse.button === Qt.RightButton) {
        root.toggleHub()
      } else {
        root.toggle()
      }
    }
  }

  CameraPopup {
    id: popup
    anchorItem: root
    bar: root.bar
    owner: root
    devicePresent: root.devicePresent
    permissionDenied: root.permissionDenied
    hasCameractrls: root.hasCameractrls
    fovAvailable: root.fovAvailable
    fovControl: root.fovControl
    controls: root.controls
    captureMode: root.captureMode
    captureFormats: root.captureFormats
    captureBusy: root.captureBusy
    modelName: root.modelName
    devicePath: root.device
    cameras: root.cameras
    hubState: root.hubState
    loopbackInstalled: root.loopbackInstalled
    loopbackLoaded: root.loopbackLoaded
    loopbackMain: root.pickedLoopbacks ? root.pickedLoopbacks.main : null
    loopbackHelper: root.pickedLoopbacks ? root.pickedLoopbacks.helper : null
    recording: root.recording
    recSeconds: root.recSeconds
    photoBusy: root.photoBusy
    lastCaptureMessage: root.lastCaptureMessage
    mirrorPreview: root.mirrorPreview
    rawPhoto: root.rawPhoto
    photoFormat: root.photoFormat
    recFormat: root.recFormat
    micOn: root.micOn
    micSource: root.micSource
    onCaptureOptionChanged: function(key, value) { root.applyCaptureOption(key, value) }
    onDeviceChangeRequested: function(path) { root.setDevice(path) }
    onRecheckRequested: {
      root.probeDone = false
      root.probedNodesKey = ""
      root.refresh()
    }
    onVirtualCamToggleRequested: root.toggleHub()
    onTakePhotoRequested: root.takePhoto(popup.photoFormat)
    onPhotoStateChange: function(busy, message) {
      root.photoBusy = busy
      root.lastCaptureMessage = message
    }
    onRecordToggleRequested: root.recording
      ? root.stopRecording()
      : root.startRecording(popup.recFormat, popup.micOn ? popup.micSource : "")
    onMirrorChangeRequested: function(enabled) { root.mirrorPreview = enabled; root.saveState() }
    onRefreshRequested: root.refresh()
    onControlChanged: function(name, val) { root.setControl(name, val) }
    onCaptureModeRequested: function(w, h, fps) { root.setCaptureMode(w, h, fps) }
    onResetRequested: root.resetDefaults()
    onIsDraggingChanged: root.isDragging = popup.isDragging
  }

  Component.onCompleted: root.refresh()

  onDevicePresentChanged: root.maybeAutoStartHub()
  onLoopbackLoadedChanged: root.maybeAutoStartHub()
}
