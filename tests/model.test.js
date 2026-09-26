const assert = require("node:assert/strict")
const cp = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Model = require("../Model.js")

const FIXTURES = path.join(__dirname, "fixtures")

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real laptop capture device (historical probe output, 17 standard V4L2 controls)
const V4L2_FIXTURE = `
User Controls

                     brightness 0x00980900 (int)    : min=0 max=255 step=1 default=128 value=128 flags=has-min-max
                       contrast 0x00980901 (int)    : min=0 max=255 step=1 default=128 value=127 flags=has-min-max
                     saturation 0x00980902 (int)    : min=0 max=255 step=1 default=128 value=137 flags=has-min-max
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
                           gain 0x00980913 (int)    : min=0 max=255 step=1 default=0 value=0 flags=has-min-max
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=2 value=1 (50 Hz)
				0: Disabled
				1: 50 Hz
				2: 60 Hz
      white_balance_temperature 0x0098091a (int)    : min=2800 max=7500 step=1 default=5000 value=3997 flags=inactive, has-min-max
                      sharpness 0x0098091b (int)    : min=0 max=255 step=1 default=128 value=128 flags=has-min-max
         backlight_compensation 0x0098091c (int)    : min=0 max=1 step=1 default=1 value=1 flags=has-min-max

Camera Controls

                  auto_exposure 0x009a0901 (menu)   : min=0 max=3 default=3 value=3 (Aperture Priority Mode)
				1: Manual Mode
				3: Aperture Priority Mode
         exposure_time_absolute 0x009a0902 (int)    : min=3 max=2047 step=1 default=156 value=625 flags=inactive, has-min-max
     exposure_dynamic_framerate 0x009a0903 (bool)   : default=0 value=0
                   pan_absolute 0x009a0908 (int)    : min=-72000 max=72000 step=3600 default=0 value=-21600 flags=has-min-max
                  tilt_absolute 0x009a0909 (int)    : min=-72000 max=72000 step=3600 default=0 value=50400 flags=has-min-max
                 focus_absolute 0x009a090a (int)    : min=0 max=255 step=1 default=0 value=20 flags=inactive, has-min-max
     focus_automatic_continuous 0x009a090c (bool)   : default=1 value=1
                  zoom_absolute 0x009a090d (int)    : min=100 max=400 step=1 default=100 value=152 flags=has-min-max
`

// Real device output captured from this machine's "Integrated Camera" (/dev/video0)
const REAL_CTRLS = fs.readFileSync(path.join(FIXTURES, "ctrls-video0.txt"), "utf8")
const REAL_INFO_VIDEO0 = fs.readFileSync(path.join(FIXTURES, "info-video0.txt"), "utf8")
const REAL_INFO_VIDEO1 = fs.readFileSync(path.join(FIXTURES, "info-video1.txt"), "utf8")
const REAL_FMT_PARM = fs.readFileSync(path.join(FIXTURES, "fmt-parm-video0.txt"), "utf8")
const REAL_FORMATS = fs.readFileSync(path.join(FIXTURES, "formats-video0.txt"), "utf8")

const CAMERACTRLS_FIXTURE = `Basic / Crop
 logitech_brio_fov = 65	( values: 65, 78, 90 )
 zoom_absolute = 152	( default: 100 min: 100 max: 400 )
 pan_absolute = -21600	( default: 0 min: -72000 max: 72000 step: 3600 )
 tilt_absolute = 50400	( default: 0 min: -72000 max: 72000 step: 3600 )
Basic / Focus
 focus_automatic_continuous = 1	( default: 1 min: 0 max: 1 )
 focus_absolute = 20	( default: 0 min: 0 max: 255 ) | inactive
Exposure / Exposure
 auto_exposure = aperture_priority_mode	( default: aperture_priority_mode values: manual_mode, aperture_priority_mode )
 exposure_time_absolute = 625	( default: 156 min: 3 max: 2047 ) | inactive
 exposure_dynamic_framerate = 0	( default: 0 min: 0 max: 1 )
 gain = 0	( default: 0 min: 0 max: 255 )
Exposure / Dynamic Range
 backlight_compensation = 1	( default: 1 min: 0 max: 1 )
Color / Balance
 white_balance_automatic = 1	( default: 1 min: 0 max: 1 )
 white_balance_temperature = 3997	( default: 5000 min: 2800 max: 7500 ) | inactive
Color / Color
 brightness = 128	( default: 128 min: 0 max: 255 )
 contrast = 127	( default: 128 min: 0 max: 255 )
 saturation = 137	( default: 128 min: 0 max: 255 )
 sharpness = 128	( default: 128 min: 0 max: 255 )
Advanced / Power Line
 power_line_frequency = 50_hz	( default: 60_hz values: disabled, 50_hz, 60_hz )
Capture / Capture
 pixelformat = NV12	( values: YUYV, MJPG, NV12 )
 resolution = 640x480	( values: 640x480, 640x360 )
 fps = 30	( values: 30, 24, 20, 15, 10, 7.5, 5 )
Capture / Info
 card = USB Camera
 driver = uvcvideo
 path = /dev/video0
 real_path = /dev/video0
`

const V4L2_FORMATS_FIXTURE = `ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 640x480
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.042s (24.000 fps)
			Interval: Discrete 0.050s (20.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.100s (10.000 fps)
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 0.200s (5.000 fps)
	[1]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 1920x1080
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.042s (24.000 fps)
			Interval: Discrete 0.050s (20.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.100s (10.000 fps)
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 0.200s (5.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.042s (24.000 fps)
			Interval: Discrete 0.050s (20.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.100s (10.000 fps)
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 0.200s (5.000 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.017s (60.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.042s (24.000 fps)
			Interval: Discrete 0.050s (20.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.100s (10.000 fps)
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 0.200s (5.000 fps)
	[2]: 'NV12' (Y/UV 4:2:0)
		Size: Discrete 640x360
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.042s (24.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.100s (10.000 fps)
			Interval: Discrete 0.133s (7.500 fps)
			Interval: Discrete 0.200s (5.000 fps)
`

// Synthetic v4l2loopback --info output (driver-identifiable)
const LOOPBACK_INFO_FIXTURE = `Driver Info:
	Driver name      : v4l2 loopback
	Card type        : Virtual Camera
	Bus info         : platform:v4l2loopback-000
	Driver version   : 6.16.7
	Capabilities     : 0x05200001
		Video Capture
		Video Output
		Streaming
		Extended Pix Format
		Device Capabilities
	Device Caps      : 0x05200001
		Video Capture
		Video Output
		Streaming
		Extended Pix Format
`

// Helpers
function sectionTitles(sections) {
  return sections.map(function(s) { return s.title })
}

function sectionItems(sections, title) {
  const sec = sections.find(function(s) { return s.title === title })
  return sec ? sec.items : []
}

