// Model.js — Pure JavaScript model for the generic webcam hub: hardware-driven
// V4L2/UVC discovery and capability profiling, v4l2loopback classification,
// ffmpeg hub/photo/record/preview command builders, dynamic settings layout,
// and control/reset logic driven entirely by what the hardware reports.
//
// Dual-environment module: loadable directly in Quickshell QML via:
//   import "Model.js" as Model
// and in Node.js unit tests via require("./Model.js").
//
// The hardware is authoritative: every range, default, and menu item comes from
// `v4l2-ctl` / `cameractrls` output for the selected device. CONTROL_META below
// only carries presentation metadata (labels, categories, units, dependency
// hints) for well-known controls; unknown controls are rendered generically in
// the "Advanced" section.

var DEFAULT_DEVICE = "/dev/video0"

// The single vendor control managed through cameractrls (vendor FOV).
var FOV_CONTROL = "logitech_brio_fov"

var PREFERRED_RESOLUTIONS = [
  [3840, 2160],
  [1920, 1080],
  [1280, 720],
  [640, 480]
]

var PREFERRED_FPS = [60, 30, 24, 15]

var RESOLUTION_TAGS = {
  "3840x2160": "4K",
  "1920x1080": "1080p",
  "1280x720": "720p",
  "640x480": "480p"
}

// Presentation metadata for well-known controls. Kind is inferred from the
// reported type when not pinned here (pantilt is never inferred). Unknown
// controls fall back to humanizeName() and the "Advanced" category.
var CONTROL_META = {
  logitech_brio_fov: {
    label: "Field of View",
    category: "Optics",
    kind: "segmented",
    unit: "\u00B0",
    backend: "cameractrls",
    options: [65, 78, 90],
    defaultVal: 65
  },
  zoom_absolute: { label: "Digital Zoom", category: "Optics", unit: "%" },
  pan_absolute: { label: "Pan", category: "Optics", kind: "pantilt" },
  tilt_absolute: { label: "Tilt", category: "Optics", kind: "pantilt" },
  focus_automatic_continuous: { label: "Autofocus", category: "Optics" },
  focus_absolute: {
    label: "Manual Focus",
    category: "Optics",
    dependsOn: "focus_automatic_continuous",
    activeWhen: false,
    inactiveHint: "Disabled while autofocus is on"
  },
  auto_exposure: { label: "Exposure Mode", category: "Exposure" },
  exposure_time_absolute: {
    label: "Exposure Time",
    category: "Exposure",
    dependsOn: "auto_exposure",
    activeWhen: 1,
    inactiveHint: "Disabled while auto exposure is on"
  },
  exposure_dynamic_framerate: { label: "Low-light Compensation", category: "Exposure" },
  gain: { label: "Sensor Gain", category: "Exposure" },
  white_balance_automatic: { label: "Auto White Balance", category: "Color" },
  white_balance_temperature: {
    label: "Color Temperature",
    category: "Color",
    unit: "K",
    dependsOn: "white_balance_automatic",
    activeWhen: false,
    inactiveHint: "Disabled while auto white balance is on"
  },
  brightness: { label: "Brightness", category: "Color" },
  contrast: { label: "Contrast", category: "Color" },
  saturation: { label: "Saturation", category: "Color" },
  sharpness: { label: "Sharpness", category: "Color" },
  hue: { label: "Hue", category: "Color" },
  gamma: { label: "Gamma", category: "Color" },
  power_line_frequency: { label: "Anti-Flicker", category: "Utilities" },
  backlight_compensation: { label: "Backlight Compensation", category: "Utilities" }
}

var CATEGORY_ORDER = ["Optics", "Exposure", "Color", "Utilities", "Advanced"]

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// "white_balance_temperature" -> "White Balance Temperature"
function humanizeName(name) {
  var words = String(name || "").replace(/_/g, " ").split(" ")
  var out = []
  for (var i = 0; i < words.length; i++) {
    var w = words[i]
    if (!w) continue
    out.push(w.charAt(0).toUpperCase() + w.slice(1))
  }
  return out.join(" ")
}

// Date -> "20260922-153000" (local time, no separators beyond the dash)
function formatTimestamp(d) {
  var date = (d instanceof Date) ? d : new Date()
  function pad(n) { return (n < 10 ? "0" : "") + n }
  return "" + date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) + "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
}

// Parse a boolean IPC argument: "1"/"true"/"on"/"yes" -> true,
// "0"/"false"/"off"/"no" -> false, anything else -> null.
function parseFlag(value) {
  var t = String(value === undefined || value === null ? "" : value).trim().toLowerCase()
  if (t === "1" || t === "true" || t === "on" || t === "yes") return true
  if (t === "0" || t === "false" || t === "off" || t === "no") return false
  return null
}

