import QtQuick
import QtQuick.Controls
import QtMultimedia
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Camera hub popup: virtual camera control, snapshot viewfinder, photo /
// record actions, and hardware-driven settings sections (Model.settingsLayout).
PopupWindow {
  id: root

  required property Item anchorItem
  required property QtObject bar
  property var owner: null
  property bool open: false
  property bool devicePresent: false
  property bool permissionDenied: false
  property bool hasCameractrls: false
  property bool fovAvailable: false
  property var controls: ({})
  property var fovControl: ({})
  property var captureMode: ({})
  property var captureFormats: []
  property bool captureBusy: false
  property string modelName: "No camera connected"
  property string devicePath: ""
  property var cameras: []
  property string hubState: "off" // off | starting | running | error
  property bool loopbackInstalled: false
  property bool loopbackLoaded: false
  property var loopbackMain: null
  property var loopbackHelper: null
  onLoopbackHelperChanged: root.syncViewfinderCamera()
  property bool recording: false
  property int recSeconds: 0
  property bool photoBusy: false
  property string lastCaptureMessage: ""
  property bool mirrorPreview: false
  property bool isDragging: false

  // Capture options
  property bool rawPhoto: false       // true: ffmpeg grab of the raw feed; false: on-screen (mirrored) frame
  property string photoFormat: "jpg"  // "jpg" | "png"
  property string recFormat: "mp4"    // "mp4" | "mkv"
  property bool micOn: false
  property string micSource: ""       // "" = system default
  property var micSources: []         // [{name, description}] from pactl

  // Picker model: system default + enumerated mics (labels shortened to fit)
  readonly property var micPickerOptions: {
    var opts = [{ value: "", label: "System default" }]
    var srcs = root.micSources || []
    for (var i = 0; i < srcs.length; i++) {
      var d = srcs[i].description || srcs[i].name
      if (d.length > 26) d = d.substring(0, 25) + "…"
      opts.push({ value: srcs[i].name, label: d })
    }
    return opts
  }
  onMicOnChanged: if (root.micOn) root.refreshMicSources()

  signal refreshRequested()
  signal controlChanged(string name, var value)
  signal captureModeRequested(int width, int height, real fps)
  signal resetRequested()
  signal deviceChangeRequested(string path)
  signal recheckRequested()
  signal virtualCamToggleRequested()
  signal takePhotoRequested()
  signal photoStateChange(bool busy, string message)
  signal recordToggleRequested()
  signal mirrorChangeRequested(bool enabled)

  readonly property bool loopbackReady: root.loopbackLoaded && root.loopbackMain != null && !!root.loopbackMain.node
  readonly property bool hubOn: root.hubState === "running" || root.hubState === "starting"

  readonly property string hubStatusText: {
    if (root.hubState === "running") {
      var node = root.loopbackMain ? root.loopbackMain.node : ""
      return node !== "" ? ("Running → " + node) : "Running"
    }
    if (root.hubState === "starting") return "Starting…"
    if (root.hubState === "error") return "Failed — camera busy, unplugged, or loopback gone"
    if (!root.loopbackLoaded) return "Driver not loaded"
    return "Off"
  }

  readonly property string deviceStatusText: root.devicePath !== ""
    ? (root.devicePath + (root.devicePresent ? " · Connected" : " · Disconnected"))
    : "Disconnected"

  readonly property string viewfinderState: {
    if (!root.devicePresent) return "disconnected"
    if (root.permissionDenied) return "permission"
    if (root.hubState === "starting") return "starting"
    if (root.hubState === "error") return "error"
    if (root.hubState === "off") return "off"
    return "running"
  }
  onViewfinderStateChanged: root.syncViewfinderCamera()

  readonly property var settingsSections: Model.settingsLayout(root.controls, {
    fovAvailable: root.fovAvailable,
    fovValue: (root.fovControl && root.fovControl.value !== undefined) ? root.fovControl.value : undefined,
    fovOptions: (root.fovControl && root.fovControl.options) ? root.fovControl.options : undefined
  })

  function recTimeText() {
    var m = Math.floor(root.recSeconds / 60)
    var s = root.recSeconds % 60
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s
  }

  // Take photo: default captures the on-screen frame (grabToImage — matches
  // the viewfinder including mirror); "Raw camera feed" delegates to the
  // widget's ffmpeg grab of the loopback. Both report via photoStateChange.
  function takePhoto() {
    if (root.photoBusy || root.hubState === "starting") return
    if (root.rawPhoto) {
      root.takePhotoRequested()
      return
    }
    // grabToImage never fires its callback when the item is not attached to a
    // window (seen after popup re-creation) — guard so photoBusy can't stick.
    if (!viewfinder.window) {
      root.photoStateChange(false, "Viewfinder not ready — reopen the popup")
      return
    }
    root.photoStateChange(true, "Taking photo…")
    var home = Quickshell.env("HOME") || ""
    var path = home + "/Pictures/webcam-" + Model.formatTimestamp(new Date()) +
      (root.photoFormat === "png" ? ".png" : ".jpg")
    viewfinder.grabToImage(function(res) {
      var ok = res ? res.saveToFile("file://" + path) : false
      var shown = path
      if (home !== "" && shown.indexOf(home) === 0) shown = "~" + shown.substring(home.length)
      root.photoStateChange(false, ok ? ("Photo saved " + shown) : "Photo save failed")
    })
  }

  // Enumerate microphone sources (pactl via pipewire-pulse). Runs each time
  // the microphone toggle is switched on.
  function refreshMicSources() {
    micListProc.command = Model.buildMicListCommand()
    micListProc.running = true
  }

  readonly property var coordinatorKey: owner || root
  readonly property var anchorWindow: anchorItem ? anchorItem.QsWindow.window : null
  readonly property color bg: Color.popups.background
  property color borderColor: Color.popups.border
  property var borderSpec: Border.localOrSurfaceSpec("popups", "border", borderColor, Color.popups.border, Math.max(1, Style.space(2)))
  readonly property color accent: Color.accent
  readonly property color muted: Color.muted
  readonly property color urgent: Color.urgent

  function luminance(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b }
  readonly property color fg: luminance(bg) > 0.6 ? "#1a1a1a" : Color.popups.text
  readonly property color safeMuted: luminance(bg) > 0.6 ? "#5a5a5a" : Qt.rgba(fg.r, fg.g, fg.b, 0.72)
  readonly property string fontFamily: bar ? bar.fontFamily : "monospace"

  property int margin: Style.gapsOut
  property int cardPadding: Style.spacing.popupPadding

  // Adaptive width: size the panel to the auto-detected device name instead
  // of a fixed width. A long name grows the panel; an absurd one clamps at
  // maxPanelWidth and the name elides. The Reset button lives on its own row
  // below the header labels, so it can never overlap the name at any width.
  readonly property int minPanelWidth: 380
  readonly property int maxPanelWidth: 560
  readonly property int headerNeed: Math.ceil(Math.max(nameMetrics.width, pathMetrics.width))
    + headerGlyph.implicitWidth
    + 8 // glyph-to-labels gap
    + card.contentLeftInset + card.contentRightInset

  implicitWidth: Math.min(Math.max(root.minPanelWidth, root.headerNeed), root.maxPanelWidth)
  implicitHeight: 640

  TextMetrics {
    id: nameMetrics
    font.family: root.fontFamily
    font.pixelSize: 14
    font.bold: true
    text: root.modelName
  }

  TextMetrics {
    id: pathMetrics
    font.family: root.fontFamily
    font.pixelSize: 10
    text: root.deviceStatusText
  }

  visible: open || card.opacity > 0
  color: "transparent"

  function close() { root.open = false }

  // Assign the helper's capture node to the viewfinder camera and activate
  // it only while the hub runs. Three hard-won facts from testing:
  // (1) QCameraDevice.id is NOT a JS string in this Qt build — String(...) is
  //     required or === never matches, even against an identical-looking id.
  // (2) The device must be assigned BEFORE activating, or the camera starts
  //     on the default (real) camera device.
  // (3) QML rejects null for the QCameraDevice value type ("Unable to assign
  //     null to QCameraDevice"), so only assign on a real match.
  function syncViewfinderCamera() {
    var want = root.loopbackHelper ? root.loopbackHelper.node : ""
    var devs = mediaDevices.videoInputs
    var matched = false
    if (want && devs) {
      for (var i = 0; i < devs.length; i++) {
        if (String(devs[i].id) === want) {
          viewfinderCamera.cameraDevice = devs[i]
          matched = true
          break
        }
      }
    }
    viewfinderCamera.active = matched && root.viewfinderState === "running"
  }

  Component.onCompleted: root.syncViewfinderCamera()

  onOpenChanged: {
    if (!bar) return
    if (open) bar.requestPopout(coordinatorKey)
    else if (bar.activePopout === coordinatorKey) bar.releasePopout(coordinatorKey)
  }

  HyprlandFocusGrab {
    active: root.open
    windows: root.anchorWindow ? [root, root.anchorWindow] : [root]
    onCleared: root.close()
  }

  anchor {
    id: popupAnchor
    window: root.anchorWindow
    adjustment: PopupAdjustment.Slide
    edges: Edges.Top | Edges.Left
    gravity: Edges.Bottom | Edges.Right
    rect.width: 1
    rect.height: 1

    onAnchoring: {
      if (!root.anchorItem || !root.bar || !root.anchorWindow) return

      var target = root.anchorItem
      var win = root.anchorWindow
      var w = root.implicitWidth
      var h = root.implicitHeight
      var posX = 0
      var posY = 0

      if (root.bar.position === "bottom") {
        var localX = target.width / 2 - w / 2
        var point = win.contentItem.mapFromItem(target, localX, 0)
        posX = Math.max(root.margin, Math.min(point.x, win.width - w - root.margin))
        posY = -(h + root.margin)
      } else if (root.bar.position === "left") {
        var localY = target.height / 2 - h / 2
        var point = win.contentItem.mapFromItem(target, 0, localY)
        posX = win.width + root.margin
        posY = Math.max(root.margin, Math.min(point.y, win.height - h - root.margin))
      } else if (root.bar.position === "right") {
        var localY = target.height / 2 - h / 2
        var point = win.contentItem.mapFromItem(target, 0, localY)
        posX = -(w + root.margin)
        posY = Math.max(root.margin, Math.min(point.y, win.height - h - root.margin))
      } else {
        var localX = target.width / 2 - w / 2
        var point = win.contentItem.mapFromItem(target, localX, 0)
        posX = Math.max(root.margin, Math.min(point.x, win.width - w - root.margin))
        posY = win.height + root.margin
      }

      popupAnchor.rect.x = Math.round(posX)
      popupAnchor.rect.y = Math.round(posY)
    }
  }

  // =========================================================================
  // Inline control components
  // =========================================================================

  // Anchored label + value header. The label's right edge is tied to the
  // value's left edge and elides, so a long value or label can never push one
  // underneath the other (the old manual-width Row could overlap).
  component CameraControlHeader: Item {
    id: cch
    property string label: ""
    property string valueText: ""
    property bool controlEnabled: true

    width: parent.width
    height: Math.max(labelText.implicitHeight, valueText.implicitHeight)

    Text {
      id: labelText
      text: cch.label
      color: cch.controlEnabled ? root.fg : root.safeMuted
      font.family: root.fontFamily
      font.pixelSize: 12
      font.bold: true
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      anchors.right: valueText.left
      anchors.rightMargin: 8
      elide: Text.ElideRight
    }

    Text {
      id: valueText
      text: cch.valueText
      color: root.safeMuted
      font.family: root.fontFamily
      font.pixelSize: 11
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  component CameraSlider: Column {
    id: cs
    property alias slider: slider
    property string label: ""
    property string unit: ""
    property real minimum: 0
    property real maximum: 255
    property real step: 1
    property real value: 0
    property bool controlEnabled: true
    property string disabledHint: "Controlled automatically"
    signal committed(real val)

    property real liveVal: value
    onValueChanged: if (!slider.dragging) liveVal = value

    width: parent.width
    spacing: 3

    Timer {
      id: debounceTimer
      interval: 150
      repeat: false
      onTriggered: {
        root.isDragging = false
        cs.committed(cs.liveVal)
      }
    }

    CameraControlHeader {
      label: cs.label
      valueText: Math.round(cs.liveVal) + (cs.unit ? (" " + cs.unit) : "")
      controlEnabled: cs.controlEnabled
    }

    Item {
      width: parent.width
      height: slider.implicitHeight

      PanelSlider {
        id: slider
        anchors.fill: parent
        bar: root.bar
        enabled: cs.controlEnabled
        opacity: cs.controlEnabled ? 1.0 : 0.4
        minimum: cs.minimum
        maximum: cs.maximum
        step: cs.step
        integer: true
        value: cs.value

        onMoved: function(v) {
          cs.liveVal = Math.round(v)
          root.isDragging = true
          debounceTimer.restart()
        }
        onReleased: function(v) {
          debounceTimer.stop()
          root.isDragging = false
          cs.liveVal = Math.round(v)
          cs.committed(cs.liveVal)
        }
      }
    }

    // Long hints get their own wrapped line below the slider instead of
    // competing with the label for horizontal space.
    Text {
      width: parent.width
      visible: !cs.controlEnabled && cs.disabledHint !== ""
      wrapMode: Text.Wrap
      font.family: root.fontFamily
      font.pixelSize: 10
      color: root.safeMuted
      text: cs.disabledHint
    }
  }

  component CameraToggle: Item {
    id: ct
    property string label: ""
    property bool checked: false
    property bool controlEnabled: true
    signal toggled()

    width: parent.width
    height: Math.max(toggleText.implicitHeight, toggleSwitch.implicitHeight)

    Text {
      id: toggleText
      text: ct.label
      color: ct.controlEnabled ? root.fg : root.safeMuted
      font.family: root.fontFamily
      font.pixelSize: 12
      font.bold: true
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      anchors.right: toggleSwitch.left
      anchors.rightMargin: 8
      elide: Text.ElideRight
    }

    ToggleSwitch {
      id: toggleSwitch
      checked: ct.checked
      enabled: ct.controlEnabled
      opacity: ct.controlEnabled ? 1.0 : 0.4
      foreground: root.fg
      accent: root.accent
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      onToggled: ct.toggled()
    }
  }

  component CameraSegmented: Column {
    id: cseg
    property string label: ""
    property var options: []
    property string value: ""
    property bool controlEnabled: true
    signal changed(string val)

    width: parent.width
    spacing: 4

    Text {
      text: cseg.label
      color: cseg.controlEnabled ? root.fg : root.safeMuted
      font.family: root.fontFamily
      font.pixelSize: 12
      font.bold: true
    }

    ButtonGroup {
      options: cseg.options
      value: cseg.value
      foreground: root.fg
      background: root.bg
      accent: root.accent
      fontFamily: root.fontFamily
      fontSize: 11
      onChanged: function(v) { cseg.changed(v) }
    }
  }

  component CameraPanTilt: Column {
    id: cpt
    property string label: ""
    property int value: 0
    property int step: 3600
    property int minimum: -72000
    property int maximum: 72000
    signal stepRequested(int nextVal)

    function snap(v) { var s = Math.max(1, cpt.step); return Math.max(cpt.minimum, Math.min(cpt.maximum, cpt.minimum + Math.round((v - cpt.minimum) / s) * s)) }

    property int liveVal: value
    onValueChanged: if (!slider.dragging) liveVal = value

    width: parent.width
    spacing: 3

    Timer {
      id: debounceTimer
      interval: 150
      repeat: false
      onTriggered: cpt.stepRequested(cpt.liveVal)
    }

    CameraControlHeader {
      label: cpt.label
      valueText: cpt.liveVal > 0 ? ("+" + cpt.liveVal) : String(cpt.liveVal)
    }

    PanelSlider {
      id: slider
      width: parent.width
      bar: root.bar
      minimum: cpt.minimum
      maximum: cpt.maximum
      step: cpt.step
      integer: true
      value: cpt.value

      onMoved: function(v) {
        cpt.liveVal = snap(v)
        root.isDragging = true
        debounceTimer.restart()
      }
      onReleased: function(v) {
        debounceTimer.stop()
        root.isDragging = false
        cpt.liveVal = snap(v)
        cpt.stepRequested(cpt.liveVal)
      }
    }

    Row {
      spacing: 8

      Button {
        text: " − "
        bordered: true
        foreground: root.fg
        background: root.bg
        accent: root.accent
        fontFamily: root.fontFamily
        fontSize: 12
        enabled: cpt.value > cpt.minimum
        onClicked: cpt.stepRequested(Math.max(cpt.minimum, cpt.value - cpt.step))
      }

      Button {
        text: " + "
        bordered: true
        foreground: root.fg
        background: root.bg
        accent: root.accent
        fontFamily: root.fontFamily
        fontSize: 12
        enabled: cpt.value < cpt.maximum
        onClicked: cpt.stepRequested(Math.min(cpt.maximum, cpt.value + cpt.step))
      }

      Button {
        text: "Center"
        bordered: true
        foreground: root.fg
        background: root.bg
        accent: root.accent
        fontFamily: root.fontFamily
        fontSize: 11
        visible: cpt.value !== 0
        onClicked: cpt.stepRequested(0)
      }
    }
  }

  // =========================================================================
  // Card
  // =========================================================================

  BorderSurface {
    id: card
    anchors.fill: parent
    radius: Style.cornerRadius
    color: root.bg
    borderSpec: root.borderSpec
    padding: root.cardPadding
    opacity: root.open ? 1 : 0

    Behavior on opacity {
      NumberAnimation { duration: 130; easing.type: Easing.OutCubic }
    }

    Column {
      id: mainCol
      anchors.fill: parent
      anchors.topMargin: card.contentTopInset
      anchors.rightMargin: card.contentRightInset
      anchors.bottomMargin: card.contentBottomInset
      anchors.leftMargin: card.contentLeftInset
      spacing: 8

      // Header: glyph + device name/status. The Reset button gets its own
      // row below — the labels get the full width and elide, never clashing.
      Item {
        id: headerItem
        width: parent.width
        height: headerLabels.implicitHeight

        Row {
          id: headerLabels
          spacing: 8
          anchors.verticalCenter: parent.verticalCenter
          anchors.left: parent.left
          anchors.right: parent.right

          Text {
            id: headerGlyph
            text: "󰄀"
            color: root.devicePresent ? root.accent : root.safeMuted
            font.family: root.fontFamily
            font.pixelSize: 18
            anchors.verticalCenter: parent.verticalCenter
          }

          // Explicit width so both lines can elide when the name exceeds
          // maxPanelWidth — never overlaps the Reset button.
          Column {
            spacing: 1
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - headerGlyph.width - 8

            Text {
              width: parent.width
              elide: Text.ElideRight
              text: root.modelName
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: 14
              font.bold: true
            }

            Text {
              width: parent.width
              elide: Text.ElideRight
              text: root.deviceStatusText
              color: root.devicePresent ? root.safeMuted : root.urgent
              font.family: root.fontFamily
              font.pixelSize: 10
            }
          }
        }
      }

      Item {
        width: parent.width
        height: root.devicePresent ? resetBtn.implicitHeight : 0

        Button {
          id: resetBtn
          anchors.right: parent.right
          text: "Reset defaults"
          bordered: true
          visible: root.devicePresent
          foreground: root.fg
          background: root.bg
          accent: root.accent
          fontFamily: root.fontFamily
          fontSize: 11
          onClicked: root.resetRequested()
        }
      }

      PanelSeparator {
        id: headerSep
        foreground: root.fg
      }

      CameraSegmented {
        id: cameraSelector
        visible: root.cameras && root.cameras.length > 1
        label: "Camera"
        options: Model.cameraSelectorOptions(root.cameras)
        value: root.devicePath
        onChanged: function(v) {
          if (v && v !== root.devicePath) root.deviceChangeRequested(v)
        }
      }

      // Live viewfinder capture: opens the helper output's capture node while
      // the hub runs. The QML analog of a browser's video element + MediaStream:
      // in-process decode, frames render on arrival, drop if late, never queue.
      // Reading the helper keeps consumer readers on the main device
      // uncontended. Device id on Linux (FFmpeg backend) is the node path.
      MediaDevices {
        id: mediaDevices
        onVideoInputsChanged: root.syncViewfinderCamera()
      }

      CaptureSession {
        id: viewfinderSession
        camera: Camera { id: viewfinderCamera }
        videoOutput: viewfinder
      }

      // Microphone enumeration (one-shot pactl run per refresh)
      Process {
        id: micListProc
        command: []
        stdout: StdioCollector {
          id: micListOut
          waitForEnd: true
          onStreamFinished: root.micSources = Model.parseMicSources(micListOut.text)
        }
      }

      // Viewfinder frame: live video from the virtual camera while it runs
      Item {
        id: previewFrame
        width: parent.width
        height: Math.round(width * 9 / 16)

        Rectangle {
          anchors.fill: parent
          radius: Style.cornerRadius
          color: root.bar ? root.bar.background : "#101315"
          clip: true

          VideoOutput {
            id: viewfinder
            anchors.fill: parent
            fillMode: VideoOutput.PreserveAspectCrop
            visible: root.viewfinderState === "running"
            mirrored: root.mirrorPreview
          }

          // REC badge
          Row {
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.margins: 8
            spacing: 6
            visible: root.recording

            Rectangle {
              width: 8
              height: 8
              radius: 4
              color: "#ff4d4d"
              anchors.verticalCenter: parent.verticalCenter
            }

            Text {
              text: "REC " + root.recTimeText()
              color: "#ff4d4d"
              font.family: root.fontFamily
              font.pixelSize: 11
              font.bold: true
              anchors.verticalCenter: parent.verticalCenter
            }
          }

          // Center message when the virtual camera isn't running
          Column {
            anchors.centerIn: parent
            spacing: 6
            width: parent.width - 24
            visible: root.viewfinderState !== "running"

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "󰄀"
              color: (root.viewfinderState === "permission" || root.viewfinderState === "error") ? root.urgent : root.safeMuted
              font.family: root.fontFamily
              font.pixelSize: 28
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: {
                if (root.viewfinderState === "disconnected") return "Camera Disconnected"
                if (root.viewfinderState === "permission") return "Permission Denied"
                if (root.viewfinderState === "starting") return "Starting virtual camera"
                if (root.viewfinderState === "error") return "Virtual camera failed"
                return "Virtual camera off"
              }
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: 12
              font.bold: true
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              anchors.horizontalCenter: parent.horizontalCenter
              text: {
                if (root.viewfinderState === "disconnected") return "No capture device found"
                if (root.viewfinderState === "permission") return "Check device permissions"
                if (root.viewfinderState === "starting") return "Opening the camera"
                if (root.viewfinderState === "error") return "Camera busy, unplugged, or loopback gone"
                if (!root.loopbackLoaded) return "Load the v4l2loopback driver below, then start"
                return "Start it to preview and capture"
              }
              color: root.safeMuted
              font.family: root.fontFamily
              font.pixelSize: 10
              wrapMode: Text.Wrap
              horizontalAlignment: Text.AlignHCenter
              width: parent.width
            }

            Button {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "Retry"
              bordered: true
              foreground: root.fg
              background: root.bg
              accent: root.accent
              fontFamily: root.fontFamily
              fontSize: 11
              visible: root.viewfinderState === "disconnected"
              onClicked: root.refreshRequested()
            }

            Button {
              anchors.horizontalCenter: parent.horizontalCenter
              text: "Start virtual camera"
              bordered: true
              foreground: root.fg
              background: root.bg
              accent: root.accent
              fontFamily: root.fontFamily
              fontSize: 11
              visible: root.viewfinderState === "off"
              enabled: root.loopbackLoaded && !root.permissionDenied
              onClicked: root.virtualCamToggleRequested()
            }
          }

          // Capture actions
          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 8
            spacing: 8
            visible: root.devicePresent && !root.permissionDenied

            Button {
              text: root.photoBusy ? "Saving…" : "Photo"
              enabled: !root.photoBusy && root.hubState !== "starting"
              bordered: true
              foreground: root.fg
              background: root.bg
              accent: root.accent
              fontFamily: root.fontFamily
              fontSize: 11
              onClicked: root.takePhotoRequested()
            }

            Button {
              text: root.recording ? ("Stop (" + root.recTimeText() + ")") : "Record"
              enabled: root.hubState !== "starting"
              bordered: true
              foreground: root.fg
              background: root.bg
              accent: root.accent
              fontFamily: root.fontFamily
              fontSize: 11
              onClicked: root.recordToggleRequested()
            }

            Button {
              text: root.hubOn ? "Off" : "Start Virtual Camera"
              enabled: root.hubState !== "starting" && (root.hubOn || root.loopbackLoaded)
              bordered: true
              foreground: root.fg
              background: root.bg
              accent: root.hubOn ? root.urgent : root.accent
              fontFamily: root.fontFamily
              fontSize: 11
              onClicked: root.virtualCamToggleRequested()
            }
          }
        }
      }

      Text {
        id: statusText
        width: parent.width
        visible: text !== ""
        wrapMode: Text.Wrap
        font.family: root.fontFamily
        font.pixelSize: 10
        color: (root.captureBusy || root.lastCaptureMessage.indexOf("fail") !== -1) ? root.urgent : root.safeMuted
        text: root.captureBusy
          ? "Camera is in use — close the app using it and try again."
          : root.lastCaptureMessage
      }

      CameraToggle {
        id: mirrorToggle
        label: "Mirror preview"
        checked: root.mirrorPreview
        visible: root.devicePath !== ""
        onToggled: root.mirrorChangeRequested(!root.mirrorPreview)
      }

      // Settings flickable
      Flickable {
        id: flick
        objectName: "popupFlick"
        visible: root.devicePresent
        width: parent.width
        height: Math.max(80, mainCol.height
          - headerItem.height
          - headerSep.height
          - previewFrame.height
          - (cameraSelector.visible ? cameraSelector.implicitHeight : 0)
          - (statusText.visible ? statusText.height : 0)
          - (mirrorToggle.visible ? mirrorToggle.height : 0)
          - mainCol.spacing * (3 + (cameraSelector.visible ? 1 : 0) + (statusText.visible ? 1 : 0) + (mirrorToggle.visible ? 1 : 0)))
        contentWidth: width
        contentHeight: sectionsCol.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ScrollBar.vertical: ScrollBar {
          id: vbar
          policy: ScrollBar.AsNeeded
          width: 8
          contentItem: Rectangle {
            implicitWidth: 6
            implicitHeight: 32
            radius: Style.cornerRadius
            color: vbar.pressed ? root.fg : (vbar.hovered ? root.fg : root.safeMuted)
            opacity: vbar.active || vbar.hovered ? 0.85 : 0.4
            Behavior on opacity {
              NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
            }
          }
        }

        Column {
          id: sectionsCol
          width: flick.width - 12
          spacing: 10

          // Capture: photo/record formats, raw feed, microphone
          Column {
            width: parent.width
            spacing: 10

            PanelSectionHeader {
              text: "CAPTURE"
              foreground: root.fg
              fontFamily: root.fontFamily
            }

            CameraSegmented {
              label: "Photo format"
              options: ["JPEG", "PNG"]
              value: root.photoFormat === "png" ? "PNG" : "JPEG"
              onChanged: function(v) { root.photoFormat = (v === "PNG") ? "png" : "jpg" }
            }

            CameraToggle {
              label: "Raw camera feed (ignore mirror)"
              checked: root.rawPhoto
              onToggled: root.rawPhoto = !root.rawPhoto
            }

            CameraSegmented {
              label: "Recording format"
              options: ["MP4", "MKV"]
              value: root.recFormat === "mkv" ? "MKV" : "MP4"
              onChanged: function(v) { root.recFormat = (v === "MKV") ? "mkv" : "mp4" }
            }

            CameraToggle {
              label: "Microphone in recordings"
              checked: root.micOn
              onToggled: root.micOn = !root.micOn
            }

            Column {
              width: parent.width
              spacing: 6
              visible: root.micOn

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                text: "Microphone"
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: 12
                font.bold: true
              }

              ButtonGroup {
                options: root.micPickerOptions
                value: root.micSource
                foreground: root.fg
                background: root.bg
                accent: root.accent
                fontFamily: root.fontFamily
                fontSize: 11
                onChanged: function(v) { root.micSource = v }
              }
            }
          }

          // Virtual camera hub
          Column {
            width: parent.width
            spacing: 10

            PanelSectionHeader {
              text: "VIRTUAL CAMERA"
              foreground: root.fg
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              wrapMode: Text.Wrap
              text: root.hubStatusText
              color: root.hubState === "running" ? root.fg : (root.hubState === "error" ? root.urgent : root.safeMuted)
              font.family: root.fontFamily
              font.pixelSize: 10
            }

            Column {
              width: parent.width
              spacing: 6
              visible: !root.loopbackLoaded

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                color: root.safeMuted
                font.family: root.fontFamily
                font.pixelSize: 10
                text: root.loopbackInstalled
                  ? 'Load the virtual camera driver (once per boot):\n\nsudo modprobe v4l2loopback video_nr=8,9 card_label="Virtual Camera","Capture Helper" exclusive_caps=1'
                  : 'Install the v4l2loopback kernel module (e.g. v4l2loopback-dkms), then load it:\n\nsudo modprobe v4l2loopback video_nr=8,9 card_label="Virtual Camera","Capture Helper" exclusive_caps=1'
              }

              Text {
                width: parent.width
                wrapMode: Text.Wrap
                color: root.safeMuted
                font.family: root.fontFamily
                font.pixelSize: 10
                text: 'To keep it across reboots: add "v4l2loopback" to /etc/modules-load.d/ and the options line to /etc/modprobe.d/.'
              }

              Button {
                text: "Re-check"
                bordered: true
                foreground: root.fg
                background: root.bg
                accent: root.accent
                fontFamily: root.fontFamily
                fontSize: 11
                onClicked: root.recheckRequested()
              }
            }

            PanelSeparator {
              foreground: root.fg
            }
          }

          // Capture mode
          Column {
            width: parent.width
            spacing: 10
            visible: root.captureFormats && root.captureFormats.length > 0

            PanelSectionHeader {
              text: "CAPTURE"
              foreground: root.fg
              fontFamily: root.fontFamily
            }

            CameraSegmented {
              label: "Resolution"
              options: Model.resolutionOptions(root.captureFormats, root.captureMode)
              value: (root.captureMode && root.captureMode.width !== undefined && root.captureMode.height !== undefined)
                ? (root.captureMode.width + "x" + root.captureMode.height)
                : ""
              onChanged: function(val) {
                var parts = val.split("x")
                if (parts.length !== 2) return
                var w = parseInt(parts[0], 10)
                var h = parseInt(parts[1], 10)
                var curFps = (root.captureMode && root.captureMode.fps !== undefined) ? root.captureMode.fps : 30
                var picked = Model.pickCaptureMode(root.captureFormats, root.captureMode, w, h, curFps)
                if (picked) {
                  root.captureModeRequested(picked.width, picked.height, picked.fps)
                }
              }
            }

            CameraSegmented {
              label: "Frame rate (fps)"
              options: (root.captureMode && root.captureMode.width !== undefined)
                ? Model.fpsOptions(root.captureFormats, root.captureMode.width, root.captureMode.height, root.captureMode.pixelformat, root.captureMode.fps)
                : []
              value: (root.captureMode && root.captureMode.fps !== undefined) ? String(root.captureMode.fps) : ""
              onChanged: function(val) {
                if (!root.captureMode || root.captureMode.width === undefined) return
                var picked = Model.pickCaptureMode(root.captureFormats, root.captureMode, root.captureMode.width, root.captureMode.height, parseFloat(val))
                if (picked) {
                  root.captureModeRequested(picked.width, picked.height, picked.fps)
                }
              }
            }

            Text {
              width: parent.width
              wrapMode: Text.Wrap
              font.family: root.fontFamily
              font.pixelSize: 10
              color: root.captureBusy ? root.urgent : root.safeMuted
              text: root.captureBusy
                ? "Camera is in use — close the app using it and try again."
                : "Default mode for apps that don't choose their own. Changing it restarts the virtual camera."
            }

            PanelSeparator {
              foreground: root.fg
            }
          }

          // Hardware-driven settings sections
          Repeater {
            model: root.settingsSections

            Column {
              width: parent.width
              spacing: 10

              PanelSectionHeader {
                text: modelData.title
                foreground: root.fg
                fontFamily: root.fontFamily
              }

              Repeater {
                model: modelData.items

                Column {
                  width: parent.width

                  CameraToggle {
                    visible: modelData.kind === "toggle"
                    label: modelData.label
                    checked: modelData.value === 1
                    controlEnabled: modelData.enabled
                    onToggled: root.controlChanged(modelData.name, modelData.value === 1 ? 0 : 1)
                  }

                  CameraSlider {
                    visible: modelData.kind === "slider"
                    label: modelData.label
                    unit: modelData.unit
                    minimum: modelData.min !== undefined ? modelData.min : 0
                    maximum: modelData.max !== undefined ? modelData.max : 255
                    step: modelData.step !== undefined ? modelData.step : 1
                    value: modelData.value !== undefined ? modelData.value : 0
                    controlEnabled: modelData.enabled
                    disabledHint: modelData.hint
                    onCommitted: function(v) { root.controlChanged(modelData.name, v) }
                  }

                  CameraSegmented {
                    visible: modelData.kind === "segmented"
                    label: modelData.label
                    options: modelData.options
                    value: modelData.value !== undefined ? String(modelData.value) : ""
                    controlEnabled: modelData.enabled
                    onChanged: function(v) { root.controlChanged(modelData.name, parseInt(v, 10)) }
                  }

                  CameraPanTilt {
                    visible: modelData.kind === "pantilt"
                    label: modelData.label
                    value: modelData.value !== undefined ? modelData.value : 0
                    minimum: modelData.min !== undefined ? modelData.min : -72000
                    maximum: modelData.max !== undefined ? modelData.max : 72000
                    step: modelData.step !== undefined ? modelData.step : 3600
                    onStepRequested: function(v) { root.controlChanged(modelData.name, v) }
                  }
                }
              }

              PanelSeparator {
                foreground: root.fg
              }
            }
          }

          Item {
            width: parent.width
            height: 8
          }
        }

        MouseArea {
          id: wheelInterceptor
          objectName: "wheelInterceptor"
          anchors.fill: sectionsCol
          z: 10
          acceptedButtons: Qt.NoButton
          hoverEnabled: false

          onWheel: function(wheel) {
            wheel.accepted = true
            // Qt Wayland touchpads deliver pixelDelta with angleDelta = 12x
            var step = wheel.pixelDelta.y !== 0 ? wheel.pixelDelta.y : (wheel.angleDelta.y / 120) * 48
            var maxY = Math.max(0, flick.contentHeight - flick.height)
            flick.contentY = Math.max(0, Math.min(maxY, flick.contentY - step))
          }
        }
      }
    }
  }
}