function findItem(sections, name) {
  for (const sec of sections) {
    for (const item of sec.items) {
      if (item.name === name) return item
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 1. parseV4l2Ctrls: USB Camera fixture (17 standard controls)
// ---------------------------------------------------------------------------

const v4l2 = Model.parseV4l2Ctrls(V4L2_FIXTURE)
assert.equal(Object.keys(v4l2).length, 17)

assert.equal(v4l2.brightness.type, "int")
assert.equal(v4l2.brightness.value, 128)
assert.equal(v4l2.brightness.min, 0)
assert.equal(v4l2.brightness.max, 255)
assert.equal(v4l2.brightness.step, 1)
assert.equal(v4l2.brightness.defaultVal, 128)
assert.equal(v4l2.brightness.inactive, false)

assert.equal(v4l2.contrast.value, 127)
assert.equal(v4l2.contrast.defaultVal, 128)
assert.equal(v4l2.saturation.value, 137)
assert.equal(v4l2.saturation.defaultVal, 128)

assert.equal(v4l2.white_balance_automatic.type, "bool")
assert.equal(v4l2.white_balance_automatic.value, 1)
assert.equal(v4l2.white_balance_automatic.defaultVal, 1)
assert.equal(v4l2.white_balance_automatic.min, undefined)
assert.equal(v4l2.white_balance_automatic.max, undefined)

assert.equal(v4l2.gain.min, 0)
assert.equal(v4l2.gain.max, 255)
assert.equal(v4l2.gain.value, 0)
assert.equal(v4l2.gain.defaultVal, 0)

assert.equal(v4l2.power_line_frequency.type, "menu")
assert.equal(v4l2.power_line_frequency.value, 1)
assert.equal(v4l2.power_line_frequency.min, 0)
assert.equal(v4l2.power_line_frequency.max, 2)
assert.equal(v4l2.power_line_frequency.defaultVal, 2)
assert.deepEqual(v4l2.power_line_frequency.menuItems, [
  { value: 0, label: "Disabled" },
  { value: 1, label: "50 Hz" },
  { value: 2, label: "60 Hz" }
])

assert.equal(v4l2.white_balance_temperature.value, 3997)
assert.equal(v4l2.white_balance_temperature.min, 2800)
assert.equal(v4l2.white_balance_temperature.max, 7500)
assert.equal(v4l2.white_balance_temperature.defaultVal, 5000)
assert.equal(v4l2.white_balance_temperature.inactive, true)

assert.equal(v4l2.sharpness.value, 128)
assert.equal(v4l2.sharpness.defaultVal, 128)
assert.equal(v4l2.backlight_compensation.min, 0)
assert.equal(v4l2.backlight_compensation.max, 1)
assert.equal(v4l2.backlight_compensation.defaultVal, 1)

assert.equal(v4l2.auto_exposure.type, "menu")
assert.equal(v4l2.auto_exposure.value, 3)
assert.equal(v4l2.auto_exposure.defaultVal, 3)
assert.deepEqual(v4l2.auto_exposure.menuItems, [
  { value: 1, label: "Manual Mode" },
  { value: 3, label: "Aperture Priority Mode" }
])

assert.equal(v4l2.exposure_time_absolute.value, 625)
assert.equal(v4l2.exposure_time_absolute.min, 3)
assert.equal(v4l2.exposure_time_absolute.max, 2047)
assert.equal(v4l2.exposure_time_absolute.defaultVal, 156)
assert.equal(v4l2.exposure_time_absolute.inactive, true)

assert.equal(v4l2.exposure_dynamic_framerate.type, "bool")
assert.equal(v4l2.exposure_dynamic_framerate.value, 0)
assert.equal(v4l2.exposure_dynamic_framerate.defaultVal, 0)

assert.equal(v4l2.pan_absolute.value, -21600)
assert.equal(v4l2.pan_absolute.min, -72000)
assert.equal(v4l2.pan_absolute.max, 72000)
assert.equal(v4l2.pan_absolute.step, 3600)
assert.equal(v4l2.pan_absolute.defaultVal, 0)

assert.equal(v4l2.tilt_absolute.value, 50400)
assert.equal(v4l2.tilt_absolute.step, 3600)
assert.equal(v4l2.focus_absolute.value, 20)
assert.equal(v4l2.focus_absolute.inactive, true)
assert.equal(v4l2.focus_automatic_continuous.value, 1)
assert.equal(v4l2.focus_automatic_continuous.defaultVal, 1)
assert.equal(v4l2.zoom_absolute.min, 100)
assert.equal(v4l2.zoom_absolute.max, 400)
assert.equal(v4l2.zoom_absolute.value, 152)
assert.equal(v4l2.zoom_absolute.defaultVal, 100)

// ---------------------------------------------------------------------------
// 2. parseV4l2Ctrls: real Integrated Camera fixture (incl. rect/bitmask ROI)
// ---------------------------------------------------------------------------

const realCtrls = Model.parseV4l2Ctrls(REAL_CTRLS)
assert.equal(Object.keys(realCtrls).length, 15)

// Ranges differ from the Device: hardware is authoritative
assert.equal(realCtrls.contrast.defaultVal, 32)
assert.equal(realCtrls.saturation.max, 100)
assert.equal(realCtrls.hue.min, -180)
assert.equal(realCtrls.hue.max, 180)
assert.equal(realCtrls.hue.defaultVal, 0)
assert.equal(realCtrls.gamma.min, 90)
assert.equal(realCtrls.gamma.max, 150)
assert.equal(realCtrls.gamma.defaultVal, 120)
assert.equal(realCtrls.sharpness.max, 7)
assert.equal(realCtrls.backlight_compensation.min, 0)
assert.equal(realCtrls.backlight_compensation.max, 2)
assert.equal(realCtrls.exposure_time_absolute.min, 4)
assert.equal(realCtrls.exposure_time_absolute.max, 1250)
assert.equal(realCtrls.exposure_dynamic_framerate.value, 1)
assert.equal(realCtrls.exposure_dynamic_framerate.defaultVal, 0)

// ROI controls report exotic types and must parse without crashing
assert.equal(realCtrls.region_of_interest_rectangle.type, "rect")
assert.equal(realCtrls.region_of_interest_rectangle.inactive, false)
assert.equal(realCtrls.region_of_interest_auto_ctrls.type, "bitmask")
// Hex values (payload-typed controls) must parse as hexadecimal, not truncate to 0
assert.equal(realCtrls.region_of_interest_auto_ctrls.value, 16)
assert.equal(realCtrls.region_of_interest_auto_ctrls.defaultVal, 16)
assert.equal(realCtrls.region_of_interest_auto_ctrls.max, 255)
// Payload-typed controls stay out of defaults and the settings layout
assert.equal(Model.getDefaults(realCtrls).region_of_interest_auto_ctrls, undefined)
var roiLayout = Model.settingsLayout(realCtrls, { fovAvailable: false })
assert.equal(
  roiLayout.some(function(s) {
    return s.items.some(function(i) { return i.name.indexOf("region_of_interest") === 0 })
  }),
  false
)

// Edge cases
assert.deepEqual(Model.parseV4l2Ctrls(""), {})
assert.deepEqual(Model.parseV4l2Ctrls(null), {})
assert.deepEqual(Model.parseV4l2Ctrls(undefined), {})

// ---------------------------------------------------------------------------
// 3. parseCameractrls: FOV entry with value + options
// ---------------------------------------------------------------------------

const fovParsed = Model.parseCameractrls(CAMERACTRLS_FIXTURE)
assert.deepEqual(fovParsed, {
  logitech_brio_fov: { value: 65, options: [65, 78, 90] }
})
assert.deepEqual(
  Model.parseCameractrls("Basic / Crop\n logitech_brio_fov = 78\n"),
  { logitech_brio_fov: { value: 78, options: undefined } }
)
assert.deepEqual(
  Model.parseCameractrls(" logitech_brio_fov = 90\t( values: 90 )\n"),
  { logitech_brio_fov: { value: 90, options: [90] } }
)
assert.deepEqual(Model.parseCameractrls(""), {})
assert.deepEqual(Model.parseCameractrls("no fov control in this output"), {})
assert.deepEqual(Model.parseCameractrls(null), {})
assert.deepEqual(Model.parseCameractrls(undefined), {})

// ---------------------------------------------------------------------------
// 4. CONTROL_META: presentation metadata sanity
// ---------------------------------------------------------------------------

const metaKeys = Object.keys(Model.CONTROL_META)
assert.equal(metaKeys.length, 20)
for (const name of metaKeys) {
  const meta = Model.CONTROL_META[name]
  assert.ok(meta.label, `missing label for ${name}`)
  assert.ok(meta.category, `missing category for ${name}`)
}
assert.equal(Model.CONTROL_META.logitech_brio_fov.backend, "cameractrls")
assert.deepEqual(Model.CONTROL_META.logitech_brio_fov.options, [65, 78, 90])
assert.equal(Model.CONTROL_META.logitech_brio_fov.defaultVal, 65)
assert.equal(Model.CONTROL_META.logitech_brio_fov.unit, "\u00B0")
assert.equal(Model.CONTROL_META.logitech_brio_fov.category, "Optics")
assert.equal(Model.CONTROL_META.exposure_time_absolute.dependsOn, "auto_exposure")
assert.equal(Model.CONTROL_META.exposure_time_absolute.activeWhen, 1)
assert.equal(Model.CONTROL_META.white_balance_temperature.dependsOn, "white_balance_automatic")
assert.equal(Model.CONTROL_META.white_balance_temperature.activeWhen, false)
assert.equal(Model.CONTROL_META.focus_absolute.dependsOn, "focus_automatic_continuous")
assert.equal(Model.CONTROL_META.focus_absolute.activeWhen, false)
assert.equal(Model.CONTROL_META.pan_absolute.kind, "pantilt")
assert.equal(Model.CONTROL_META.tilt_absolute.kind, "pantilt")
assert.equal(Model.CONTROL_META.zoom_absolute.unit, "%")
assert.equal(Model.CONTROL_META.white_balance_temperature.unit, "K")
assert.deepEqual(Model.CATEGORY_ORDER, ["Optics", "Exposure", "Color", "Utilities", "Advanced"])
// No flip controls in metadata or anywhere
for (const name of ["hflip", "vflip", "horizontal_flip", "mirror"]) {
  assert.equal(Model.CONTROL_META[name], undefined)
}

// ---------------------------------------------------------------------------
// 5. Discovery: buildListDevicesCommand + parseV4l2ListDevices
// ---------------------------------------------------------------------------

assert.deepEqual(Model.buildListDevicesCommand(), ["v4l2-ctl", "--list-devices"])

// Real output from this machine (media node dropped)
const realGroups = Model.parseV4l2ListDevices(
  "Integrated Camera: Integrated C (usb-0000:06:00.3-3):\n" +
  "\t/dev/video0\n" +
  "\t/dev/video1\n" +
  "\t/dev/media0\n"
)
assert.deepEqual(realGroups, [
  {
    name: "Integrated Camera: Integrated C",
    bus: "usb-0000:06:00.3-3",
    nodes: ["/dev/video0", "/dev/video1"]
  }
])

// Multi-camera + loopback groups
const multiList = Model.parseV4l2ListDevices(
  "USB Camera (usb-0000:08:00.1-2):\n" +
  "\t/dev/video4\n" +
  "\t/dev/video5\n" +
  "\n" +
  "Integrated Camera: Integrated C (usb-0000:06:00.3-3):\n" +
  "\t/dev/video0\n" +
  "\t/dev/video1\n" +
  "\t/dev/media0\n" +
  "\n" +
  "Virtual Camera (platform:v4l2loopback-000):\n" +
  "\t/dev/video8\n" +
  "\n" +
  "Capture Helper (platform:v4l2loopback-001):\n" +
  "\t/dev/video9\n"
)
assert.equal(multiList.length, 4)
assert.deepEqual(multiList[0], { name: "USB Camera", bus: "usb-0000:08:00.1-2", nodes: ["/dev/video4", "/dev/video5"] })
assert.deepEqual(multiList[1], { name: "Integrated Camera: Integrated C", bus: "usb-0000:06:00.3-3", nodes: ["/dev/video0", "/dev/video1"] })
assert.deepEqual(multiList[2], { name: "Virtual Camera", bus: "platform:v4l2loopback-000", nodes: ["/dev/video8"] })
assert.deepEqual(multiList[3], { name: "Capture Helper", bus: "platform:v4l2loopback-001", nodes: ["/dev/video9"] })

// Empty bus parens: "Platform Cam ():"
assert.deepEqual(
  Model.parseV4l2ListDevices("Platform Cam ():\n\t/dev/video8\n"),
  [{ name: "Platform Cam", bus: "", nodes: ["/dev/video8"] }]
)

// Card name ending in "(0x0000)" with NO bus is not mistaken for a bus
assert.deepEqual(
  Model.parseV4l2ListDevices("Dummy video device (0x0000):\n\t/dev/video10\n"),
  [{ name: "Dummy video device (0x0000)", bus: "", nodes: ["/dev/video10"] }]
)

// Header without trailing ":" is ignored; group without nodes is dropped
assert.deepEqual(
  Model.parseV4l2ListDevices("Random noise line\nEmpty Group (usb-x):\nCam (usb-0000:0a:00.0-2):\n\t/dev/video0\n"),
  [{ name: "Cam", bus: "usb-0000:0a:00.0-2", nodes: ["/dev/video0"] }]
)

// Duplicate nodes within a group collapse
assert.equal(
  Model.parseV4l2ListDevices("Cam (usb-y):\n\t/dev/video0\n\t/dev/video0\n")[0].nodes.length,
  1
)

// CRLF input parses clean
const crlfGroups = Model.parseV4l2ListDevices(
  "CRLF Cam (usb-0000:01:00.0-1):\r\n\t/dev/video4\r\n"
)
assert.equal(crlfGroups.length, 1)
assert.equal(crlfGroups[0].name, "CRLF Cam")
assert.equal(crlfGroups[0].bus, "usb-0000:01:00.0-1")
assert.ok(!crlfGroups[0].name.includes("\r"))
assert.ok(!crlfGroups[0].bus.includes("\r"))

// Edge cases
assert.deepEqual(Model.parseV4l2ListDevices(""), [])
assert.deepEqual(Model.parseV4l2ListDevices(null), [])
assert.deepEqual(Model.parseV4l2ListDevices(undefined), [])

// ---------------------------------------------------------------------------
// 6. Probe: buildProbeCommand + parseV4l2Info + parseProbeOutput + classifyNode
// ---------------------------------------------------------------------------

const probeCmd = Model.buildProbeCommand(["/dev/video0", "/dev/video1"])
assert.equal(probeCmd[0], "sh")
assert.equal(probeCmd[1], "-c")
assert.ok(probeCmd[2].includes('printf "=====%s=====\\n" "$dev"'))
assert.ok(probeCmd[2].includes("v4l2-ctl -d \"$dev\" --info"))
assert.equal(probeCmd[3], "--")
assert.equal(probeCmd[4], "/dev/video0")
assert.equal(probeCmd[5], "/dev/video1")
// Empty node list still yields a valid (no-op) command
const emptyProbeCmd = Model.buildProbeCommand([])
assert.equal(emptyProbeCmd.length, 4)
assert.equal(emptyProbeCmd[3], "--")

// Real --info fixture: V4L2 fields with a trailing Media Driver Info section
const realInfo0 = Model.parseV4l2Info(REAL_INFO_VIDEO0)
assert.equal(realInfo0.driver, "uvcvideo")
assert.equal(realInfo0.card, "Integrated Camera: Integrated C")
assert.equal(realInfo0.bus, "usb-0000:06:00.3-3")
assert.deepEqual(realInfo0.caps, [
  "Video Capture",
  "Metadata Capture",
  "Streaming",
  "Extended Pix Format",
  "Device Capabilities"
])
assert.deepEqual(realInfo0.deviceCaps, [
  "Video Capture",
  "Streaming",
  "Extended Pix Format"
])

// Metadata node: Device Caps report Metadata Capture only
const realInfo1 = Model.parseV4l2Info(REAL_INFO_VIDEO1)
assert.deepEqual(realInfo1.deviceCaps, [
  "Metadata Capture",
  "Streaming",
  "Extended Pix Format"
])

// Synthetic loopback --info
const loopbackInfo = Model.parseV4l2Info(LOOPBACK_INFO_FIXTURE)
assert.equal(loopbackInfo.driver, "v4l2 loopback")
assert.equal(loopbackInfo.card, "Virtual Camera")
assert.equal(loopbackInfo.bus, "platform:v4l2loopback-000")
assert.equal(loopbackInfo.caps.length, 5)
assert.equal(loopbackInfo.deviceCaps.length, 4)

// Edge cases
const emptyInfo = Model.parseV4l2Info("")
assert.deepEqual(emptyInfo, { driver: "", card: "", bus: "", caps: [], deviceCaps: [] })
assert.deepEqual(Model.parseV4l2Info(null), { driver: "", card: "", bus: "", caps: [], deviceCaps: [] })
assert.deepEqual(
  Model.parseV4l2Info("Completely unrelated output\nNothing here"),
  { driver: "", card: "", bus: "", caps: [], deviceCaps: [] }
)

// parseProbeOutput: chunked probe output
const probeOut =
  "=====/dev/video0=====\n" + LOOPBACK_INFO_FIXTURE + "\n" +
  "=====/dev/video9=====\n\n"
const probeMap = Model.parseProbeOutput(probeOut)
assert.equal(Object.keys(probeMap).length, 2)
assert.equal(probeMap["/dev/video0"].driver, "v4l2 loopback")
// Failed probe (header, empty body) yields empty info
assert.deepEqual(probeMap["/dev/video9"], { driver: "", card: "", bus: "", caps: [], deviceCaps: [] })

// Real concatenated probe of video0 + video1
const realProbe = Model.parseProbeOutput(
  "=====/dev/video0=====\n" + REAL_INFO_VIDEO0 +
  "=====/dev/video1=====\n" + REAL_INFO_VIDEO1
)
assert.equal(realProbe["/dev/video0"].card, "Integrated Camera: Integrated C")
assert.equal(realProbe["/dev/video1"].driver, "uvcvideo")

// Edge cases
assert.deepEqual(Model.parseProbeOutput(""), {})
assert.deepEqual(Model.parseProbeOutput(null), {})
// Text before the first separator is ignored
assert.deepEqual(
  Model.parseProbeOutput("stray line\n=====/dev/video0=====\n"),
  { "/dev/video0": { driver: "", card: "", bus: "", caps: [], deviceCaps: [] } }
)

// classifyNode
assert.equal(Model.classifyNode(realInfo0), "capture")
assert.equal(Model.classifyNode(realInfo1), "other")
assert.equal(Model.classifyNode(loopbackInfo), "loopback")
// Loopback identifiable by bus when driver name is generic
assert.equal(
  Model.classifyNode({ driver: "platform", card: "OBS Virtual Camera", bus: "platform:v4l2loopback-video", deviceCaps: ["Video Output"] }),
  "loopback"
)
// Output-only node (loopback before a producer attaches) is still not "capture"
assert.equal(Model.classifyNode({ driver: "uvcvideo", deviceCaps: ["Video Output"] }), "other")
assert.equal(Model.classifyNode(null), "other")
assert.equal(Model.classifyNode({}), "other")

// ---------------------------------------------------------------------------
// 7. pickLoopbacks
// ---------------------------------------------------------------------------

assert.deepEqual(Model.pickLoopbacks([]), { main: null, helper: null })
assert.deepEqual(Model.pickLoopbacks(null), { main: null, helper: null })

// Single loopback: main set, helper null (callers fall back to main)
const single = Model.pickLoopbacks([{ node: "/dev/video8", card: "Virtual Camera" }])
assert.equal(single.main.node, "/dev/video8")
assert.equal(single.helper, null)

// Labeled pair
const pair = Model.pickLoopbacks([
  { node: "/dev/video8", card: "Virtual Camera" },
  { node: "/dev/video9", card: "Capture Helper" }
])
assert.equal(pair.main.node, "/dev/video8")
assert.equal(pair.helper.node, "/dev/video9")

// Unlabeled pair: first by node number is main, the other is helper
const unlabeled = Model.pickLoopbacks([
  { node: "/dev/video9", card: "Dummy video device (0x0000)" },
  { node: "/dev/video8", card: "Dummy video device (0x0000)" }
])
assert.equal(unlabeled.main.node, "/dev/video8")
assert.equal(unlabeled.helper.node, "/dev/video9")

// Three loopbacks: labels win; helper label preferred over position
const three = Model.pickLoopbacks([
  { node: "/dev/video8", card: "Dummy video device (0x0000)" },
  { node: "/dev/video9", card: "Virtual Camera" },
  { node: "/dev/video10", card: "Capture Helper" }
])
assert.equal(three.main.node, "/dev/video9")
assert.equal(three.helper.node, "/dev/video10")

// Missing card falls back to positional pick
const noCard = Model.pickLoopbacks([{ node: "/dev/video8" }, { node: "/dev/video9" }])
assert.equal(noCard.main.node, "/dev/video8")
assert.equal(noCard.helper.node, "/dev/video9")

// ---------------------------------------------------------------------------
// 8. cameraSelectorOptions
// ---------------------------------------------------------------------------

const selectorCams = [
  { name: "USB Camera", bus: "b1", captureNode: "/dev/video4" },
  { name: "Integrated Camera", bus: "b2", captureNode: "/dev/video0" }
]
assert.deepEqual(Model.cameraSelectorOptions(selectorCams), [
  { value: "/dev/video4", label: "USB Camera" },
  { value: "/dev/video0", label: "Integrated Camera" }
])

const sameNameCams = [
  { name: "Integrated Camera", bus: "b1", captureNode: "/dev/video0" },
  { name: "Integrated Camera", bus: "b2", captureNode: "/dev/video2" }
]
assert.deepEqual(Model.cameraSelectorOptions(sameNameCams), [
  { value: "/dev/video0", label: "Integrated Camera \u00B7 /dev/video0" },
  { value: "/dev/video2", label: "Integrated Camera \u00B7 /dev/video2" }
])

assert.deepEqual(Model.cameraSelectorOptions([]), [])
assert.deepEqual(Model.cameraSelectorOptions(null), [])

// ---------------------------------------------------------------------------
// 9. Capture mode: parseV4l2CaptureMode (real --get-fmt-video --get-parm)
// ---------------------------------------------------------------------------

const realMode = Model.parseV4l2CaptureMode(REAL_FMT_PARM)
assert.deepEqual(realMode, { width: 1280, height: 720, pixelformat: "MJPG", fps: 25 })
assert.deepEqual(Model.parseV4l2CaptureMode(""), {})
assert.deepEqual(Model.parseV4l2CaptureMode(null), {})
assert.deepEqual(Model.parseV4l2CaptureMode(undefined), {})
assert.deepEqual(Model.parseV4l2CaptureMode("random text without capture blocks"), {})

// ---------------------------------------------------------------------------
// 10. parseV4l2Formats
// ---------------------------------------------------------------------------

const formats = Model.parseV4l2Formats(V4L2_FORMATS_FIXTURE)
assert.equal(formats.length, 3)
assert.equal(formats[0].pixelformat, "YUYV")
assert.equal(formats[0].description, "YUYV 4:2:2")
assert.deepEqual(formats[0].sizes[0].fps, [30, 24, 20, 15, 10, 7.5, 5])
assert.equal(formats[0].sizes[0].fps[5], 7.5)
assert.equal(formats[1].pixelformat, "MJPG")
assert.equal(formats[1].sizes.length, 3)
assert.deepEqual(formats[1].sizes[1].fps, [60, 30, 24, 20, 15, 10, 7.5, 5])
assert.equal(formats[2].pixelformat, "NV12")
assert.deepEqual(Model.parseV4l2Formats(""), [])
assert.deepEqual(Model.parseV4l2Formats(null), [])

// Real formats fixture from this machine
const realFormats = Model.parseV4l2Formats(REAL_FORMATS)
assert.equal(realFormats.length, 2)
assert.equal(realFormats[0].pixelformat, "MJPG")
assert.equal(realFormats[0].sizes.length, 9)
assert.deepEqual(realFormats[0].sizes[0], { width: 1280, height: 720, fps: [30] })
assert.equal(realFormats[1].pixelformat, "YUYV")
assert.deepEqual(realFormats[1].sizes[3], { width: 640, height: 480, fps: [30] })

// ---------------------------------------------------------------------------
// 11. V4L2 command builders
// ---------------------------------------------------------------------------

assert.deepEqual(Model.buildV4l2ListCommand(), [
  "v4l2-ctl", "-d", "/dev/video0", "--get-fmt-video", "--get-parm", "--list-ctrls-menus"
])
assert.deepEqual(Model.buildV4l2ListCommand("/dev/video2"), [
  "v4l2-ctl", "-d", "/dev/video2", "--get-fmt-video", "--get-parm", "--list-ctrls-menus"
])

assert.deepEqual(Model.buildV4l2GetCommand(null, "brightness"), [
  "v4l2-ctl", "-d", "/dev/video0", "--get-ctrl", "brightness"
])
assert.deepEqual(Model.buildV4l2GetCommand("/dev/video2", "contrast"), [
  "v4l2-ctl", "-d", "/dev/video2", "--get-ctrl", "contrast"
])

assert.deepEqual(Model.buildV4l2SetCommand(null, "brightness", 130), [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl", "brightness=130"
])
assert.deepEqual(Model.buildV4l2SetCommand("/dev/video2", "gain", 15), [
  "v4l2-ctl", "-d", "/dev/video2", "--set-ctrl", "gain=15"
])

assert.deepEqual(Model.buildFovListCommand(), ["cameractrls", "-d", "/dev/video0", "-l"])
assert.deepEqual(Model.buildFovListCommand("/dev/video2"), ["cameractrls", "-d", "/dev/video2", "-l"])
assert.deepEqual(Model.buildFovSetCommand(null, 65), ["cameractrls", "-d", "/dev/video0", "-c", "logitech_brio_fov=65"])
assert.deepEqual(Model.buildFovSetCommand("/dev/video2", 90), ["cameractrls", "-d", "/dev/video2", "-c", "logitech_brio_fov=90"])

assert.deepEqual(Model.buildV4l2ListFormatsCommand(), [
  "v4l2-ctl", "-d", "/dev/video0", "--list-formats-ext"
])
assert.deepEqual(Model.buildV4l2ListFormatsCommand("/dev/video1"), [
  "v4l2-ctl", "-d", "/dev/video1", "--list-formats-ext"
])

assert.deepEqual(
  Model.buildV4l2SetCaptureModeCommand(null, { width: 1920, height: 1080, pixelformat: "MJPG", fps: 30 }),
  ["v4l2-ctl", "-d", "/dev/video0", "--set-fmt-video=width=1920,height=1080,pixelformat=MJPG", "--set-parm=30"]
)
assert.deepEqual(
  Model.buildV4l2SetCaptureModeCommand("/dev/video2", { width: 1280, height: 720, pixelformat: "MJPG", fps: 60 }),
  ["v4l2-ctl", "-d", "/dev/video2", "--set-fmt-video=width=1280,height=720,pixelformat=MJPG", "--set-parm=60"]
)

// ---------------------------------------------------------------------------
// 12. Resolution / fps curation
// ---------------------------------------------------------------------------

const resOpts = Model.resolutionOptions(formats)
assert.equal(resOpts.length, 3)
assert.deepEqual(resOpts.map(function(r) { return r.value }), ["1920x1080", "1280x720", "640x480"])
assert.deepEqual(resOpts.map(function(r) { return r.label }), ["1080p", "720p", "480p"])
assert.equal(resOpts[2].pixelformat, "MJPG")

const resWithCurrent = Model.resolutionOptions(formats, { width: 640, height: 360 })
assert.equal(resWithCurrent.length, 4)
assert.equal(resWithCurrent[3].value, "640x360")
assert.equal(resWithCurrent[3].label, "640\u00D7360")
assert.equal(resWithCurrent[3].pixelformat, "NV12")

const resAll = Model.resolutionOptions(formats, null, true)
assert.equal(resAll.length, 4)
assert.deepEqual(Model.resolutionOptions([]), [])
assert.deepEqual(Model.resolutionOptions(null), [])

// Real formats: current 1280x720 + preferred 720p/480p
const realRes = Model.resolutionOptions(realFormats, realMode)
assert.deepEqual(realRes.map(function(r) { return r.value }), ["1280x720", "640x480"])
assert.equal(realRes[0].pixelformat, "MJPG")

assert.deepEqual(Model.PREFERRED_FPS, [60, 30, 24, 15])

const fps1080 = Model.fpsOptions(formats, 1920, 1080, "MJPG")
assert.deepEqual(fps1080.map(function(o) { return o.fps }), [30, 24, 15])
assert.deepEqual(fps1080.map(function(o) { return o.value }), ["30", "24", "15"])
assert.deepEqual(fps1080.map(function(o) { return o.label }), ["30", "24", "15"])

const fpsWith75 = Model.fpsOptions(formats, 1920, 1080, "MJPG", 7.5)
assert.deepEqual(fpsWith75.map(function(o) { return o.fps }), [30, 24, 15, 7.5])

const fpsAll = Model.fpsOptions(formats, 1920, 1080, "MJPG", null, true)
assert.equal(fpsAll.length, 7)
assert.deepEqual(fpsAll.map(function(o) { return o.fps }), [30, 24, 20, 15, 10, 7.5, 5])

const fps720 = Model.fpsOptions(formats, 1280, 720, "MJPG")
assert.deepEqual(fps720.map(function(o) { return o.fps }), [60, 30, 24, 15])

assert.deepEqual(Model.fpsOptions(formats, 9999, 9999, "MJPG"), [])
assert.deepEqual(Model.fpsOptions([], 1920, 1080), [])

// ---------------------------------------------------------------------------
// 13. pickCaptureMode
// ---------------------------------------------------------------------------

assert.deepEqual(Model.pickCaptureMode(formats, null, 1920, 1080, 30), {
  width: 1920, height: 1080, pixelformat: "MJPG", fps: 30
})
assert.equal(Model.pickCaptureMode(formats, null, 1920, 1080, 60).fps, 30)
const picked22 = Model.pickCaptureMode(formats, null, 1920, 1080, 22)
assert.ok(picked22.fps === 20 || picked22.fps === 24)
assert.equal(Model.pickCaptureMode(formats, { pixelformat: "YUYV" }, 1920, 1080, 30).pixelformat, "MJPG")
assert.equal(Model.pickCaptureMode(formats, { pixelformat: "YUYV" }, 640, 480, 30).pixelformat, "YUYV")
assert.equal(Model.pickCaptureMode(formats, null, 640, 360, 30).pixelformat, "NV12")
assert.equal(Model.pickCaptureMode(formats, null, 9999, 8888, 30), null)
assert.equal(Model.pickCaptureMode([], null, 1920, 1080, 30), null)

// Explicit fps the current format cannot deliver exactly at that size:
// switch to a format that can. Real Integrated Camera data — YUYV 720p caps
// at 10fps, MJPG offers 30.
assert.deepEqual(Model.pickCaptureMode(realFormats, { pixelformat: "YUYV", fps: 10 }, 1280, 720, 30), {
  width: 1280, height: 720, pixelformat: "MJPG", fps: 30
})
// Explicit fps nobody offers at that size: keep the current format, closest fps.
assert.deepEqual(
  Model.pickCaptureMode(realFormats, { pixelformat: "YUYV", fps: 10 }, 1280, 720, 20),
  { width: 1280, height: 720, pixelformat: "YUYV", fps: 10 }
)
// Implied fps (none given): never switches formats.
assert.equal(Model.pickCaptureMode(realFormats, { pixelformat: "YUYV", fps: 10 }, 1280, 720, null).pixelformat, "YUYV")
// Synthetic fixture: YUYV 640x480 tops out at 30, MJPG offers 60.
assert.equal(Model.pickCaptureMode(formats, { pixelformat: "YUYV" }, 640, 480, 60).pixelformat, "MJPG")
assert.equal(Model.pickCaptureMode(formats, { pixelformat: "YUYV" }, 640, 480, 60).fps, 60)

// 13b. bestFpsForSize + pickPreferredCaptureMode: the default capture mode
// is the preferred size at the HIGHEST fps the hardware offers — switching
// pixel format when the power-on format is the bottleneck (USB-2 YUYV
// 720p@10 -> MJPG 720p@30)
// -------------------------------------------------------------------------

assert.equal(Model.bestFpsForSize(formats, 1280, 720), 60)
assert.equal(Model.bestFpsForSize(formats, 1920, 1080), 30)
assert.equal(Model.bestFpsForSize(formats, 640, 480), 60) // MJPG 60 beats YUYV 30
assert.equal(Model.bestFpsForSize(realFormats, 1280, 720), 30)
assert.equal(Model.bestFpsForSize(formats, 9999, 8888), null)
assert.equal(Model.bestFpsForSize(null, 1280, 720), null)

// Real Integrated Camera: power-on YUYV 720p@10 defaults to MJPG 720p@30
assert.deepEqual(
  Model.pickPreferredCaptureMode(realFormats, { width: 1280, height: 720, pixelformat: "YUYV", fps: 10 }),
  { width: 1280, height: 720, pixelformat: "MJPG", fps: 30 }
)
// Already at the preferred mode: same mode back (widget no-ops)
assert.deepEqual(
  Model.pickPreferredCaptureMode(realFormats, { width: 1280, height: 720, pixelformat: "MJPG", fps: 30 }),
  { width: 1280, height: 720, pixelformat: "MJPG", fps: 30 }
)
// Mixed synthetic fixture: largest preferred size offered is 1080p MJPG
assert.deepEqual(Model.pickPreferredCaptureMode(formats, null), { width: 1920, height: 1080, pixelformat: "MJPG", fps: 30 })
// No preferred size offered: fall back to the current size at its best fps
const oddSizes = [{ pixelformat: "YUYV", sizes: [{ width: 800, height: 600, fps: [15, 25] }] }]
assert.deepEqual(
  Model.pickPreferredCaptureMode(oddSizes, { width: 800, height: 600, pixelformat: "YUYV", fps: 15 }),
  { width: 800, height: 600, pixelformat: "YUYV", fps: 25 }
)
assert.equal(Model.pickPreferredCaptureMode(null, null), null)
assert.equal(Model.pickPreferredCaptureMode([], null), null)
// Exact fps available in the current format: no switch.
assert.equal(Model.pickCaptureMode(formats, { pixelformat: "YUYV" }, 640, 480, 30).pixelformat, "YUYV")

// ---------------------------------------------------------------------------
// 14. resolveAutoExposure
// ---------------------------------------------------------------------------

assert.deepEqual(
  Model.resolveAutoExposure([
    { value: 1, label: "Manual Mode" },
    { value: 3, label: "Aperture Priority Mode" }
  ]),
  { manual: 1, auto: 3 }
)
assert.deepEqual(
  Model.resolveAutoExposure([
    { value: 0, label: "Auto Mode" },
    { value: 1, label: "Manual Mode" }
  ]),
  { manual: 1, auto: 0 }
)
assert.deepEqual(
  Model.resolveAutoExposure([
    { value: 2, label: "Shutter Priority Mode" },
    { value: 3, label: "Aperture Priority Mode" },
    { value: 1, label: "Manual Mode" }
  ]),
  { manual: 1, auto: 3 }
)
assert.deepEqual(
  Model.resolveAutoExposure([
    { value: 1, label: "Manual Mode" },
    { value: 2, label: "Shutter Priority Mode" }
  ]),
  { manual: 1, auto: 2 }
)
assert.deepEqual(Model.resolveAutoExposure([]), { manual: 1, auto: 3 })
assert.deepEqual(Model.resolveAutoExposure(null), { manual: 1, auto: 3 })
assert.deepEqual(Model.resolveAutoExposure(undefined), { manual: 1, auto: 3 })
const strAe = Model.resolveAutoExposure([
  { value: "1", label: "Manual Mode" },
  { value: "3", label: "Aperture Priority Mode" }
])
assert.deepEqual(strAe, { manual: 1, auto: 3 })
assert.equal(typeof strAe.manual, "number")
assert.equal(typeof strAe.auto, "number")

// ---------------------------------------------------------------------------
// 15. inferControlKind + isControlActive
// ---------------------------------------------------------------------------

assert.equal(Model.inferControlKind({ type: "bool", value: 1 }), "toggle")
assert.equal(Model.inferControlKind({ type: "menu", value: 1 }), "segmented")
assert.equal(Model.inferControlKind({ type: "int", min: 0, max: 255 }), "slider")
assert.equal(Model.inferControlKind({ type: "int", min: 0, max: 1 }), "toggle")
assert.equal(Model.inferControlKind({ type: "int64", min: 0, max: 1000 }), "slider")
assert.equal(Model.inferControlKind({ type: "rect" }), null)
assert.equal(Model.inferControlKind({ type: "bitmask" }), null)
assert.equal(Model.inferControlKind({ type: "string" }), null)
assert.equal(Model.inferControlKind({ type: "button" }), null)
assert.equal(Model.inferControlKind(null), null)

// focus_absolute dependsOn focus_automatic_continuous (active when 0)
assert.equal(Model.isControlActive("focus_absolute", { focus_automatic_continuous: 0 }), true)
assert.equal(Model.isControlActive("focus_absolute", { focus_automatic_continuous: 1 }), false)
assert.equal(Model.isControlActive("focus_absolute", { focus_automatic_continuous: false }), true)
assert.equal(Model.isControlActive("focus_absolute", { focus_automatic_continuous: { value: 0 } }), true)
assert.equal(Model.isControlActive("focus_absolute", { focus_automatic_continuous: { value: 1 } }), false)
// Parent not reported: assume active (driver inactive flags gate the rest)
assert.equal(Model.isControlActive("focus_absolute", {}), true)

// exposure_time_absolute dependsOn auto_exposure (active when manual mode 1)
assert.equal(Model.isControlActive("exposure_time_absolute", { auto_exposure: 1 }), true)
assert.equal(Model.isControlActive("exposure_time_absolute", { auto_exposure: 3 }), false)
assert.equal(Model.isControlActive("exposure_time_absolute", { auto_exposure: { value: 1 } }), true)
assert.equal(Model.isControlActive("exposure_time_absolute", { auto_exposure: { value: 3 } }), false)
assert.equal(Model.isControlActive("exposure_time_absolute", {}), true)

// white_balance_temperature dependsOn white_balance_automatic (active when 0)
assert.equal(Model.isControlActive("white_balance_temperature", { white_balance_automatic: 0 }), true)
assert.equal(Model.isControlActive("white_balance_temperature", { white_balance_automatic: 1 }), false)
assert.equal(Model.isControlActive("white_balance_temperature", {}), true)

// Controls without dependencies are always active
assert.equal(Model.isControlActive("brightness", {}), true)
assert.equal(Model.isControlActive("zoom_absolute", { auto_exposure: 3 }), true)
assert.equal(Model.isControlActive("logitech_brio_fov", {}), true)
assert.equal(Model.isControlActive("unknown_control", {}), true)

// Dependency driven purely from hardware values (synthesized profile)
assert.equal(
  Model.isControlActive("exposure_time_absolute", { auto_exposure: { type: "menu", value: 1 } }),
  true
)

// ---------------------------------------------------------------------------
// 16. settingsLayout
// ---------------------------------------------------------------------------

// Real device profile: no Optics/Advanced sections, ROI skipped,
// inactive flags disable exposure time + white balance temperature
const realLayout = Model.settingsLayout(realCtrls, {})
assert.deepEqual(sectionTitles(realLayout), ["EXPOSURE", "COLOR", "UTILITIES"])

assert.equal(sectionItems(realLayout, "EXPOSURE").length, 3)
const realAe = findItem(realLayout, "auto_exposure")
assert.equal(realAe.kind, "segmented")
assert.equal(realAe.value, 3)
assert.equal(realAe.enabled, true)
assert.deepEqual(realAe.options, [
  { value: "1", label: "Manual Mode" },
  { value: "3", label: "Aperture Priority Mode" }
])

const realEta = findItem(realLayout, "exposure_time_absolute")
assert.equal(realEta.kind, "slider")
assert.equal(realEta.min, 4)
assert.equal(realEta.max, 1250)
assert.equal(realEta.value, 157)
assert.equal(realEta.enabled, false)
assert.equal(realEta.hint, "Disabled while auto exposure is on")

const realEdf = findItem(realLayout, "exposure_dynamic_framerate")
assert.equal(realEdf.kind, "toggle")
assert.equal(realEdf.value, 1)
assert.equal(realEdf.enabled, true)

assert.equal(sectionItems(realLayout, "COLOR").length, 8)
const realHue = findItem(realLayout, "hue")
assert.equal(realHue.kind, "slider")
assert.equal(realHue.min, -180)
assert.equal(realHue.max, 180)
assert.equal(realHue.label, "Hue")
assert.equal(realHue.enabled, true)
const realGamma = findItem(realLayout, "gamma")
assert.equal(realGamma.label, "Gamma")
assert.equal(realGamma.min, 90)
assert.equal(realGamma.max, 150)
const realWbt = findItem(realLayout, "white_balance_temperature")
assert.equal(realWbt.enabled, false)
assert.equal(realWbt.unit, "K")
const realWba = findItem(realLayout, "white_balance_automatic")
assert.equal(realWba.kind, "toggle")
assert.equal(realWba.value, 1)

const realPlf = findItem(realLayout, "power_line_frequency")
assert.equal(realPlf.kind, "segmented")
assert.deepEqual(realPlf.options, [
  { value: "0", label: "Disabled" },
  { value: "1", label: "50 Hz" },
  { value: "2", label: "60 Hz" }
])
const realBlc = findItem(realLayout, "backlight_compensation")
assert.equal(realBlc.kind, "slider") // 0..2 on this device: NOT a toggle
assert.equal(realBlc.min, 0)
assert.equal(realBlc.max, 2)

// ROI controls are unrenderable and must not appear anywhere
assert.equal(findItem(realLayout, "region_of_interest_rectangle"), null)
assert.equal(findItem(realLayout, "region_of_interest_auto_ctrls"), null)

// FOV injection: injected first into Optics with opts-driven value/options
const realLayoutFov = Model.settingsLayout(realCtrls, {
  fovAvailable: true,
  fovValue: 78,
  fovOptions: [65, 78, 90]
})
assert.deepEqual(sectionTitles(realLayoutFov), ["OPTICS", "EXPOSURE", "COLOR", "UTILITIES"])
const fovItem = sectionItems(realLayoutFov, "OPTICS")[0]
assert.equal(fovItem.name, "logitech_brio_fov")
assert.equal(fovItem.label, "Field of View")
assert.equal(fovItem.kind, "segmented")
assert.equal(fovItem.value, 78)
assert.equal(fovItem.unit, "\u00B0")
assert.equal(fovItem.enabled, true)
assert.deepEqual(fovItem.options, [
  { value: "65", label: "65\u00B0" },
  { value: "78", label: "78\u00B0" },
  { value: "90", label: "90\u00B0" }
])

// FOV with defaults (no value/options given)
const fovDefaults = Model.settingsLayout({}, { fovAvailable: true })
assert.deepEqual(sectionTitles(fovDefaults), ["OPTICS"])
assert.equal(fovDefaults[0].items[0].value, 65)
assert.deepEqual(
  fovDefaults[0].items[0].options.map(function(o) { return o.value }),
  ["65", "78", "90"]
)
// Custom options list overrides the default 65/78/90
const fovCustom = Model.settingsLayout({}, { fovAvailable: true, fovOptions: [65, 90] })
assert.deepEqual(
  fovCustom[0].items[0].options.map(function(o) { return o.value }),
  ["65", "90"]
)

// Device profile: pantilt kinds, 0..1 backlight -> toggle, inactive focus slider
const deviceLayout = Model.settingsLayout(v4l2, {})
assert.deepEqual(sectionTitles(deviceLayout), ["OPTICS", "EXPOSURE", "COLOR", "UTILITIES"])
assert.deepEqual(
  sectionItems(deviceLayout, "OPTICS").map(function(i) { return i.name }),
  ["pan_absolute", "tilt_absolute", "focus_absolute", "focus_automatic_continuous", "zoom_absolute"]
)
assert.equal(findItem(deviceLayout, "pan_absolute").kind, "pantilt")
assert.equal(findItem(deviceLayout, "tilt_absolute").kind, "pantilt")
assert.equal(findItem(deviceLayout, "zoom_absolute").unit, "%")
assert.equal(findItem(deviceLayout, "focus_absolute").enabled, false)
assert.equal(findItem(deviceLayout, "focus_absolute").hint, "Disabled while autofocus is on")
assert.equal(findItem(deviceLayout, "backlight_compensation").kind, "toggle") // 0..1 on Device
assert.equal(findItem(deviceLayout, "exposure_time_absolute").enabled, false)

// Unknown controls land in Advanced with humanized labels
const advLayout = Model.settingsLayout({
  vendor_gain: { type: "int", min: 0, max: 100, step: 5, value: 50, defaultVal: 50 },
  vendor_mode: {
    type: "menu", value: 1, min: 0, max: 2, defaultVal: 0,
    menuItems: [{ value: 0, label: "Off" }, { value: 1, label: "On" }]
  },
  vendor_flag: { type: "bool", value: 1, defaultVal: 0 }
})
assert.deepEqual(sectionTitles(advLayout), ["ADVANCED"])
assert.deepEqual(
  sectionItems(advLayout, "ADVANCED").map(function(i) { return i.name }),
  ["vendor_gain", "vendor_mode", "vendor_flag"]
)
assert.equal(findItem(advLayout, "vendor_gain").kind, "slider")
assert.equal(findItem(advLayout, "vendor_gain").label, "Vendor Gain")
assert.equal(findItem(advLayout, "vendor_gain").step, 5)
assert.equal(findItem(advLayout, "vendor_mode").kind, "segmented")
assert.deepEqual(findItem(advLayout, "vendor_mode").options, [
  { value: "0", label: "Off" },
  { value: "1", label: "On" }
])
assert.equal(findItem(advLayout, "vendor_flag").kind, "toggle")

// Unrenderable shapes are skipped
assert.deepEqual(Model.settingsLayout({}), [])
assert.deepEqual(Model.settingsLayout(null), [])
assert.deepEqual(Model.settingsLayout(), [])
assert.deepEqual(Model.settingsLayout({ mystery_menu: { type: "menu", value: 1, min: 0, max: 2 } }), [])
assert.deepEqual(Model.settingsLayout({ broken_int: { type: "int", value: 5 } }), [])
assert.deepEqual(Model.settingsLayout({ roi: { type: "rect", value: 0 } }), [])
assert.deepEqual(Model.settingsLayout({ roi_mask: { type: "bitmask", value: 16 } }), [])

// int64 renders as slider
const int64Layout = Model.settingsLayout({ big_counter: { type: "int64", min: 0, max: 1000, step: 10, value: 100, defaultVal: 0 } })
assert.equal(int64Layout[0].items[0].kind, "slider")

// Dependency without hardware inactive flag: enabled follows parent value
const depLayout = Model.settingsLayout({
  auto_exposure: {
    type: "menu", value: 1, min: 0, max: 3, defaultVal: 3,
    menuItems: [{ value: 1, label: "Manual Mode" }, { value: 3, label: "Aperture Priority Mode" }]
  },
  exposure_time_absolute: { type: "int", min: 4, max: 1250, step: 1, value: 157, defaultVal: 157 }
})
assert.equal(findItem(depLayout, "exposure_time_absolute").enabled, true) // parent is manual
const depLayoutAuto = Model.settingsLayout({
  auto_exposure: {
    type: "menu", value: 3, min: 0, max: 3, defaultVal: 3,
    menuItems: [{ value: 1, label: "Manual Mode" }, { value: 3, label: "Aperture Priority Mode" }]
  },
  exposure_time_absolute: { type: "int", min: 4, max: 1250, step: 1, value: 157, defaultVal: 157 }
})
assert.equal(findItem(depLayoutAuto, "exposure_time_absolute").enabled, false) // parent is auto

// Control without value falls back to its default for display
const noValueLayout = Model.settingsLayout({ brightness: { type: "int", min: 0, max: 255, step: 1, defaultVal: 128 } })
assert.equal(noValueLayout[0].items[0].value, 128)

// ---------------------------------------------------------------------------
// 17. getDefaults: hardware-driven defaults
// ---------------------------------------------------------------------------

assert.deepEqual(Model.getDefaults(realCtrls), {
  brightness: 128,
  contrast: 32,
  saturation: 64,
  hue: 0,
  white_balance_automatic: 1,
  gamma: 120,
  power_line_frequency: 1,
  white_balance_temperature: 4600,
  sharpness: 3,
  backlight_compensation: 1,
  auto_exposure: 3,
  exposure_time_absolute: 157,
  exposure_dynamic_framerate: 0
})
// ROI types are excluded from defaults
assert.equal(Model.getDefaults(realCtrls).region_of_interest_auto_ctrls, undefined)
assert.equal(Model.getDefaults(realCtrls).region_of_interest_rectangle, undefined)
assert.deepEqual(Model.getDefaults({}), {})
assert.deepEqual(Model.getDefaults(null), {})
assert.deepEqual(Model.getDefaults({ brightness: { default: 100 } }), { brightness: 100 })
// Un-settable types excluded
assert.deepEqual(Model.getDefaults({ roi_mask: { type: "bitmask", defaultVal: 16 } }), {})

// ---------------------------------------------------------------------------
// 18. buildResetCommands(device, controls): 3-phase + FOV
// ---------------------------------------------------------------------------

// Real device: no cameractrls -> 3 commands
const realReset = Model.buildResetCommands("/dev/video0", realCtrls)
assert.equal(realReset.length, 3)
assert.deepEqual(realReset[0], [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl",
  "white_balance_automatic=0,auto_exposure=1"
])
assert.deepEqual(realReset[1], [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl",
  "white_balance_temperature=4600,exposure_time_absolute=157"
])
assert.deepEqual(realReset[2], [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl",
  "brightness=128,contrast=32,saturation=64,hue=0,white_balance_automatic=1,gamma=120,power_line_frequency=1,sharpness=3,backlight_compensation=1,auto_exposure=3,exposure_dynamic_framerate=0"
])
// ROI controls are excluded from every phase
for (const cmd of realReset) {
  assert.ok(!cmd.join(" ").includes("region_of_interest"), "reset must skip ROI controls")
}
// Device override
assert.equal(Model.buildResetCommands("/dev/video9", realCtrls)[0][2], "/dev/video9")
// Default device
assert.equal(Model.buildResetCommands(null, realCtrls)[0][2], "/dev/video0")

// Device + FOV: 4 commands, all 17 V4L2 controls covered
const deviceWithFov = Object.assign({}, v4l2, {
  logitech_brio_fov: { name: "logitech_brio_fov", backend: "cameractrls", defaultVal: 65, default: 65 }
})
const resetWithFov = Model.buildResetCommands("/dev/video0", deviceWithFov)
assert.equal(resetWithFov.length, 4)
assert.deepEqual(resetWithFov[0], [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl",
  "white_balance_automatic=0,auto_exposure=1,focus_automatic_continuous=0"
])
assert.deepEqual(resetWithFov[1], [
  "v4l2-ctl", "-d", "/dev/video0", "--set-ctrl",
  "white_balance_temperature=5000,exposure_time_absolute=156,focus_absolute=0"
])
const phase3Remaining = resetWithFov[2][4]
for (const pair of [
  "brightness=128", "contrast=128", "saturation=128", "gain=0",
  "power_line_frequency=2", "sharpness=128", "backlight_compensation=1",
  "white_balance_automatic=1", "auto_exposure=3", "exposure_dynamic_framerate=0",
  "pan_absolute=0", "tilt_absolute=0", "focus_automatic_continuous=1", "zoom_absolute=100"
]) {
  assert.ok(phase3Remaining.includes(pair), `Device phase-3 missing ${pair}`)
}
for (const dep of ["white_balance_temperature", "exposure_time_absolute", "focus_absolute"]) {
  assert.ok(!phase3Remaining.includes(dep + "="), `Device phase-3 must not include dependent ${dep}`)
}
assert.deepEqual(resetWithFov[3], ["cameractrls", "-d", "/dev/video0", "-c", "logitech_brio_fov=65"])

// Every V4L2 control is mentioned across phases 0-2
const allMentions = resetWithFov.slice(0, 3).map(function(c) { return c[4] }).join(",")
for (const name of Object.keys(v4l2)) {
  assert.ok(allMentions.includes(name + "="), `Device reset missing ${name}`)
}

// Dependent without parent: single direct command
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { exposure_time_absolute: { defaultVal: 156 } }),
  [["v4l2-ctl", "-d", "/dev/video0", "--set-ctrl", "exposure_time_absolute=156"]]
)
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { white_balance_temperature: { defaultVal: 5000 } }),
  [["v4l2-ctl", "-d", "/dev/video0", "--set-ctrl", "white_balance_temperature=5000"]]
)
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { focus_absolute: { defaultVal: 0 } }),
  [["v4l2-ctl", "-d", "/dev/video0", "--set-ctrl", "focus_absolute=0"]]
)