// Double-quote a word for embedding in a shell script. "$" is intentionally
// NOT escaped so "$HOME/..." paths expand at runtime.
function shQuote(s) {
  return '"' + String(s).replace(/(["\\])/g, "\\$1") + '"'
}

// ---------------------------------------------------------------------------
// Device discovery: v4l2-ctl --list-devices + per-node --info probe
// ---------------------------------------------------------------------------

// Command builder: list camera groups and their device nodes.
function buildListDevicesCommand() {
  return ["v4l2-ctl", "--list-devices"]
}

// Parse `v4l2-ctl --list-devices` output into camera groups:
// [{ name: "Integrated Camera", bus: "usb-0000:00:0a.0-2", nodes: ["/dev/video0", ...] }]
// Only /dev/videoN nodes are kept (media nodes are dropped).
function parseV4l2ListDevices(rawText) {
  if (!rawText || typeof rawText !== "string") return []

  var groups = []
  var current = null
  var lines = rawText.split(/\r?\n/)

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    // Node lines are tab-indented paths.
    if (/^[\t ]+\//.test(line)) {
      var node = line.trim()
      if (/^\/dev\/video\d+$/.test(node) && current) {
        if (current.nodes.indexOf(node) === -1) {
          current.nodes.push(node)
        }
      }
      continue
    }

    // Group headers end with ":" at column zero.
    var trimmed = line.replace(/\s+$/, "")
    if (!trimmed || trimmed.charAt(0) === " " || trimmed.charAt(0) === "\t") {
      continue
    }
    if (trimmed.charAt(trimmed.length - 1) !== ":") continue

    var header = trimmed.slice(0, -1)
    var name = header
    var bus = ""

    var parenMatch = header.match(/^(.*?)\s*\(([^()]*)\)$/)
    if (parenMatch) {
      var candidateBus = parenMatch[2].trim()
      // Real buses look like "usb-0000:06:00.3-3" or "platform:v4l2loopback-000"
      // (they contain a colon); card names may legitimately end in "(0x0000)".
      if (candidateBus === "" || candidateBus.indexOf(":") !== -1) {
        name = parenMatch[1].trim()
        bus = candidateBus
      }
    }

    current = { name: name, bus: bus, nodes: [] }
    groups.push(current)
  }

  var out = []
  for (var g = 0; g < groups.length; g++) {
    if (groups[g].nodes.length > 0) out.push(groups[g])
  }
  return out
}

// Command builder: probe several device nodes with v4l2-ctl --info in one shot.
// Output chunks are separated with "=====<dev>=====" headers.
function buildProbeCommand(nodes) {
  var list = []
  if (nodes && nodes.length) list = nodes.slice()
  var script = [
    'for dev in "$@"; do',
    '  printf "=====%s=====\\n" "$dev"',
    "  v4l2-ctl -d \"$dev\" --info 2>/dev/null",
    "done"
  ].join("\n")
  return ["sh", "-c", script, "--"].concat(list)
}

// Parse a single `v4l2-ctl -d <dev> --info` output.
// -> { driver, card, bus, caps: [], deviceCaps: [] }
// First occurrence of driver/card/bus wins: uvcvideo devices also carry a
// "Media Driver Info" section that would otherwise clobber the V4L2 values.
function parseV4l2Info(rawText) {
  var info = { driver: "", card: "", bus: "", caps: [], deviceCaps: [] }
  if (!rawText || typeof rawText !== "string") return info

  var lines = rawText.split(/\r?\n/)
  var capMode = null // "caps" | "deviceCaps" | null
  var capIndent = -1

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    var capMatch = line.match(/^([\t ]*)(Capabilities|Device Caps)[\t ]*:[\t ]*(0x[0-9a-fA-F]+)[\t ]*$/)
    if (capMatch) {
      capMode = (capMatch[2] === "Device Caps") ? "deviceCaps" : "caps"
      capIndent = capMatch[1].length
      continue
    }

    var indMatch = line.match(/^([\t ]+)(\S.*)$/)
    if (capMode && indMatch && indMatch[1].length > capIndent && line.indexOf(":") === -1) {
      var entry = indMatch[2].trim()
      if (entry) info[capMode].push(entry)
      continue
    }

    if (!indMatch) {
      // Unindented line: a new top-level section ends the caps block.
      capMode = null
    } else if (line.indexOf(":") !== -1) {
      // A differently-indented field line ends the caps block.
      capMode = null
    }

    if (info.driver === "") {
      var drvMatch = line.match(/^[\t ]*Driver name[\t ]*:[\t ]*(.*)$/)
      if (drvMatch) info.driver = drvMatch[1].trim()
    }
    if (info.card === "") {
      var cardMatch = line.match(/^[\t ]*Card type[\t ]*:[\t ]*(.*)$/)
      if (cardMatch) info.card = cardMatch[1].trim()
    }
    if (info.bus === "") {
      var busMatch = line.match(/^[\t ]*Bus info[\t ]*:[\t ]*(.*)$/)
      if (busMatch) info.bus = busMatch[1].trim()
    }
  }

  return info
}

// Parse concatenated probe output produced by buildProbeCommand.
// -> { "/dev/video0": {driver, card, bus, caps, deviceCaps}, ... }
function parseProbeOutput(rawText) {
  if (!rawText || typeof rawText !== "string") return {}

  var map = {}
  var lines = rawText.split(/\r?\n/)
  var currentDev = null
  var chunk = []

  function flush() {
    if (currentDev) map[currentDev] = parseV4l2Info(chunk.join("\n"))
  }

  for (var i = 0; i < lines.length; i++) {
    var sepMatch = lines[i].match(/^=====(\/dev\/video\d+)=====/)
    if (sepMatch) {
      flush()
      currentDev = sepMatch[1]
      chunk = []
      continue
    }
    if (currentDev) chunk.push(lines[i])
  }
  flush()

  return map
}

// Classify a probed node: "loopback" (v4l2loopback driver), "capture"
// (Device Caps report Video Capture), or "other" (metadata-only etc.).
function classifyNode(info) {
  if (!info) return "other"
  var driver = String(info.driver || "")
  var bus = String(info.bus || "")
  if (/v4l2[\s_]*loopback/i.test(driver) || /v4l2loopback/i.test(bus)) {
    return "loopback"
  }
  var caps = info.deviceCaps || []
  for (var i = 0; i < caps.length; i++) {
    if (caps[i] === "Video Capture") return "capture"
  }
  return "other"
}

function _nodeNumber(node) {
  var m = String(node || "").match(/(\d+)$/)
  return m ? parseInt(m[1], 10) : 0
}

// Pick the loopback pair from the discovered loopback nodes.
// main = card matching "Virtual Camera" else the first by node number;
// helper = card matching "Capture Helper" else the other node (null when
// only one loopback exists — callers fall back to main, which is safe:
// multiple readers of one v4l2loopback device are supported upstream #310).
function pickLoopbacks(loopbacks) {
  var out = { main: null, helper: null }
  if (!loopbacks || !loopbacks.length) return out

  var sorted = loopbacks.slice().sort(function(a, b) {
    return _nodeNumber(a.node) - _nodeNumber(b.node)
  })

  var mainIdx = 0
  for (var i = 0; i < sorted.length; i++) {
    if (/virtual camera/i.test(String(sorted[i].card || ""))) {
      mainIdx = i
      break
    }
  }
  out.main = sorted[mainIdx]

  for (var j = 0; j < sorted.length; j++) {
    if (j === mainIdx) continue
    if (/capture helper/i.test(String(sorted[j].card || ""))) {
      out.helper = sorted[j]
      return out
    }
  }
  if (sorted.length > 1) {
    out.helper = sorted[mainIdx === 0 ? 1 : 0]
  }
  return out
}

// Options for the camera picker: [{ value: captureNode, label }]
// The node path is appended when two cameras share a card name.
function cameraSelectorOptions(cameras) {
  if (!cameras || !cameras.length) return []

  var nameCounts = {}
  for (var i = 0; i < cameras.length; i++) {
    var n = cameras[i].name || ""
    nameCounts[n] = (nameCounts[n] || 0) + 1
  }

  var options = []
  for (var j = 0; j < cameras.length; j++) {
    var cam = cameras[j]
    var label = cam.name || ""
    if (nameCounts[label] > 1) label = label + " \u00B7 " + cam.captureNode
    options.push({ value: cam.captureNode, label: label })
  }
  return options
}

// ---------------------------------------------------------------------------
// Control / format parsers (hardware is authoritative)
// ---------------------------------------------------------------------------

// Parse stdout from `v4l2-ctl -d <dev> --list-ctrls` or `--list-ctrls-menus`.
// Extracts each control's name, type, value, min/max limits, step, default value,
// inactive state flag, and discrete menu options when present.
// v4l2-ctl prints hexadecimal values for payload-typed controls (e.g. bitmask
// "value=0x00000010"); plain parseInt would silently read just the leading 0.
function parseV4l2Number(s) {
  if (s === undefined || s === null) return undefined
  if (s.indexOf("0x") === 0 || s.indexOf("-0x") === 0) return parseInt(s, 16)
  return parseInt(s, 10)
}

function parseV4l2Ctrls(rawText) {
  if (!rawText || typeof rawText !== "string") return {}

  var controls = {}
  var lines = rawText.split(/\r?\n/)
  var currentControl = null

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    // Menu option items are listed on following tab-indented lines:
    // "\t\t\t\t0: Disabled"
    var menuMatch = line.match(/^\s*(\d+):\s*(.+)$/)
    if (menuMatch && currentControl) {
      if (!currentControl.menuItems) {
        currentControl.menuItems = []
      }
      currentControl.menuItems.push({
        value: parseInt(menuMatch[1], 10),
        label: menuMatch[2].trim()
      })
      continue
    }

    // Control header lines have the format:
    // " brightness 0x00980900 (int) : min=0 max=255 step=1 default=128 value=128 flags=has-min-max"
    // " power_line_frequency 0x00980918 (menu) : min=0 max=2 default=2 value=1 (50 Hz)"
    // " white_balance_automatic 0x0098090c (bool) : default=1 value=1"
    var ctrlMatch = line.match(/^\s*([a-zA-Z0-9_]+)\s+0x[0-9a-fA-F]+\s+\(([^)]+)\)\s*:\s*(.*)$/)
    if (ctrlMatch) {
      var name = ctrlMatch[1]
      var type = ctrlMatch[2]
      var attrs = ctrlMatch[3]

      var ctrl = {
        name: name,
        type: type,
        inactive: false
      }

      var valMatch = attrs.match(/\bvalue=(-?0x[0-9a-fA-F]+|-?\d+)/)
      if (valMatch) {
        ctrl.value = parseV4l2Number(valMatch[1])
      }

      var minMatch = attrs.match(/\bmin=(-?0x[0-9a-fA-F]+|-?\d+)/)
      if (minMatch) {
        ctrl.min = parseV4l2Number(minMatch[1])
      }

      var maxMatch = attrs.match(/\bmax=(-?0x[0-9a-fA-F]+|-?\d+)/)
      if (maxMatch) {
        ctrl.max = parseV4l2Number(maxMatch[1])
      }

      var stepMatch = attrs.match(/\bstep=(-?0x[0-9a-fA-F]+|-?\d+)/)
      if (stepMatch) {
        ctrl.step = parseV4l2Number(stepMatch[1])
      }

      var defMatch = attrs.match(/\bdefault=(-?0x[0-9a-fA-F]+|-?\d+)/)
      if (defMatch) {
        var d = parseV4l2Number(defMatch[1])
        ctrl.defaultVal = d
        ctrl.default = d
      }

      if (/\bflags=[^:]*\binactive\b/.test(attrs)) {
        ctrl.inactive = true
      }

      if (type === "menu") {
        ctrl.menuItems = []
      }

      controls[name] = ctrl
      currentControl = ctrl
      continue
    }

    // Reset control context on section headers or blank lines
    currentControl = null
  }

  return controls
}

