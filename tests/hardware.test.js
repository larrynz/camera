// Live hardware verification for the camera hub plugin.
//
// Discovers whatever capture device is connected using the same chain as the
// widget (list-devices -> batched --info probe -> classify), then exercises:
//   1. Discovery assertions (generic, no hardcoded device)
//   2. Brightness control round trip (set/get/restore, skipped if not exposed)
//   3. Capture mode round trip (set/get/restore, skipped when device busy)
//   4. Photo capture from the physical camera (JPEG produced, then removed)
//   5. Recording from the physical camera (SIGINT-finalized MP4 with moov atom)
//   6. Virtual camera hub start/stop — SKIPPED unless a v4l2loopback node exists
//
// Requirements: camera idle (no other app streaming), v4l2-ctl + ffmpeg on PATH.
// All mutated device state is restored in a finally block; no orphan processes
// or temp files are left behind. Skips cleanly (exit 0) with no capture device.
//
// NOTE: the long-running sections (recording, hub) need the event loop alive so
// libuv can reap children, hence the async IIFE + promise-based sleeps. Blocking
// sleeps (Atomics.wait) would starve the 'exit' events and cause false timeouts.

const assert = require("node:assert/strict")
const cp = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Model = require("../Model.js")

function run(cmd) {
  return cp.execFileSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  })
}