// `default` property fallback
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { brightness: { default: 100 } }),
  [["v4l2-ctl", "-d", "/dev/video0", "--set-ctrl", "brightness=100"]]
)

// Non-catalog controls reset with their hardware defaults
const nonCatalogReset = Model.buildResetCommands("/dev/video0", {
  gamma: { defaultVal: 120 },
  hue: { default: 15 }
})
assert.equal(nonCatalogReset.length, 1)
assert.ok(nonCatalogReset[0][4].includes("gamma=120"))
assert.ok(nonCatalogReset[0][4].includes("hue=15"))

// FOV-only profile
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { logitech_brio_fov: { defaultVal: 78 } }),
  [["cameractrls", "-d", "/dev/video0", "-c", "logitech_brio_fov=78"]]
)
// FOV without a default falls back to 65
assert.deepEqual(
  Model.buildResetCommands("/dev/video0", { logitech_brio_fov: { backend: "cameractrls" } }),
  [["cameractrls", "-d", "/dev/video0", "-c", "logitech_brio_fov=65"]]
)

// Un-settable types are never reset
assert.deepEqual(Model.buildResetCommands("/dev/video0", { roi_mask: { type: "bitmask", defaultVal: 16 } }), [])
assert.deepEqual(Model.buildResetCommands("/dev/video0", { roi_rect: { type: "rect", defaultVal: 0 } }), [])