// Parse stdout from `cameractrls -d <dev> -l`.
// Extracts the vendor FOV control including its discrete options:
// " logitech_brio_fov = 65\t( values: 65, 78, 90 )"
// -> { logitech_brio_fov: { value: 65, options: [65, 78, 90] } }
function parseCameractrls(rawText) {
  if (!rawText || typeof rawText !== "string") return {}

  var result = {}
  var lines = rawText.split(/\r?\n/)
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*logitech_brio_fov\s*=\s*(-?\d+)/)
    if (!m) continue

    var entry = { value: parseInt(m[1], 10), options: undefined }
    var optMatch = lines[i].match(/\(\s*values:\s*([^)]*)\)/)
    if (optMatch) {
      var opts = []
      var parts = optMatch[1].split(",")
      for (var p = 0; p < parts.length; p++) {
        var n = parseInt(parts[p].trim(), 10)
        if (!isNaN(n)) opts.push(n)
      }
      if (opts.length) entry.options = opts
    }
    result.logitech_brio_fov = entry
    break
  }
  return result
}

// Parse stdout from `v4l2-ctl -d <dev> --list-formats-ext`.
// Returns array of format objects:
// [{ pixelformat: "MJPG", description: "...", sizes: [{ width: 1920, height: 1080, fps: [30, 24, ...] }] }]
function parseV4l2Formats(rawText) {
  if (!rawText || typeof rawText !== "string") return []

  var formats = []
  var lines = rawText.split(/\r?\n/)
  var currentFormat = null
  var currentSize = null

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]

    var fmtMatch = line.match(/^\s*\[\d+\]:\s*'([^']+)'\s*\(([^)]+)\)/)
    if (fmtMatch) {
      currentFormat = {
        pixelformat: fmtMatch[1],
        description: fmtMatch[2].trim(),
        sizes: []
      }
      formats.push(currentFormat)
      currentSize = null
      continue
    }

    var sizeMatch = line.match(/^\s*Size:\s*Discrete\s+(\d+)x(\d+)/)
    if (sizeMatch && currentFormat) {
      currentSize = {
        width: parseInt(sizeMatch[1], 10),
        height: parseInt(sizeMatch[2], 10),
        fps: []
      }
      currentFormat.sizes.push(currentSize)
      continue
    }

    var fpsMatch = line.match(/^\s*Interval:\s*Discrete\s+[\d.]+s\s+\(([\d.]+)\s*fps\)/)
    if (fpsMatch && currentSize) {
      var fpsVal = parseFloat(fpsMatch[1])
      currentSize.fps.push(fpsVal)
      continue
    }
  }

  return formats
}

// Parse stdout from `v4l2-ctl -d <dev> --get-fmt-video --get-parm`.
// Extracts active capture format and framerate into:
// { width: 1280, height: 720, pixelformat: "MJPG", fps: 30 }
function parseV4l2CaptureMode(rawText) {
  if (!rawText || typeof rawText !== "string") return {}

  var mode = {}

  var whMatch = rawText.match(/Width\/Height\s*:\s*(\d+)\/(\d+)/)
  if (whMatch) {
    mode.width = parseInt(whMatch[1], 10)
    mode.height = parseInt(whMatch[2], 10)
  }

  var pfMatch = rawText.match(/Pixel Format\s*:\s*'([^']+)'/)
  if (pfMatch) {
    mode.pixelformat = pfMatch[1]
  }

  var fpsMatch = rawText.match(/Frames per second\s*:\s*([\d.]+)/)
  if (fpsMatch) {
    mode.fps = parseFloat(fpsMatch[1])
  }

  return mode
}

// ---------------------------------------------------------------------------
// V4L2 command builders (kept from the camera-agnostic era)
// ---------------------------------------------------------------------------

// Command builder: query active format, streaming parms, and controls in one refresh
function buildV4l2ListCommand(device) {
  return [
    "v4l2-ctl",
    "-d",
    device || DEFAULT_DEVICE,
    "--get-fmt-video",
    "--get-parm",
    "--list-ctrls-menus"
  ]
}

// Command builder: list all supported video formats and frame intervals
function buildV4l2ListFormatsCommand(device) {
  return ["v4l2-ctl", "-d", device || DEFAULT_DEVICE, "--list-formats-ext"]
}