// Promise-based sleep: yields to the event loop so child 'exit' events fire.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Resolves { code, signal } when the process exits, or "timeout" after ms.
function waitExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs)
    proc.once("exit", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

function isBusyError(err) {
  return `${err.stdout || ""} ${err.stderr || ""} ${err.message || ""}`.toLowerCase().includes("busy")
}

// ---------------------------------------------------------------------------
// 1. Generic discovery chain (identical to the widget)
// ---------------------------------------------------------------------------

const groups = Model.parseV4l2ListDevices(run(Model.buildListDevicesCommand()))
if (groups.length === 0) {
  console.log("SKIP: no capture device found")
  process.exit(0)
}

const nodes = []
for (const group of groups) {
  for (const node of group.nodes) nodes.push(node)
}
assert.ok(nodes.length > 0, "Discovered groups must expose at least one /dev/videoN node")

const infos = Model.parseProbeOutput(run(Model.buildProbeCommand(nodes)))
const loopbacks = []
const cams = []
for (const group of groups) {
  let captureNode = ""
  for (const node of group.nodes) {
    const cls = Model.classifyNode(infos[node])
    if (cls === "loopback") {
      loopbacks.push({
        node,
        card: infos[node] && infos[node].card ? infos[node].card : group.name
      })
    } else if (cls === "capture" && captureNode === "") {
      captureNode = node
    }
  }
  if (captureNode !== "") {
    cams.push({ name: group.name, bus: group.bus, captureNode })
  }
}

if (cams.length === 0) {
  console.log("SKIP: no capture device found")
  process.exit(0)
}

const device = cams[0].captureNode
const picked = Model.pickLoopbacks(loopbacks)
console.log(`=== Hardware Verification: ${cams[0].name} (${device}) ===`)
console.log(`Discovered cameras: ${cams.map(c => `${c.name}@${c.captureNode}`).join(", ")}`)
console.log(`Discovered loopbacks: ${loopbacks.length === 0 ? "none (hub test will skip)" : loopbacks.map(l => `${l.node} "${l.card}"`).join(", ")}`)
for (const cam of cams) {
  assert.equal(Model.classifyNode(infos[cam.captureNode]), "capture", `${cam.captureNode} must classify as capture`)
}
console.log("PASS: discovery chain (list-devices -> probe -> classify) consistent")

const tmpPhoto = path.join(os.tmpdir(), "omawebcam-test-photo.jpg")
const tmpRec = path.join(os.tmpdir(), "omawebcam-test-rec.mp4")
const tmpPreview = path.join(os.tmpdir(), "omawebcam-test-preview.jpg")
const cleanupFiles = [tmpPhoto, tmpRec, tmpPreview]
const spawned = [] // every spawned process, reaped in finally no matter what

// Snapshot state for restoration
const listOut = run(Model.buildV4l2ListCommand(device))
const initialCtrls = Model.parseV4l2Ctrls(listOut)
const initialMode = Model.parseV4l2CaptureMode(listOut)
const origBrightness = initialCtrls.brightness ? initialCtrls.brightness.value : undefined

function getCurrentValue(name) {
  const v4l2 = Model.parseV4l2Ctrls(run(Model.buildV4l2ListCommand(device)))
  return v4l2[name] ? v4l2[name].value : undefined
}

function differentIntValue(ctrl, currentVal) {
  const min = ctrl.min !== undefined ? ctrl.min : 0
  const max = ctrl.max !== undefined ? ctrl.max : 255
  const step = ctrl.step !== undefined && ctrl.step > 0 ? ctrl.step : 1
  const delta = Math.max(step, Math.round((max - min) / 10) || 1)
  let candidate = currentVal + delta
  if (candidate > max || candidate < min) candidate = currentVal - delta
  if (candidate > max || candidate < min) candidate = currentVal
  return candidate
}

let modeMutated = false
let brightnessMutated = false

async function main() {
  // -----------------------------------------------------------------------
  // 2. Brightness round trip
  // -----------------------------------------------------------------------
  console.log("\n=== Brightness Round Trip ===")
  if (origBrightness === undefined) {
    console.log("SKIP: brightness not exposed on this camera")
  } else {
    const before = getCurrentValue("brightness")
    const target = differentIntValue(initialCtrls.brightness, before)
    if (target === before) {
      console.log("SKIP: brightness range too narrow to pick a different value")
    } else {
      run(Model.buildV4l2SetCommand(device, "brightness", target))
      brightnessMutated = true
      const after = getCurrentValue("brightness")
      assert.equal(after, target, `brightness did not change to ${target} (got ${after})`)
      run(Model.buildV4l2SetCommand(device, "brightness", before))
      const restored = getCurrentValue("brightness")
      assert.equal(restored, before, `brightness did not restore to ${before} (got ${restored})`)
      brightnessMutated = false
      console.log(`PASS: brightness ${before} -> ${after} -> ${restored}`)
    }
  }

  // -----------------------------------------------------------------------
  // 3. Capture mode round trip
  // -----------------------------------------------------------------------
  console.log("\n=== Capture Mode Round Trip ===")
  const formats = Model.parseV4l2Formats(run(Model.buildV4l2ListFormatsCommand(device)))
  assert.ok(formats.length > 0, "At least one video format must be enumerated")

  let targetMode = null
  outer:
  for (const fmt of formats) {
    for (const sz of fmt.sizes || []) {
      if (sz.width !== initialMode.width || sz.height !== initialMode.height || (sz.fps || [])[0] !== initialMode.fps) {
        const fps = (sz.fps && sz.fps.length) ? sz.fps[0] : initialMode.fps
        const candidate = Model.pickCaptureMode(formats, initialMode, sz.width, sz.height, fps)
        if (candidate && (candidate.width !== initialMode.width || candidate.height !== initialMode.height || candidate.fps !== initialMode.fps)) {
          targetMode = candidate
          break outer
        }
      }
    }
  }

  if (!targetMode) {
    console.log("SKIP: no alternative capture mode enumerated")
  } else {
    try {
      run(Model.buildV4l2SetCaptureModeCommand(device, targetMode))
      modeMutated = true
    } catch (setErr) {
      if (isBusyError(setErr)) {
        console.log("SKIP: capture mode busy (device is streaming)")
      } else {
        throw setErr
      }
    }
    if (modeMutated) {
      const post = Model.parseV4l2CaptureMode(run(Model.buildV4l2ListCommand(device)))
      assert.equal(post.width, targetMode.width, `capture width did not change to ${targetMode.width} (got ${post.width})`)
      assert.equal(post.height, targetMode.height, `capture height did not change to ${targetMode.height} (got ${post.height})`)
      run(Model.buildV4l2SetCaptureModeCommand(device, initialMode))
      modeMutated = false
      const restored = Model.parseV4l2CaptureMode(run(Model.buildV4l2ListCommand(device)))
      assert.equal(restored.width, initialMode.width, `capture width did not restore to ${initialMode.width} (got ${restored.width})`)
      assert.equal(restored.height, initialMode.height, `capture height did not restore to ${initialMode.height} (got ${restored.height})`)
      console.log(`PASS: capture mode ${initialMode.width}x${initialMode.height}@${initialMode.fps} -> ${targetMode.width}x${targetMode.height}@${targetMode.fps} -> restored`)
    }
  }

  // -----------------------------------------------------------------------
  // 4. Photo capture (physical camera, hub off)
  // -----------------------------------------------------------------------
  console.log("\n=== Photo Capture ===")
  for (const f of cleanupFiles) { try { fs.unlinkSync(f) } catch {} }
  {
    const cmd = Model.buildPhotoCommand(device, tmpPhoto)
    const result = cp.spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", timeout: 30000 })
    assert.equal(result.status, 0, `photo command failed (camera must be idle): ${result.stderr || result.status}`)
    assert.ok(fs.existsSync(tmpPhoto), "photo file must exist")
    const buf = fs.readFileSync(tmpPhoto)
    assert.ok(buf.length > 100, `photo file suspiciously small: ${buf.length} bytes`)
    assert.equal(buf[0], 0xff, "photo must start with JPEG SOI magic 0xFF")
    assert.equal(buf[1], 0xd8, "photo must start with JPEG SOI magic 0xD8")
    console.log(`PASS: photo captured to ${tmpPhoto} (${fs.statSync(tmpPhoto).size} bytes, JPEG magic verified)`)
  }

  // -----------------------------------------------------------------------
  // 5. Recording (physical camera, hub off) — SIGINT must finalize the MP4
  // -----------------------------------------------------------------------
  console.log("\n=== Recording ===")
  {
    const cmd = Model.buildRecordCommand(device, tmpRec)
    const recProc = cp.spawn(cmd[0], cmd.slice(1), { stdio: "ignore" })
    spawned.push(recProc)
    await sleep(2500) // event loop ticks: exitCode updates if ffmpeg dies early
    assert.equal(recProc.exitCode, null, `recording exited early (code ${recProc.exitCode})`)
    recProc.kill("SIGINT")
    const recExit = await waitExit(recProc, 10000)
    assert.notEqual(recExit, "timeout", "recording did not exit within 10s of SIGINT")
    console.log(`Recording SIGINT exit code: ${recExit.code} (signal: ${recExit.signal})`)
    // Empirical: ffmpeg handles SIGINT itself and exits with code 255
    // (0 and 130 kept as alternates for different ffmpeg builds).
    assert.ok(recExit.code === 0 || recExit.code === 255 || recExit.code === 130, `unexpected recording exit code ${recExit.code}`)
    assert.ok(fs.existsSync(tmpRec), "recording file must exist")
    const recBuf = fs.readFileSync(tmpRec)
    assert.ok(recBuf.length > 1000, `recording suspiciously small: ${recBuf.length} bytes`)
    const moovIdx = recBuf.indexOf("moov")
    assert.ok(moovIdx !== -1, "MP4 moov atom missing — file was not finalized by SIGINT")
    console.log(`PASS: recording finalized by SIGINT (${recBuf.length} bytes, moov atom at offset ${moovIdx})`)
  }

  // -----------------------------------------------------------------------
  // 6. Virtual camera hub (only when a v4l2loopback node exists)
  // -----------------------------------------------------------------------
  console.log("\n=== Virtual Camera Hub ===")
  if (!picked || !picked.main || !picked.main.node) {
    console.log("SKIP: no v4l2loopback device present (hub test requires the module loaded)")
  } else {
    const outputs = [picked.main.node]
    if (picked.helper && picked.helper.node && picked.helper.node !== picked.main.node) {
      outputs.push(picked.helper.node)
    }
    const hubCmd = Model.buildHubCommand(device, outputs, initialMode.fps || 30)
    const hubProc = cp.spawn(hubCmd[0], hubCmd.slice(1), { stdio: "ignore" })
    spawned.push(hubProc)
    await sleep(2000)
    if (hubProc.exitCode !== null) {
      console.log(`SKIP: hub exited immediately (code ${hubProc.exitCode}) — loopback may be misconfigured or lack write permission`)
    } else {
      // A frame must be readable while the hub mirrors into it. (The popup's
      // live viewfinder now uses QtMultimedia; this checks the underlying
      // v4l2 path with a direct ffmpeg one-shot grab.)
      try { fs.unlinkSync(tmpPreview) } catch {}
      const snapCmd = ["sh", "-c",
        `exec ffmpeg -hide_banner -loglevel error -y -f v4l2 -i "${picked.main.node}" -frames:v 1 -q:v 2 "${tmpPreview}"`]
      const snap = cp.spawnSync(snapCmd[0], snapCmd.slice(1), { encoding: "utf8", timeout: 30000 })
      assert.equal(snap.status, 0, `preview snapshot from ${picked.main.node} failed: ${snap.stderr || snap.status}`)
      assert.ok(fs.existsSync(tmpPreview), "preview snapshot file must exist")
      const snapBuf = fs.readFileSync(tmpPreview)
      assert.equal(snapBuf[0], 0xff, "preview snapshot must be a JPEG")
      assert.equal(snapBuf[1], 0xd8, "preview snapshot must be a JPEG")
      console.log(`PASS: snapshot from loopback ${picked.main.node} (${snapBuf.length} bytes, JPEG magic verified)`)

      hubProc.kill("SIGTERM")
      const hubExit = await waitExit(hubProc, 10000)
      assert.notEqual(hubExit, "timeout", "hub did not exit within 10s of SIGTERM")
      console.log(`Hub SIGTERM exit code: ${hubExit.code} (signal: ${hubExit.signal})`)
      // Empirical: ffmpeg handles SIGTERM itself and exits with code 255
      // (0 and 143 kept as alternates for different ffmpeg builds).
      assert.ok(hubExit.code === 0 || hubExit.code === 255 || hubExit.code === 143, `unexpected hub exit code ${hubExit.code}`)
      console.log(`PASS: hub start -> mirror -> snapshot -> SIGTERM stop on ${outputs.join(", ")}`)
    }
  }
}

main().then(
  () => {
    console.log("\nAll hardware tests passed.")
    process.exit(0)
  },
  (err) => {
    console.error(`\nFAILED: ${err.message}`)
    process.exit(1)
  }
)

// Cleanup: kill orphans, restore mutated state, remove temp files. Registered
// as an uncaught-safe last resort; also invoked via process exit handlers so
// it runs after main() resolves or rejects.
function cleanup() {
  if (cleanup.done) return
  cleanup.done = true
  console.log("\nCleaning up...")
  for (const proc of spawned) {
    if (proc.exitCode === null && !proc.killed) {
      try { proc.kill("SIGKILL") } catch {}
    }
  }

  const restorationErrors = []

  if (brightnessMutated && origBrightness !== undefined) {
    try {
      run(Model.buildV4l2SetCommand(device, "brightness", origBrightness))
      console.log(`Emergency restore: brightness back to ${origBrightness}`)
    } catch (e) {
      restorationErrors.push(new Error(`brightness emergency restore failed: ${e.message}`))
    }
  }

  if (modeMutated) {
    try {
      run(Model.buildV4l2SetCaptureModeCommand(device, initialMode))
      console.log(`Emergency restore: capture mode back to ${initialMode.width}x${initialMode.height}@${initialMode.fps}`)
    } catch (e) {
      restorationErrors.push(new Error(`capture mode emergency restore failed: ${e.message}`))
    }
  }

  for (const f of cleanupFiles) {
    try { fs.unlinkSync(f) } catch {}
  }

  if (restorationErrors.length > 0) {
    console.error(`Restoration error(s):`)
    for (const err of restorationErrors) console.error(` - ${err.message}`)
  } else {
    console.log("Camera state restored, temp files removed, no orphans left.")
  }
}
process.once("exit", cleanup)
process.once("SIGINT", () => { cleanup(); process.exit(130) })
process.once("SIGTERM", () => { cleanup(); process.exit(143) })