// Generic UVC profile (auto_exposure 0..2 menu)
const GENERIC_UVC_FIXTURE = `User Controls

                     brightness 0x00980900 (int)    : min=-64 max=64 step=1 default=0 value=0 flags=has-min-max
                       contrast 0x00980901 (int)    : min=0 max=64 step=1 default=32 value=32 flags=has-min-max
                     saturation 0x00980902 (int)    : min=0 max=128 step=1 default=64 value=64 flags=has-min-max
        white_balance_automatic 0x0098090c (bool)   : default=1 value=1
                          gamma 0x00980910 (int)    : min=100 max=300 step=1 default=100 value=100 flags=has-min-max
                           gain 0x00980913 (int)    : min=0 max=15 step=1 default=0 value=0 flags=has-min-max
           power_line_frequency 0x00980918 (menu)   : min=0 max=2 default=1 value=1 (50 Hz)
				0: Disabled
				1: 50 Hz
				2: 60 Hz
                      sharpness 0x0098091b (int)    : min=0 max=6 step=1 default=2 value=2 flags=has-min-max
         backlight_compensation 0x0098091c (int)    : min=0 max=1 step=1 default=0 value=0 flags=has-min-max

Camera Controls

                  auto_exposure 0x009a0901 (menu)   : min=0 max=1 default=0 value=0 (Auto Mode)
				0: Auto Mode
				1: Manual Mode
         exposure_time_absolute 0x009a0902 (int)    : min=1 max=5000 step=1 default=166 value=166 flags=inactive, has-min-max
`
const genericParsed = Model.parseV4l2Ctrls(GENERIC_UVC_FIXTURE)
const genericReset = Model.buildResetCommands("/dev/video2", genericParsed)
assert.equal(genericReset.length, 3)
assert.deepEqual(genericReset[0], ["v4l2-ctl", "-d", "/dev/video2", "--set-ctrl", "auto_exposure=1"])
assert.deepEqual(genericReset[1], ["v4l2-ctl", "-d", "/dev/video2", "--set-ctrl", "exposure_time_absolute=166"])
const genericRemaining = genericReset[2][4]
assert.ok(genericRemaining.includes("brightness=0"))
assert.ok(genericRemaining.includes("contrast=32"))
assert.ok(genericRemaining.includes("saturation=64"))
assert.ok(genericRemaining.includes("white_balance_automatic=1"))
assert.ok(genericRemaining.includes("gamma=100"))
assert.ok(genericRemaining.includes("gain=0"))
assert.ok(genericRemaining.includes("power_line_frequency=1"))
assert.ok(genericRemaining.includes("sharpness=2"))
assert.ok(genericRemaining.includes("backlight_compensation=0"))
assert.ok(genericRemaining.includes("auto_exposure=0"))
assert.ok(!genericRemaining.includes("exposure_time_absolute"))
assert.ok(!genericRemaining.includes("logitech_brio_fov"))