// Command builder: set active video capture resolution, pixel format, and frame rate
function buildV4l2SetCaptureModeCommand(device, mode) {
  var dev = device || DEFAULT_DEVICE
  return [
    "v4l2-ctl",
    "-d",
    dev,
    "--set-fmt-video=width=" + mode.width + ",height=" + mode.height + ",pixelformat=" + mode.pixelformat,
    "--set-parm=" + mode.fps
  ]
}

// Command builder: query a single V4L2 control value
function buildV4l2GetCommand(device, controlName) {
  return ["v4l2-ctl", "-d", device || DEFAULT_DEVICE, "--get-ctrl", controlName]
}

// Command builder: set a single V4L2 control value
function buildV4l2SetCommand(device, controlName, value) {
  return ["v4l2-ctl", "-d", device || DEFAULT_DEVICE, "--set-ctrl", controlName + "=" + value]
}

// Command builder: query cameractrls controls
function buildFovListCommand(device) {
  return ["cameractrls", "-d", device || DEFAULT_DEVICE, "-l"]
}

// Command builder: set vendor field of view (65, 78, or 90)
function buildFovSetCommand(device, fov) {
  return ["cameractrls", "-d", device || DEFAULT_DEVICE, "-c", "logitech_brio_fov=" + fov]
}

// ---------------------------------------------------------------------------
// Resolution / fps option curation (kept)
// ---------------------------------------------------------------------------

// Returns curated, de-duplicated list of { width, height, pixelformat, value, label }
// offered in the UI. For each distinct size, prefers MJPG when offered, else first format.
// Sorted largest first. By default limits to PREFERRED_RESOLUTIONS plus current size.
function resolutionOptions(formats, current, all) {
  if (!formats || !formats.length) return []

  var includeAll = false
  if (all === true) {
    includeAll = true
  } else if (current === true) {
    includeAll = true
    current = null
  } else if (current && typeof current === "object" && current.all === true) {
    includeAll = true
  }

  var curW = null
  var curH = null
  if (current) {
    if (typeof current === "string") {
      var parts = current.split("x")
      if (parts.length === 2) {
        curW = parseInt(parts[0], 10)
        curH = parseInt(parts[1], 10)
      }
    } else if (typeof current === "object") {
      if (current.width !== undefined && current.height !== undefined) {
        curW = parseInt(current.width, 10)
        curH = parseInt(current.height, 10)
      }
    }
  }

  var sizeMap = {}
  var sizeKeys = []

  for (var f = 0; f < formats.length; f++) {
    var fmt = formats[f]
    var pf = fmt.pixelformat
    var sizes = fmt.sizes || []
    for (var s = 0; s < sizes.length; s++) {
      var sz = sizes[s]
      var key = sz.width + "x" + sz.height
      if (!sizeMap[key]) {
        sizeMap[key] = {
          width: sz.width,
          height: sz.height,
          pfs: {},
          firstPf: pf
        }
        sizeKeys.push(key)
      }
      sizeMap[key].pfs[pf] = true
    }
  }

  var distinctList = []
  for (var k = 0; k < sizeKeys.length; k++) {
    var item = sizeMap[sizeKeys[k]]
    var chosenPf = item.pfs["MJPG"] ? "MJPG" : item.firstPf
    distinctList.push({
      width: item.width,
      height: item.height,
      pixelformat: chosenPf
    })
  }

  distinctList.sort(function(a, b) {
    var areaA = a.width * a.height
    var areaB = b.width * b.height
    if (areaB !== areaA) return areaB - areaA
    return b.width - a.width
  })

  var preferredMap = {}
  for (var p = 0; p < PREFERRED_RESOLUTIONS.length; p++) {
    var pref = PREFERRED_RESOLUTIONS[p]
    preferredMap[pref[0] + "x" + pref[1]] = true
  }

  var filtered = []
  for (var i = 0; i < distinctList.length; i++) {
    var res = distinctList[i]
    var resKey = res.width + "x" + res.height
    var isPreferred = !!preferredMap[resKey]
    var isCurrent = (curW !== null && curH !== null && res.width === curW && res.height === curH)

    if (includeAll || isPreferred || isCurrent) {
      filtered.push({
        width: res.width,
        height: res.height,
        pixelformat: res.pixelformat,
        value: resKey,
        label: RESOLUTION_TAGS[resKey] || (res.width + "\u00D7" + res.height)
      })
    }
  }

  return filtered
}

// Returns descending frame rate options for that exact size and format.
// By default filters to PREFERRED_FPS plus current fps if offered.
// Each option provides { fps: number, value: string, label: string } with bare number labels.
function fpsOptions(formats, width, height, pixelformat, current, all) {
  if (!formats || !formats.length || !width || !height) return []

  var includeAll = false
  if (all === true) {
    includeAll = true
  } else if (current === true) {
    includeAll = true
    current = null
  } else if (current && typeof current === "object" && current.all === true) {
    includeAll = true
  }

  var curFps = null
  if (current !== null && current !== undefined && current !== "") {
    if (typeof current === "number") {
      curFps = current
    } else if (typeof current === "object" && current.fps !== undefined) {
      curFps = parseFloat(current.fps)
    } else {
      var parsed = parseFloat(current)
      if (!isNaN(parsed)) {
        curFps = parsed
      }
    }
  }

  var w = parseInt(width, 10)
  var h = parseInt(height, 10)
  var targetPf = pixelformat || null

  var matchedFormat = null
  if (targetPf) {
    for (var i = 0; i < formats.length; i++) {
      if (formats[i].pixelformat === targetPf) {
        matchedFormat = formats[i]
        break
      }
    }
  }

  if (!matchedFormat) {
    for (var j = 0; j < formats.length; j++) {
      if (formats[j].pixelformat === "MJPG") {
        for (var s = 0; s < (formats[j].sizes || []).length; s++) {
          if (formats[j].sizes[s].width === w && formats[j].sizes[s].height === h) {
            matchedFormat = formats[j]
            break
          }
        }
      }
      if (matchedFormat) break
    }
  }
  if (!matchedFormat) {
    for (var k = 0; k < formats.length; k++) {
      for (var s2 = 0; s2 < (formats[k].sizes || []).length; s2++) {
        if (formats[k].sizes[s2].width === w && formats[k].sizes[s2].height === h) {
          matchedFormat = formats[k]
          break
        }
      }
      if (matchedFormat) break
    }
  }

  if (!matchedFormat) return []

  var matchedSize = null
  for (var m = 0; m < (matchedFormat.sizes || []).length; m++) {
    if (matchedFormat.sizes[m].width === w && matchedFormat.sizes[m].height === h) {
      matchedSize = matchedFormat.sizes[m]
      break
    }
  }

  if (!matchedSize || !matchedSize.fps) return []

  var fpsCopy = matchedSize.fps.slice().sort(function(a, b) {
    return b - a
  })

  var preferredMap = {}
  for (var p = 0; p < PREFERRED_FPS.length; p++) {
    preferredMap[PREFERRED_FPS[p]] = true
  }

  var options = []
  for (var n = 0; n < fpsCopy.length; n++) {
    var val = fpsCopy[n]
    var isPreferred = !!preferredMap[val]
    var isCurrent = (curFps !== null && val === curFps)

    if (includeAll || isPreferred || isCurrent) {
      options.push({
        fps: val,
        value: String(val),
        label: String(val)
      })
    }
  }

  return options
}