// Empty/missing profiles
assert.deepEqual(Model.buildResetCommands("/dev/video0", {}), [])
assert.deepEqual(Model.buildResetCommands("/dev/video0", null), [])
assert.deepEqual(Model.buildResetCommands(), [])
assert.deepEqual(Model.buildResetCommands("/dev/video2"), [])

// No flip control ever appears in reset or set commands
const q = String.fromCharCode(34)
for (const name of ["hflip", "vflip", "horizontal_flip", "mirror"]) {
  assert.ok(!JSON.stringify(realReset).includes(name), `real reset contains ${name}`)
  assert.ok(!JSON.stringify(resetWithFov).includes(name), `reset contains ${name}`)
  assert.ok(!JSON.stringify(Model.buildV4l2SetCommand("/dev/video0", "brightness", 1)).includes(name))
}

// ---------------------------------------------------------------------------
// 19. humanizeName + formatTimestamp
// ---------------------------------------------------------------------------

assert.equal(Model.humanizeName("white_balance_temperature"), "White Balance Temperature")
assert.equal(Model.humanizeName("gamma"), "Gamma")
assert.equal(Model.humanizeName("some_unknown_ctrl"), "Some Unknown Ctrl")
assert.equal(Model.humanizeName(""), "")
assert.equal(Model.humanizeName(null), "")

assert.equal(Model.formatTimestamp(new Date(2026, 8, 22, 15, 30, 0)), "20260922-153000")
assert.equal(Model.formatTimestamp(new Date(2026, 0, 3, 1, 2, 3)), "20260103-010203")
assert.ok(/^\d{8}-\d{6}$/.test(Model.formatTimestamp()))
assert.ok(/^\d{8}-\d{6}$/.test(Model.formatTimestamp(new Date())))

// ---------------------------------------------------------------------------
// 19b. parseFlag
// ---------------------------------------------------------------------------

assert.equal(Model.parseFlag("1"), true)
assert.equal(Model.parseFlag("true"), true)
assert.equal(Model.parseFlag("ON"), true)
assert.equal(Model.parseFlag(" Yes "), true)
assert.equal(Model.parseFlag("0"), false)
assert.equal(Model.parseFlag("False"), false)
assert.equal(Model.parseFlag("off"), false)
assert.equal(Model.parseFlag("no"), false)
assert.equal(Model.parseFlag(""), null)
assert.equal(Model.parseFlag("toggle"), null)
assert.equal(Model.parseFlag(undefined), null)
assert.equal(Model.parseFlag(null), null)

// ---------------------------------------------------------------------------
// 20. Hub / capture command builders
// ---------------------------------------------------------------------------