// Pure resolver: picks pixelformat (keep current if offered, else MJPG, else first)
// and clamps fps to the nearest available for that size (exact match preferred).
// Returns { width, height, pixelformat, fps } or null if size is not enumerated.
function pickCaptureMode(formats, current, width, height, fps) {
  if (!formats || !formats.length || width === undefined || height === undefined) return null

  var w = parseInt(width, 10)
  var h = parseInt(height, 10)
  if (isNaN(w) || isNaN(h)) return null

  var formatsOfferingSize = {}
  var firstOfferingPf = null
  for (var f = 0; f < formats.length; f++) {
    var fmt = formats[f]
    var sizes = fmt.sizes || []
    for (var s = 0; s < sizes.length; s++) {
      if (sizes[s].width === w && sizes[s].height === h) {
        formatsOfferingSize[fmt.pixelformat] = sizes[s]
        if (!firstOfferingPf) {
          firstOfferingPf = fmt.pixelformat
        }
        break
      }
    }
  }

  if (!firstOfferingPf) return null

  var chosenPf = null
  if (current && current.pixelformat && formatsOfferingSize[current.pixelformat]) {
    chosenPf = current.pixelformat
  } else if (formatsOfferingSize["MJPG"]) {
    chosenPf = "MJPG"
  } else {
    chosenPf = firstOfferingPf
  }

  var targetFps = undefined
  if (fps !== undefined && fps !== null && fps !== "") {
    targetFps = parseFloat(fps)
  } else if (current && current.fps !== undefined && current.fps !== null) {
    targetFps = parseFloat(current.fps)
  } else {
    targetFps = 30
  }

  // An explicit fps the current format cannot deliver exactly at this size
  // switches to a format that can (MJPG preferred, then first listed) — e.g.
  // a camera whose uncompressed YUYV tops out at 10fps still honors a 30fps
  // request by switching to MJPG. An implied fps (from the current mode)
  // never switches formats.
  if (targetFps !== undefined && fps !== undefined && fps !== null && fps !== "" &&
      current && current.pixelformat && chosenPf === current.pixelformat) {
    var curFps = (formatsOfferingSize[current.pixelformat].fps) || []
    var curHasExact = false
    for (var e = 0; e < curFps.length; e++) {
      if (curFps[e] === targetFps) curHasExact = true
    }
    if (!curHasExact) {
      var switchTo = null
      if (formatsOfferingSize["MJPG"]) {
        var mFps = formatsOfferingSize["MJPG"].fps || []
        for (var m = 0; m < mFps.length; m++) {
          if (mFps[m] === targetFps) switchTo = "MJPG"
        }
      }
      if (!switchTo) {
        for (var q = 0; q < formats.length; q++) {
          var pfName = formats[q].pixelformat
          if (pfName === current.pixelformat || !formatsOfferingSize[pfName]) continue
          var qFps = formatsOfferingSize[pfName].fps || []
          for (var r = 0; r < qFps.length; r++) {
            if (qFps[r] === targetFps) switchTo = pfName
          }
          if (switchTo) break
        }
      }
      if (switchTo) chosenPf = switchTo
    }
  }

  var sizeEntry = formatsOfferingSize[chosenPf]
  var availableFps = (sizeEntry && sizeEntry.fps) ? sizeEntry.fps : []
  if (!availableFps.length) {
    return { width: w, height: h, pixelformat: chosenPf, fps: 30 }
  }

  var chosenFps = availableFps[0]
  var minDiff = Math.abs(chosenFps - targetFps)

  for (var i = 0; i < availableFps.length; i++) {
    var candidate = availableFps[i]
    if (candidate === targetFps) {
      chosenFps = candidate
      break
    }
    var diff = Math.abs(candidate - targetFps)
    if (diff < minDiff) {
      minDiff = diff
      chosenFps = candidate
    }
  }

  return {
    width: w,
    height: h,
    pixelformat: chosenPf,
    fps: chosenFps
  }
}

// Highest frame rate any pixel format offers at the given size, or null.
function bestFpsForSize(formats, width, height) {
  if (!formats || !formats.length || width === undefined || height === undefined) return null
  var w = parseInt(width, 10)
  var h = parseInt(height, 10)
  if (isNaN(w) || isNaN(h)) return null
  var best = null
  for (var f = 0; f < formats.length; f++) {
    var sizes = formats[f].sizes || []
    for (var s = 0; s < sizes.length; s++) {
      if (sizes[s].width === w && sizes[s].height === h) {
        var fps = sizes[s].fps || []
        for (var p = 0; p < fps.length; p++) {
          if (best === null || fps[p] > best) best = fps[p]
        }
        break
      }
    }
  }
  return best
}

// Default capture mode for a freshly discovered camera: the largest
// PREFERRED_RESOLUTIONS size the hardware offers, at the highest frame rate
// available for that size across pixel formats. On USB-2 cameras this
// switches away from the slow uncompressed power-on mode (YUYV caps at 10fps
// at 720p while MJPG delivers 30). Falls back to the current size at its
// best fps when no preferred size is offered.
function pickPreferredCaptureMode(formats, current) {
  if (!formats || !formats.length) return null
  for (var i = 0; i < PREFERRED_RESOLUTIONS.length; i++) {
    var w = PREFERRED_RESOLUTIONS[i][0]
    var h = PREFERRED_RESOLUTIONS[i][1]
    var best = bestFpsForSize(formats, w, h)
    if (best !== null) return pickCaptureMode(formats, current, w, h, best)
  }
  if (current && current.width !== undefined && current.height !== undefined) {
    var curBest = bestFpsForSize(formats, current.width, current.height)
    if (curBest !== null) {
      return pickCaptureMode(formats, current, current.width, current.height, curBest)
    }
  }
  return null
}

// Resolves auto-exposure manual and auto integer values from menu items:
// Returns { manual: number, auto: number }
function resolveAutoExposure(menuItems) {
  var manual = undefined
  var auto = undefined

  var items = (menuItems && Array.isArray(menuItems)) ? menuItems : []

  // 1. Find manual
  for (var i = 0; i < items.length; i++) {
    var label = String(items[i].label || "")
    if (/manual/i.test(label)) {
      manual = Number(items[i].value)
      break
    }
  }
  if (manual === undefined) {
    for (var j = 0; j < items.length; j++) {
      if (Number(items[j].value) === 1) {
        manual = 1
        break
      }
    }
  }
  if (manual === undefined) {
    manual = 1
  }

  // 2. Find auto
  for (var k = 0; k < items.length; k++) {
    var lblAperture = String(items[k].label || "")
    if (/aperture priority/i.test(lblAperture)) {
      auto = Number(items[k].value)
      break
    }
  }
  if (auto === undefined) {
    for (var m = 0; m < items.length; m++) {
      var lblAuto = String(items[m].label || "")
      if (/auto/i.test(lblAuto) && !/manual/i.test(lblAuto)) {
        auto = Number(items[m].value)
        break
      }
    }
  }
  if (auto === undefined) {
    for (var n = 0; n < items.length; n++) {
      var valN = Number(items[n].value)
      if (valN !== manual) {
        auto = valN
        break
      }
    }
  }
  if (auto === undefined) {
    auto = (manual !== 3) ? 3 : manual
  }

  return { manual: manual, auto: auto }
}

// ---------------------------------------------------------------------------
// Dynamic settings layout (hardware-driven)
// ---------------------------------------------------------------------------

// Infer the UI kind for a control from its reported V4L2 type and range.
// Returns "toggle" | "slider" | "segmented" | "pantilt" | null (unrenderable).
function inferControlKind(ctrl) {
  if (!ctrl) return null
  var t = ctrl.type
  if (t === "bool") return "toggle"
  if (t === "menu") return "segmented"
  if (t === "int" || t === "int64") {
    if (ctrl.min === 0 && ctrl.max === 1) return "toggle"
    return "slider"
  }
  return null
}

// Evaluates whether a control is currently active (editable) based on its
// dependency relationships (e.g. manual sliders disabled when auto mode is on).
// Generalized via CONTROL_META; unknown controls are always active.
function isControlActive(controlName, currentValues) {
  var meta = CONTROL_META[controlName]
  if (!meta || !meta.dependsOn) return true

  var depVal = undefined
  if (currentValues && (meta.dependsOn in currentValues)) {
    var raw = currentValues[meta.dependsOn]
    if (raw !== null && typeof raw === "object" && raw.value !== undefined) {
      depVal = raw.value
    } else {
      depVal = raw
    }
  }

  if (depVal === undefined || depVal === null) {
    // Parent control not reported: assume active; the driver's own
    // "inactive" flag gates the remainder.
    return true
  }

  if (meta.activeWhen === false) {
    return !depVal || depVal === 0 || depVal === "0" || depVal === false
  }
  if (meta.activeWhen === true) {
    return !!depVal && depVal !== 0 && depVal !== "0" && depVal !== false
  }
  return depVal == meta.activeWhen
}

// Build the dynamic settings layout from the hardware control profile.
// controls: parsed map from parseV4l2Ctrls for the selected device.
// opts: { fovAvailable: bool, fovValue: number, fovOptions: [65, 78, 90] }
// Returns [{ title: "OPTICS", items: [{ name, label, kind, category, value,
//   min, max, step, unit, options, enabled, hint }] }] in CATEGORY_ORDER,
// omitting empty sections. Unrenderable controls (rect/bitmask/etc.) are
// skipped; the FOV item is injected first into Optics when available.
function settingsLayout(controls, opts) {
  controls = controls || {}
  opts = opts || {}

  var items = []

  if (opts.fovAvailable) {
    var fovMeta = CONTROL_META[FOV_CONTROL]
    var fovOptions = (opts.fovOptions && opts.fovOptions.length)
      ? opts.fovOptions
      : fovMeta.options
    var fovValue = (opts.fovValue !== undefined && opts.fovValue !== null)
      ? opts.fovValue
      : fovMeta.defaultVal
    var fovItemOptions = []
    for (var f = 0; f < fovOptions.length; f++) {
      fovItemOptions.push({
        value: String(fovOptions[f]),
        label: String(fovOptions[f]) + fovMeta.unit
      })
    }
    items.push({
      name: FOV_CONTROL,
      label: fovMeta.label,
      kind: fovMeta.kind,
      category: fovMeta.category,
      value: fovValue,
      min: undefined,
      max: undefined,
      step: undefined,
      unit: fovMeta.unit,
      options: fovItemOptions,
      enabled: true,
      hint: ""
    })
  }

  var vals = {}
  var ctrlNames = []
  for (var name in controls) {
    if (Object.prototype.hasOwnProperty.call(controls, name) && controls[name]) {
      ctrlNames.push(name)
      vals[name] = controls[name].value
    }
  }

  for (var c = 0; c < ctrlNames.length; c++) {
    var ctrlName = ctrlNames[c]
    var ctrl = controls[ctrlName]
    var meta = CONTROL_META[ctrlName] || null

    var kind = (meta && meta.kind) || inferControlKind(ctrl)
    if (!kind) continue // rect / bitmask / string / button: not renderable

    var value = ctrl.value
    if (value === undefined) {
      if (ctrl.defaultVal !== undefined) value = ctrl.defaultVal
      else if (ctrl.default !== undefined) value = ctrl.default
      else value = ctrl.min
    }

    var item = {
      name: ctrlName,
      label: (meta && meta.label) || humanizeName(ctrlName),
      kind: kind,
      category: (meta && meta.category) || "Advanced",
      value: value,
      min: ctrl.min,
      max: ctrl.max,
      step: (ctrl.step !== undefined && ctrl.step > 0) ? ctrl.step : 1,
      unit: (meta && meta.unit) || "",
      options: [],
      enabled: false,
      hint: (meta && meta.inactiveHint) || "Controlled automatically"
    }

    if (kind === "segmented") {
      var menuItems = (ctrl.menuItems && ctrl.menuItems.length) ? ctrl.menuItems : null
      if (!menuItems) continue // menu without enumerated items: not renderable
      for (var mi = 0; mi < menuItems.length; mi++) {
        item.options.push({
          value: String(menuItems[mi].value),
          label: menuItems[mi].label
        })
      }
    } else if (kind === "slider" || kind === "pantilt") {
      if (ctrl.min === undefined || ctrl.max === undefined) continue
    } else if (kind === "toggle") {
      if (value === undefined) continue
    }

    item.enabled = !ctrl.inactive && isControlActive(ctrlName, vals)
    items.push(item)
  }

  var sections = []
  for (var i = 0; i < CATEGORY_ORDER.length; i++) {
    var category = CATEGORY_ORDER[i]
    var secItems = []
    for (var j = 0; j < items.length; j++) {
      if (items[j].category === category) secItems.push(items[j])
    }
    if (secItems.length > 0) {
      sections.push({ title: category.toUpperCase(), items: secItems })
    }
  }

  return sections
}

// ---------------------------------------------------------------------------
// Hardware-driven defaults and reset
// ---------------------------------------------------------------------------

// Only these V4L2 control types can be set with `--set-ctrl name=value`.
// rect/bitmask/string/button controls (e.g. region-of-interest on some
// laptops) are excluded from defaults maps and reset commands. Entries without
// a type (synthesized) are treated as settable.
var SETTABLE_CTRL_TYPES = ["int", "int64", "bool", "menu"]

function isSettableCtrl(ctrl) {
  if (!ctrl) return false
  if (!ctrl.type) return true
  return SETTABLE_CTRL_TYPES.indexOf(ctrl.type) !== -1
}