// Mode given: input format pinned. ffmpeg's v4l2 indev renegotiates the
// device format at open otherwise — an MJPG@30 camera opened with only
// -framerate gets knocked back to YUYV@10 (verified empirically).
assert.deepEqual(Model.buildHubCommand("/dev/video0", ["/dev/video8"], { width: 1280, height: 720, pixelformat: "MJPG", fps: 30 }), [
  "ffmpeg", "-hide_banner", "-loglevel", "warning",
  "-f", "v4l2", "-input_format", "mjpeg", "-video_size", "1280x720", "-framerate", "30",
  "-fflags", "nobuffer", "-flags", "low_delay", "-threads", "1", "-i", "/dev/video0",
  "-map", "0:v", "-c:v", "rawvideo", "-pix_fmt", "yuyv422", "-f", "v4l2", "/dev/video8"
])

assert.deepEqual(Model.buildHubCommand("/dev/video0", ["/dev/video8", "/dev/video9"], { width: 640, height: 480, pixelformat: "YUYV", fps: 25 }), [
  "ffmpeg", "-hide_banner", "-loglevel", "warning",
  "-f", "v4l2", "-input_format", "yuyv422", "-video_size", "640x480", "-framerate", "25",
  "-fflags", "nobuffer", "-flags", "low_delay", "-threads", "1", "-i", "/dev/video0",
  "-map", "0:v", "-c:v", "rawvideo", "-pix_fmt", "yuyv422", "-f", "v4l2", "/dev/video8",
  "-map", "0:v", "-c:v", "rawvideo", "-pix_fmt", "yuyv422", "-f", "v4l2", "/dev/video9"
])

// No mode: bare -framerate fallback, default 30; fractional fps preserved
var bare = Model.buildHubCommand("/dev/video0", ["/dev/video8"])
assert.equal(bare.indexOf("-input_format"), -1)
assert.equal(bare.indexOf("-video_size"), -1)
assert.equal(bare[bare.indexOf("-framerate") + 1], "30")
assert.equal(Model.buildHubCommand("/dev/video0", ["/dev/video8"], { fps: 7.5 })[7], "7.5")
// Unknown pixelformat skipped, size still pinned
var unk = Model.buildHubCommand("/dev/video0", ["/dev/video8"], { width: 1280, height: 720, pixelformat: "XXXX", fps: 30 })
assert.equal(unk.indexOf("-input_format"), -1)
assert.equal(unk[unk.indexOf("-video_size") + 1], "1280x720")
// Tolerant of missing/empty outputs
assert.equal(Model.buildHubCommand("/dev/video0", null, null).indexOf("-map"), -1)
assert.equal(Model.buildHubCommand("/dev/video0", [], null).indexOf("-map"), -1)
assert.equal(Model.buildHubCommand("/dev/video0", ["/dev/video8", null], null).length, 25)

// Photo: $HOME expands at runtime; mkdir -p guards the target dir; exec replaces sh
assert.deepEqual(Model.buildPhotoCommand("/dev/video8", "$HOME/Pictures/webcam-20260922-153000.jpg"), [
  "sh", "-c",
  'mkdir -p $(dirname "$HOME/Pictures/webcam-20260922-153000.jpg") && ' +
  'exec ffmpeg -hide_banner -loglevel error ' +
  '-f v4l2 -i "/dev/video8" ' +
  '-frames:v 1 -q:v 2 "$HOME/Pictures/webcam-20260922-153000.jpg"'
])
// $ is NOT escaped
const photoScript = Model.buildPhotoCommand("/dev/video0", "$HOME/Pictures/x.jpg")[2]
assert.ok(photoScript.includes('"' + "$" + 'HOME/Pictures/x.jpg"'))
assert.ok(!photoScript.includes("\\$"))
// Spaces are quoted, embedded quotes are escaped
const spacedScript = Model.buildPhotoCommand("/dev/video0", "$HOME/Pictures/My Folder/x.jpg")[2]
assert.ok(spacedScript.includes('"' + "$" + 'HOME/Pictures/My Folder/x.jpg"'))
const tricky = "/tmp/a" + q + "b.jpg"
const trickyScript = Model.buildPhotoCommand("/dev/video0", tricky)[2]
assert.ok(trickyScript.includes("/tmp/a\\" + q + "b.jpg"))