// Returns a key-value map of default values for the controls in the given
// hardware profile: { brightness: 128, ... }. Hardware is authoritative;
// un-settable control types are excluded.
function getDefaults(controls) {
  var defaults = {}
  if (!controls) return defaults
  for (var name in controls) {
    if (!Object.prototype.hasOwnProperty.call(controls, name)) continue
    var ctrl = controls[name]
    if (!ctrl || !isSettableCtrl(ctrl)) continue
    if (ctrl.defaultVal !== undefined) {
      defaults[name] = ctrl.defaultVal
    } else if (ctrl.default !== undefined) {
      defaults[name] = ctrl.default
    }
  }
  return defaults
}

// Builds CLI commands required to restore factory defaults for the controls
// in the given hardware profile, in three phases:
//   1. dependency parents -> manual (so dependents accept writes)
//   2. dependent controls -> their reported defaults
//   3. all remaining controls -> their reported defaults (parents return to
//      their own defaults)
// A fourth command resets the cameractrls vendor FOV when present.
function buildResetCommands(device, controls) {
  var dev = device || DEFAULT_DEVICE
  if (!controls) return []

  function getCtrlDefault(c) {
    if (!c) return undefined
    if (c.defaultVal !== undefined) return c.defaultVal
    if (c.default !== undefined) return c.default
    return undefined
  }

  function hasCtrl(n) {
    return Object.prototype.hasOwnProperty.call(controls, n) &&
      controls[n] !== undefined && controls[n] !== null
  }

  var cmds = []
  var dependentNames = []
  var seenDep = {}

  // Phase 1: parents -> manual
  var parentPairs = []
  for (var name in controls) {
    if (!hasCtrl(name)) continue
    var depCtrl = controls[name]
    if (!isSettableCtrl(depCtrl)) continue
    var meta = CONTROL_META[name]
    if (!meta || !meta.dependsOn) continue
    if (!hasCtrl(meta.dependsOn)) continue
    if (getCtrlDefault(depCtrl) === undefined) continue

    if (!seenDep[name]) {
      seenDep[name] = true
      dependentNames.push(name)
    }

    var parent = meta.dependsOn
    var parentCtrl = controls[parent]
    var parentManual
    if (meta.activeWhen === false) {
      parentManual = 0
    } else if (parent === "auto_exposure") {
      parentManual = resolveAutoExposure(parentCtrl.menuItems || []).manual
    } else if (meta.activeWhen === true) {
      parentManual = 1
    } else {
      parentManual = meta.activeWhen
    }
    var pair = parent + "=" + parentManual
    if (parentPairs.indexOf(pair) === -1) parentPairs.push(pair)
  }
  if (parentPairs.length > 0) {
    cmds.push(["v4l2-ctl", "-d", dev, "--set-ctrl", parentPairs.join(",")])
  }

  // Phase 2: dependents -> their defaults
  var depPairs = []
  for (var d = 0; d < dependentNames.length; d++) {
    var depName = dependentNames[d]
    var depDef = getCtrlDefault(controls[depName])
    if (depDef !== undefined) depPairs.push(depName + "=" + depDef)
  }
  if (depPairs.length > 0) {
    cmds.push(["v4l2-ctl", "-d", dev, "--set-ctrl", depPairs.join(",")])
  }

  // Phase 3: remaining controls -> their defaults
  var remPairs = []
  for (var cName in controls) {
    if (!hasCtrl(cName)) continue
    if (seenDep[cName]) continue
    if (cName === FOV_CONTROL) continue // vendor FOV is cameractrls-backed (phase 4)
    var cObj = controls[cName]
    if (!isSettableCtrl(cObj)) continue
    if (cObj && cObj.backend === "cameractrls") continue
    var cDef = getCtrlDefault(cObj)
    if (cDef !== undefined) remPairs.push(cName + "=" + cDef)
  }
  if (remPairs.length > 0) {
    cmds.push(["v4l2-ctl", "-d", dev, "--set-ctrl", remPairs.join(",")])
  }

  // Phase 4: cameractrls vendor FOV
  if (hasCtrl(FOV_CONTROL)) {
    var fovVal = getCtrlDefault(controls[FOV_CONTROL])
    if (fovVal === undefined) {
      fovVal = CONTROL_META[FOV_CONTROL].defaultVal
    }
    cmds.push(["cameractrls", "-d", dev, "-c", FOV_CONTROL + "=" + fovVal])
  }

  return cmds
}

// ---------------------------------------------------------------------------
// Hub / capture command builders (ffmpeg)
// ---------------------------------------------------------------------------

// Command builder: the hub mirror. One ffmpeg process opens the physical
// capture node once and mirrors raw YUYV 4:2:2 into one or two v4l2loopback
// outputs. Validated option syntax: no -pixelformat on the v4l2 muxer; the
// output format is controlled via -c:v rawvideo -pix_fmt yuyv422.
// ffmpeg pixel-format names for -input_format (not fourccs — ffmpeg wants
// "mjpeg"/"yuyv422"; fourccs like "MJPG" are only for v4l2-ctl).
var PIXFMT_NAMES = { MJPG: "mjpeg", YUYV: "yuyv422" }

// Command builder: long-running mirror from the capture device to the
// loopback(s). `mode` is the capture mode {width,height,pixelformat,fps};
// when present, the input format is pinned explicitly — ffmpeg's v4l2 indev
// renegotiates the device format at open otherwise (verified: an MJPG@30
// camera opened with only -framerate gets knocked back to YUYV@10, the
// indev's default — the "virtual camera is still 10fps" bug).
// Command builder: kill stale hub ffmpeg processes before starting a new hub.
// A crashed shell leaves its hub ffmpeg orphaned, still holding the loopback
// devices ("Device or resource busy"), which parks the next hub start in
// error. The hub's unique signature is WRITING to v4l2 devices
// (-f v4l2 /dev/videoN); readers (record, photo grab) use -i and never
// match. startHub refuses to run while the current shell's own hub process is
// alive, so this cleanup can only ever reach orphaned processes.
// The [o] character class is the classic self-exclusion trick: the pattern
// matches "video" in a real hub's command line, but the literal text
// "vide[o]" in this script's own cmdline (and in grep/editor windows holding
// the pattern) can never match itself — so pgrep/pkill only ever see real
// hub processes and never kill their own wrapper.
function buildHubCleanupCommand() {
  var sig = "ffmpeg .*-f v4l2 /dev/vide[o]"
  var script =
    "if pgrep -f " + shQuote(sig) + " >/dev/null 2>&1; then " +
    "pkill -f " + shQuote(sig) + " 2>/dev/null; " +
    "sleep 0.4; " +
    "pkill -9 -f " + shQuote(sig) + " 2>/dev/null; " +
    "sleep 0.2; " +
    "fi; true"
  return ["sh", "-c", script]
}