// Record: x264 MP4, same shell wrapping
assert.deepEqual(Model.buildRecordCommand("/dev/video0", "$HOME/Videos/webcam-20260922-153000.mp4"), [
  "sh", "-c",
  'mkdir -p $(dirname "$HOME/Videos/webcam-20260922-153000.mp4") && ' +
  'exec ffmpeg -hide_banner -loglevel error ' +
  '-f v4l2 -i "/dev/video0" ' +
  '-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ' +
  '"$HOME/Videos/webcam-20260922-153000.mp4"'
])

// Record with microphone: -f pulse input + AAC 128k before the video codec
assert.deepEqual(Model.buildRecordCommand("/dev/video0", "$HOME/Videos/webcam-20260922-153000.mp4", "alsa_input.pci-0000_06_00.6.analog-stereo"), [
  "sh", "-c",
  'mkdir -p $(dirname "$HOME/Videos/webcam-20260922-153000.mp4") && ' +
  'exec ffmpeg -hide_banner -loglevel error ' +
  '-f v4l2 -i "/dev/video0" ' +
  '-f pulse -i "alsa_input.pci-0000_06_00.6.analog-stereo" ' +
  '-c:a aac -b:a 128k ' +
  '-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ' +
  '"$HOME/Videos/webcam-20260922-153000.mp4"'
])

// Record: mkv path — container inferred from the extension
assert.ok(
  Model.buildRecordCommand("/dev/video0", "$HOME/Videos/webcam-20260922-153000.mkv")[2]
    .indexOf("webcam-20260922-153000.mkv") !== -1
)

// Mic list command + parser: skips .monitor sources, keeps name/description
assert.deepEqual(Model.buildMicListCommand(), ["sh", "-c", "pactl list sources"])
const micOut = [
  "Source #71",
  "\tState: SUSPENDED",
  "\tName: alsa_output.pci-0000_06_00.6.analog-stereo.monitor",
  "\tDescription: Monitor of Ryzen HD Audio Controller Analog Stereo",
  "\tDriver: PipeWire",
  "\tSample Specification: s16le 2ch 48000Hz",
  "",
  "Source #72",
  "\tState: IDLE",
  "\tName: alsa_input.pci-0000_06_00.6.analog-stereo",
  "\tDescription: Ryzen HD Audio Controller Analog Stereo",
  "\tDriver: PipeWire",
  "\tSample Specification: s16le 2ch 48000Hz",
  ""
].join("\n")
assert.deepEqual(Model.parseMicSources(micOut), [
  { name: "alsa_input.pci-0000_06_00.6.analog-stereo", description: "Ryzen HD Audio Controller Analog Stereo" }
])

// Parser against the real fixture: every entry is a non-monitor mic
const micFixture = Model.parseMicSources(fs.readFileSync(path.join(FIXTURES, "mics-pactl.txt"), "utf8"))
assert.ok(micFixture.length >= 1)
for (let mi = 0; mi < micFixture.length; mi++) {
  assert.ok(micFixture[mi].name.indexOf(".monitor") === -1, "monitor leaked: " + micFixture[mi].name)
  assert.ok(micFixture[mi].name.indexOf("alsa_input") === 0, "not an input source: " + micFixture[mi].name)
  assert.ok(micFixture[mi].description !== "", "missing description: " + micFixture[mi].name)
}

// Loopback state probes
assert.deepEqual(Model.buildLoopbackLoadedCommand(), ["sh", "-c", "test -d /sys/module/v4l2loopback"])

// Hub cleanup: kills stale hub ffmpeg processes (writer signature) before a
// fresh start; no-op + exit 0 when none exist
const hubCleanupScript = Model.buildHubCleanupCommand()[2]
assert.ok(hubCleanupScript.indexOf('pgrep -f "ffmpeg .*-f v4l2 /dev/vide[o]"') !== -1)
assert.ok(hubCleanupScript.indexOf("pkill -9") !== -1)
assert.ok(hubCleanupScript.indexOf("fi; true") !== -1)
assert.deepEqual(Model.buildHubCleanupCommand().slice(0, 2), ["sh", "-c"])
assert.deepEqual(
  Model.buildLoopbackInstalledCommand(),
  ["sh", "-c", "command -v modinfo >/dev/null 2>&1 && modinfo v4l2loopback >/dev/null 2>&1"]
)

// ---------------------------------------------------------------------------
// 21. End-to-end discovery chain with a stub v4l2-ctl
// ---------------------------------------------------------------------------

const stubTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "v4l2-stub-"))
try {
  const stubScript = [
    "#!/bin/sh",
    'if [ "$1" = "--list-devices" ]; then',
    "  cat <<'EOF'",
    "Dummy video device (0x0000) (platform:v4l2loopback-000):",
    "\t/dev/video10",
    "",
    "Platform Cam ():",
    "\t/dev/video8",
    "",
    "Webcam With Meta (usb-0000:00:14.0-1):",
    "\t/dev/video0",
    "\t/dev/video1",
    "EOF",
    "  exit 0",
    "fi",
    'if [ "$1" = "-d" ] && [ "$3" = "--info" ]; then',
    '  case "$2" in',
    "    /dev/video10)",
    "      cat <<'EOF'",
    "Driver Info:",
    "\tDriver name   : v4l2 loopback",
    "\tCard type     : Dummy video device (0x0000)",
    "\tBus info      : platform:v4l2loopback-000",
    "\tDriver flags  : 0x00000001",
    "Device Caps   : 0x05200001",
    "\tVideo Capture",
    "\tVideo Output",
    "\tStreaming",
    "EOF",
    "      exit 0",
    "      ;;",
    "    /dev/video8)",
    "      cat <<'EOF'",
    "Driver Info:",
    "\tDriver name   : platform-cam",
    "\tCard type     : Platform Cam",
    "\tBus info      : ",
    "\tDriver flags  : 0x00000001",
    "Device Caps   : 0x04200001",
    "\tVideo Capture",
    "\tStreaming",
    "EOF",
    "      exit 0",
    "      ;;",
    "    /dev/video0)",
    "      cat <<'EOF'",
    "Driver Info:",
    "\tDriver name   : uvcvideo",
    "\tCard type     : Webcam With Meta",
    "\tBus info      : usb-0000:00:14.0-1",
    "\tDriver flags  : 0x00000001",
    "Device Caps   : 0x04200001",
    "\tVideo Capture",
    "\tStreaming",
    "EOF",
    "      exit 0",
    "      ;;",
    "    /dev/video1)",
    "      cat <<'EOF'",
    "Driver Info:",
    "\tDriver name   : uvcvideo",
    "\tCard type     : Webcam With Meta",
    "\tBus info      : usb-0000:00:14.0-1",
    "\tDriver flags  : 0x00000001",
    "Device Caps   : 0x04a00000",
    "\tMetadata Capture",
    "\tStreaming",
    "EOF",
    "      exit 0",
    "      ;;",
    "  esac",
    "fi",
    "exit 1"
  ].join("\n")

  const stubPath = path.join(stubTmpDir, "v4l2-ctl")
  fs.writeFileSync(stubPath, stubScript, { mode: 0o755 })
  const stubEnv = Object.assign({}, process.env, {
    PATH: stubTmpDir + path.delimiter + (process.env.PATH || "")
  })

  // Step 1: list devices
  const listCmd = Model.buildListDevicesCommand()
  const listOut = cp.execFileSync(listCmd[0], listCmd.slice(1), { encoding: "utf8", env: stubEnv })
  const groups = Model.parseV4l2ListDevices(listOut)
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[0], { name: "Dummy video device (0x0000)", bus: "platform:v4l2loopback-000", nodes: ["/dev/video10"] })
  assert.deepEqual(groups[1], { name: "Platform Cam", bus: "", nodes: ["/dev/video8"] })
  assert.deepEqual(groups[2], { name: "Webcam With Meta", bus: "usb-0000:00:14.0-1", nodes: ["/dev/video0", "/dev/video1"] })

  // Step 2: probe all video nodes in one shot
  const nodes = []
  for (const g of groups) nodes.push.apply(nodes, g.nodes)
  const probeCmd2 = Model.buildProbeCommand(nodes)
  const probeOut2 = cp.execFileSync(probeCmd2[0], probeCmd2.slice(1), { encoding: "utf8", env: stubEnv })
  const infos = Model.parseProbeOutput(probeOut2)
  assert.equal(Object.keys(infos).length, 4)

  // Step 3: classify and derive cameras + loopbacks (mirrors the Widget logic)
  assert.equal(Model.classifyNode(infos["/dev/video10"]), "loopback")
  assert.equal(Model.classifyNode(infos["/dev/video8"]), "capture")
  assert.equal(Model.classifyNode(infos["/dev/video0"]), "capture")
  assert.equal(Model.classifyNode(infos["/dev/video1"]), "other")

  const cameras = []
  const loopbacks = []
  for (const g of groups) {
    let captureNode = null
    for (const node of g.nodes) {
      const cls = Model.classifyNode(infos[node])
      if (cls === "loopback") {
        loopbacks.push({ node: node, card: (infos[node] && infos[node].card) || g.name })
      } else if (cls === "capture" && !captureNode) {
        captureNode = node
      }
    }
    if (captureNode) cameras.push({ name: g.name, bus: g.bus, captureNode: captureNode })
  }
  assert.deepEqual(cameras, [
    { name: "Platform Cam", bus: "", captureNode: "/dev/video8" },
    { name: "Webcam With Meta", bus: "usb-0000:00:14.0-1", captureNode: "/dev/video0" }
  ])
  assert.deepEqual(loopbacks, [
    { node: "/dev/video10", card: "Dummy video device (0x0000)" }
  ])

  // Step 4: pick the loopback pair
  const picked = Model.pickLoopbacks(loopbacks)
  assert.equal(picked.main.node, "/dev/video10")
  assert.equal(picked.helper, null)

  // Step 5: camera selector options
  assert.deepEqual(Model.cameraSelectorOptions(cameras), [
    { value: "/dev/video8", label: "Platform Cam" },
    { value: "/dev/video0", label: "Webcam With Meta" }
  ])
} finally {
  fs.rmSync(stubTmpDir, { recursive: true, force: true })
}

console.log("All Model.js tests passed successfully!")