function buildHubCommand(input, outputs, mode) {
  var outs = []
  if (outputs) {
    for (var i = 0; i < outputs.length; i++) {
      if (outputs[i]) outs.push(outputs[i])
    }
  }

  var rate = (mode && mode.fps !== undefined && mode.fps !== null) ? mode.fps : 30
  var pf = (mode && mode.pixelformat && PIXFMT_NAMES[mode.pixelformat]) ? PIXFMT_NAMES[mode.pixelformat] : null
  var size = (mode && mode.width && mode.height) ? (mode.width + "x" + mode.height) : null

  var cmd = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel", "warning",
    "-f", "v4l2"
  ]
  if (pf) cmd = cmd.concat(["-input_format", pf])
  if (size) cmd = cmd.concat(["-video_size", size])
  cmd = cmd.concat(["-framerate", String(rate),
    // Low-latency mirror: no buffering wanted on a real-time path.
    // nobuffer drops ffmpeg's input queueing; low_delay + single-threaded
    // decode remove the mjpeg decoder's frame-threading pipeline (~N frames
    // of latency with N decoder threads — measured as the bulk of ~1s lag).
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-threads", "1",
    "-i", input])

  for (var j = 0; j < outs.length; j++) {
    cmd = cmd.concat([
      "-map", "0:v",
      "-c:v", "rawvideo",
      "-pix_fmt", "yuyv422",
      "-f", "v4l2",
      outs[j]
    ])
  }

  return cmd
}

// Command builder: single-frame still capture.
// `exec` ensures the shell is replaced by ffmpeg and the parent stays alive
// only as ffmpeg itself; "$HOME/..." in path expands at runtime.
function buildPhotoCommand(source, path) {
  var script =
    "mkdir -p $(dirname " + shQuote(path) + ") && " +
    "exec ffmpeg -hide_banner -loglevel error " +
    "-f v4l2 -i " + shQuote(source) + " " +
    "-frames:v 1 -q:v 2 " + shQuote(path)
  return ["sh", "-c", script]
}

// Command builder: video recording. Stop with SIGINT so ffmpeg finalizes the
// MP4 (writes the moov atom); a SIGKILL watchdog is the caller's fallback.
// micSource: optional PulseAudio/PipeWire source name — when set, audio is
// captured with -f pulse and encoded as AAC 128k (safe for mp4 and mkv).
function buildRecordCommand(source, path, micSource) {
  var script =
    "mkdir -p $(dirname " + shQuote(path) + ") && " +
    "exec ffmpeg -hide_banner -loglevel error " +
    "-f v4l2 -i " + shQuote(source) + " "
  if (micSource !== undefined && micSource !== null && micSource !== "") {
    script += "-f pulse -i " + shQuote(micSource) + " " +
      "-c:a aac -b:a 128k "
  }
  script += "-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p " + shQuote(path)
  return ["sh", "-c", script]
}

// Command builder: enumerate audio input (microphone) sources. Works under
// PipeWire via the pipewire-pulse compatibility layer (this ffmpeg build has
// no native pipewire input device).
function buildMicListCommand() {
  return ["sh", "-c", "pactl list sources"]
}

// Parse `pactl list sources` (long form) into [{name, description}] entries.
// Skips .monitor sources — those are output-loopback captures, not mics.
function parseMicSources(output) {
  var lines = String(output || "").split("\n")
  var entries = []
  var current = null
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var nameM = line.match(/^\s*Name:\s*(\S+)/)
    if (nameM) {
      if (current && current.name) entries.push(current)
      current = { name: nameM[1], description: "" }
      continue
    }
    if (!current) continue
    var descM = line.match(/^\s*Description:\s*(.+)$/)
    if (descM) current.description = descM[1]
  }
  if (current && current.name) entries.push(current)
  var mics = []
  for (var j = 0; j < entries.length; j++) {
    if (entries[j].name.indexOf(".monitor") !== -1) continue
    mics.push(entries[j])
  }
  return mics
}

// Command builder: single-frame preview snapshot to a fixed temp path.
// -y overwrites the previous snapshot on every tick.
// Command builder: is the v4l2loopback kernel module loaded?
function buildLoopbackLoadedCommand() {
  return ["sh", "-c", "test -d /sys/module/v4l2loopback"]
}

// Command builder: is the v4l2loopback kernel module installed?
function buildLoopbackInstalledCommand() {
  return ["sh", "-c", "command -v modinfo >/dev/null 2>&1 && modinfo v4l2loopback >/dev/null 2>&1"]
}

// Export for Node.js test environment (in QML, top-level functions and vars
// are directly accessible via import namespace).
if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_DEVICE: DEFAULT_DEVICE,
    FOV_CONTROL: FOV_CONTROL,
    PREFERRED_RESOLUTIONS: PREFERRED_RESOLUTIONS,
    PREFERRED_FPS: PREFERRED_FPS,
    RESOLUTION_TAGS: RESOLUTION_TAGS,
    CONTROL_META: CONTROL_META,
    CATEGORY_ORDER: CATEGORY_ORDER,
    humanizeName: humanizeName,
    formatTimestamp: formatTimestamp,
    parseFlag: parseFlag,
    buildListDevicesCommand: buildListDevicesCommand,
    parseV4l2ListDevices: parseV4l2ListDevices,
    buildProbeCommand: buildProbeCommand,
    parseV4l2Info: parseV4l2Info,
    parseProbeOutput: parseProbeOutput,
    classifyNode: classifyNode,
    pickLoopbacks: pickLoopbacks,
    cameraSelectorOptions: cameraSelectorOptions,
    parseV4l2Ctrls: parseV4l2Ctrls,
    parseCameractrls: parseCameractrls,
    parseV4l2Formats: parseV4l2Formats,
    parseV4l2CaptureMode: parseV4l2CaptureMode,
    buildV4l2ListCommand: buildV4l2ListCommand,
    buildV4l2ListFormatsCommand: buildV4l2ListFormatsCommand,
    buildV4l2SetCaptureModeCommand: buildV4l2SetCaptureModeCommand,
    buildV4l2GetCommand: buildV4l2GetCommand,
    buildV4l2SetCommand: buildV4l2SetCommand,
    buildFovListCommand: buildFovListCommand,
    buildFovSetCommand: buildFovSetCommand,
    resolveAutoExposure: resolveAutoExposure,
    inferControlKind: inferControlKind,
    settingsLayout: settingsLayout,
    isControlActive: isControlActive,
    getDefaults: getDefaults,
    buildResetCommands: buildResetCommands,
    resolutionOptions: resolutionOptions,
    fpsOptions: fpsOptions,
    pickCaptureMode: pickCaptureMode,
    bestFpsForSize: bestFpsForSize,
    pickPreferredCaptureMode: pickPreferredCaptureMode,
    buildHubCommand: buildHubCommand,
    buildHubCleanupCommand: buildHubCleanupCommand,
    buildPhotoCommand: buildPhotoCommand,
    buildRecordCommand: buildRecordCommand,
    buildMicListCommand: buildMicListCommand,
    parseMicSources: parseMicSources,
    buildLoopbackLoadedCommand: buildLoopbackLoadedCommand,
    buildLoopbackInstalledCommand: buildLoopbackInstalledCommand
  }
}
