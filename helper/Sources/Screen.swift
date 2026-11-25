// Screen.swift: drawing PushDesk for LUNA's screen, and sending it to an Ableton Push 2.
// Shared by push2screen (reads state files) and pushdesk-luna-helper (the all-in-one app).
//
// Only macOS's own frameworks: CoreGraphics/CoreText to draw, IOUSBHost to reach the Push,
// so nothing needs installing beyond this binary. It reads the same two files the companion
// writes (pushdesk_luna_screen.py), so it is a drop-in for the screen part.
//
//   push2screen --state S --meters M [--exit-with PID]   draw on the Push until PID is gone
//   push2screen --state S --meters M --render-only out.png  draw once to a PNG; no USB
//
// The Push 2 display format is Ableton's published one: a 16-byte header (ff cc aa 88, then
// zeros), then 160 lines of 1024 pixels (960 shown), 2 bytes each, BGR565 little-endian (red
// in the low bits), XOR-masked with e7 f3 e7 ff, sent to bulk OUT endpoint 0x01 of interface 0
// in 16 KB pieces. Without a new frame for about two seconds the screen blanks, so an
// unchanged screen is sent again every second.

import CoreGraphics
import CoreText
import Foundation
import ImageIO
import IOKit
import IOUSBHost
import UniformTypeIdentifiers

let W = 960, H = 160, LINE_PX = 1024
let VENDOR = 0x2982, PRODUCT = 0x1967

func log(_ s: String) { print(s); fflush(stdout) }

// MARK: - colours and fonts

func rgb(_ r: Int, _ g: Int, _ b: Int, _ a: CGFloat = 1) -> CGColor {
  CGColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: a)
}
let BG = rgb(0, 0, 0), RULE = rgb(40, 40, 40), DIM = rgb(110, 110, 110), FAINT = rgb(55, 55, 55)
let TEXT = rgb(210, 210, 210), ACCENT = rgb(247, 196, 73), GREEN = rgb(70, 190, 110)
let SEL_BG = rgb(38, 32, 12), BTN_BG = rgb(14, 14, 14), BTN_ON = rgb(247, 196, 73)
let METER_BG = rgb(24, 24, 24), TOUCH = rgb(90, 200, 255), PIN = rgb(59, 142, 234)

func font(_ size: CGFloat, bold: Bool = false) -> CTFont {
  let f = CTFontCreateUIFontForLanguage(bold ? .emphasizedSystem : .system, size, nil)
  return f ?? CTFontCreateWithName("Helvetica" as CFString, size, nil)
}
let F_BTN = font(10), F_HDR = font(13, bold: true), F_NAME = font(13, bold: true)
let F_VAL = font(21), F_SMALL = font(10)

// MARK: - state

typealias J = [String: Any]
func load(_ path: String) -> J {
  guard let d = FileManager.default.contents(atPath: path),
        let j = try? JSONSerialization.jsonObject(with: d) as? J else { return [:] }
  return j
}
func str(_ v: Any?) -> String { (v as? String) ?? (v.map { "\($0)" } ?? "") }
func num(_ v: Any?, _ d: Double = 0) -> Double { (v as? NSNumber)?.doubleValue ?? d }
func bool(_ v: Any?) -> Bool { (v as? Bool) ?? ((v as? NSNumber)?.intValue == 1) }
func hexColour(_ s: String) -> CGColor? {
  guard s.count == 7, s.hasPrefix("#"), let v = Int(s.dropFirst(), radix: 16) else { return nil }
  return rgb((v >> 16) & 255, (v >> 8) & 255, v & 255)
}

// MARK: - drawing (top-left origin)

final class Canvas {
  let ctx: CGContext
  init() {
    ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.translateBy(x: 0, y: CGFloat(H))
    ctx.scaleBy(x: 1, y: -1)
    ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  }
  func fill(_ r: CGRect, _ c: CGColor) { ctx.setFillColor(c); ctx.fill(r) }
  func line(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat, _ c: CGColor) {
    ctx.setStrokeColor(c); ctx.setLineWidth(1)
    ctx.move(to: CGPoint(x: x0, y: y0)); ctx.addLine(to: CGPoint(x: x1, y: y1)); ctx.strokePath()
  }
  /// Text with its top-left at (x, y), cut to `maxW` with an ellipsis.
  @discardableResult
  func text(_ s: String, _ x: CGFloat, _ y: CGFloat, _ f: CTFont, _ c: CGColor, maxW: CGFloat = 10_000, alignRight: Bool = false) -> CGFloat {
    let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): f, .init(kCTForegroundColorAttributeName as String): c]
    var line = CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: attrs))
    let ell = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attrs))
    if CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) > maxW,
       let t = CTLineCreateTruncatedLine(line, Double(maxW), .end, ell) { line = t }
    let w = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    ctx.textPosition = CGPoint(x: alignRight ? x - w : x, y: y + CTFontGetAscent(f))
    CTLineDraw(line, ctx)
    return w
  }
  func image() -> CGImage { ctx.makeImage()! }
}

let BTN_H: CGFloat = 13, HDR_Y: CGFloat = 13, HDR_H: CGFloat = 20
let STRIP_TOP: CGFloat = 33, STRIP_BOTTOM: CGFloat = CGFloat(H) - 13
let COL = CGFloat(W) / 8

/// dB to 0..1 of a meter: this helper's own scale (not any other company's table).
func meterFrac(_ db: Double) -> CGFloat {
  let pts: [(Double, Double)] = [(-60, 0), (-40, 0.15), (-20, 0.45), (-10, 0.68), (-3, 0.88), (0, 1)]
  if db <= pts[0].0 { return 0 }
  for i in 1..<pts.count where db <= pts[i].0 {
    let (d0, f0) = pts[i - 1], (d1, f1) = pts[i]
    return CGFloat(f0 + (f1 - f0) * (db - d0) / (d1 - d0))
  }
  return 1
}

func buttonRow(_ c: Canvas, _ labels: [Any], _ states: [Any], y0: CGFloat) {
  c.fill(CGRect(x: 0, y: y0, width: CGFloat(W), height: BTN_H), BTN_BG)
  for i in 0..<8 {
    let label = i < labels.count ? str(labels[i]) : ""
    let st: Any = i < states.count ? states[i] : false
    let on = bool(st) && !((st as? NSNumber)?.intValue == -1)
    let none = (st as? NSNumber)?.intValue == -1
    let x0 = CGFloat(i) * COL
    if on { c.fill(CGRect(x: x0 + 1, y: y0, width: COL - 2, height: BTN_H), BTN_ON) }
    if label.isEmpty { continue }
    c.text(label, x0 + 6, y0 + 1, F_BTN, on ? rgb(20, 20, 20) : (none ? FAINT : DIM), maxW: COL - 12)
  }
}

func header(_ c: Canvas, _ state: J, left: String, mid: String, right: String, rightPad: CGFloat = 8) {
  c.fill(CGRect(x: 0, y: HDR_Y, width: CGFloat(W), height: HDR_H), rgb(10, 10, 10))
  let lw = c.text(left, 8, HDR_Y + 3, F_HDR, rgb(130, 160, 190))
  var chipsX = CGFloat(W) - rightPad
  let rw = c.text(right, chipsX, HDR_Y + 4, F_SMALL, DIM, alignRight: true)
  chipsX -= rw + 10
  // chips: FINE, LOCK <track>, MOTOR OFF
  var chips: [(String, CGColor, CGColor)] = []
  if let m = state["mfader"] as? J, bool(m["on"]) {
    if bool(m["motorsOff"]) { chips.append(("MOTOR OFF", rgb(245, 235, 235), rgb(150, 40, 40))) }
    let lock = str(m["lock"])
    if !lock.isEmpty { chips.append(("LOCK \(lock)", rgb(20, 20, 20), ACCENT)) }
  }
  if bool(state["fine"]) { chips.append(("FINE", rgb(20, 20, 20), rgb(240, 170, 60))) }
  for (label, fg, bg) in chips {
    let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): F_SMALL]
    let w = CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(NSAttributedString(string: label, attributes: attrs)), nil, nil, nil)) + 10
    chipsX -= w
    c.fill(CGRect(x: chipsX, y: HDR_Y + 3, width: w, height: HDR_H - 6), bg)
    c.text(label, chipsX + 5, HDR_Y + 4, F_SMALL, fg, maxW: w - 8)
    chipsX -= 6
  }
  c.text(mid, 8 + lw + 8, HDR_Y + 3, F_HDR, ACCENT, maxW: max(20, chipsX - (8 + lw + 8) - 8))
}

func drawMeter(_ c: Canvas, _ m: [Any], x: CGFloat, top: CGFloat, bottom: CGFloat) {
  guard m.count >= 6 else { return }
  let legs = max(1, min(2, Int(num(m[0], 1))))
  let h = bottom - top
  for leg in 0..<legs {
    let xa = x + CGFloat(leg) * 5
    c.fill(CGRect(x: xa, y: top, width: 4, height: h), METER_BG)
    let f = meterFrac(num(m[1 + leg], -144))
    if f > 0 {
      // green, then yellow above -10 dB, red above -3 dB
      let yTop = bottom - h * f
      let y10 = bottom - h * meterFrac(-10), y3 = bottom - h * meterFrac(-3)
      c.fill(CGRect(x: xa, y: max(yTop, y10), width: 4, height: bottom - max(yTop, y10)), GREEN)
      if yTop < y10 { c.fill(CGRect(x: xa, y: max(yTop, y3), width: 4, height: y10 - max(yTop, y3)), rgb(226, 197, 65)) }
      if yTop < y3 { c.fill(CGRect(x: xa, y: yTop, width: 4, height: y3 - yTop), rgb(229, 83, 75)) }
    }
    let p = meterFrac(num(m[3 + leg], -144))
    if p > 0 { c.fill(CGRect(x: xa, y: bottom - h * p - 1, width: 4, height: 2), rgb(235, 235, 235)) }
  }
  if bool(m[5]) { c.fill(CGRect(x: x, y: top, width: CGFloat(legs) * 5 - 1, height: 3), rgb(229, 83, 75)) }
}

/// A pinned strip (Layout + select pad): a small "PIN" tag at the foot of the column, in the
/// pads' pin blue.
func pinMark(_ c: Canvas, _ x0: CGFloat) {
  let y = STRIP_BOTTOM - 16
  c.fill(CGRect(x: x0 + COL - 46, y: y, width: 26, height: 12), PIN)
  c.text("PIN", x0 + COL - 42, y, F_SMALL, rgb(10, 10, 10))
}

func renderTracks(_ c: Canvas, _ state: J, _ meters: J) {
  let strips = state["strips"] as? [J] ?? []
  let bank = Int(num(state["bank"], 1))
  // A view (PINS: some strips pinned) counts its bank from 0 over the free strips, as PushDesk does.
  let view = str(state["view"]), width = Int(num(state["bankWidth"], 8))
  header(c, state, left: "TOUCH STRIP ›", mid: str(state["selectedName"]).isEmpty ? "(no track selected)" : str(state["selectedName"]),
         right: view.isEmpty ? "tracks \(bank)–\(bank + 7)" : (width > 0 ? "\(view)  \(bank + 1)–\(bank + width)" : view))
  let mlist = meters["m"] as? [Any] ?? []
  let unity = CGFloat(num(state["unityPos"], 0.594))
  for s in strips {
    let i = Int(num(s["i"])), x0 = CGFloat(i) * COL
    c.line(x0, STRIP_TOP, x0, STRIP_BOTTOM, RULE)
    guard bool(s["live"]) else {
      if bool(s["missing"]) { // a pinned track that has been deleted: its strip holds its place
        c.text(str(s["name"]), x0 + 8, STRIP_TOP + 6, F_NAME, DIM, maxW: COL - 16)
        c.text("deleted", x0 + 8, STRIP_TOP + 26, F_SMALL, FAINT)
      } else {
        c.text("—", x0 + 10, STRIP_TOP + 40, F_VAL, FAINT)
      }
      if bool(s["pinned"]) { pinMark(c, x0) }
      continue
    }
    let sel = bool(s["selected"])
    if sel { c.fill(CGRect(x: x0 + 1, y: STRIP_TOP, width: COL - 2, height: STRIP_BOTTOM - STRIP_TOP), SEL_BG) }
    if let col = hexColour(str(s["colour"])) { c.fill(CGRect(x: x0 + 1, y: STRIP_TOP, width: COL - 2, height: 3), col) }
    c.text(str(s["name"]), x0 + 8, STRIP_TOP + 6, F_NAME, sel ? ACCENT : TEXT, maxW: COL - 28)
    let db = num(s["value"], -144)
    c.text(db <= -100 ? "-∞" : String(format: "%+.1f", db), x0 + 8, STRIP_TOP + 26, F_VAL, sel ? ACCENT : GREEN, maxW: COL - 28)
    c.text("dB", x0 + 8, STRIP_TOP + 52, F_SMALL, DIM)
    // fader position bar, with the 0 dB mark
    let bx = x0 + 8, bw = COL - 30, by = STRIP_TOP + 72
    c.ctx.setStrokeColor(FAINT); c.ctx.stroke(CGRect(x: bx, y: by, width: bw, height: 14))
    c.fill(CGRect(x: bx + 1, y: by + 1, width: max(0, (bw - 2) * CGFloat(min(1, max(0, num(s["pos"]))))), height: 12), sel ? rgb(230, 190, 90) : rgb(60, 170, 105))
    let ux = bx + 1 + (bw - 2) * unity
    c.line(ux, by - 3, ux, by + 17, rgb(220, 180, 60))
    c.text("#\(Int(num(s["track"])))", x0 + 8, STRIP_TOP + 92, F_SMALL, DIM)
    if bool(s["pinned"]) { pinMark(c, x0) }
    if bool(s["touch"]) { c.ctx.setFillColor(TOUCH); c.ctx.fillEllipse(in: CGRect(x: x0 + COL - 32, y: STRIP_TOP + 8, width: 7, height: 7)) }
    if i < mlist.count, let m = mlist[i] as? [Any] { drawMeter(c, m, x: x0 + COL - 14, top: STRIP_TOP + 6, bottom: STRIP_BOTTOM - 4) }
  }
}

func renderKnobset(_ c: Canvas, _ state: J, _ meters: J) {
  let p = state["knobset"] as? J ?? [:]
  let name = str(p["name"]), track = str(state["selectedName"])
  let page = Int(num(p["page"])), pages = Int(num(p["pages"]))
  header(c, state, left: "\(str(state["mode"])) ›", mid: name.isEmpty ? track : (track.isEmpty ? name : "\(track) · \(name)"),
         right: pages > 0 ? "page \(page + 1)/\(pages)" : "", rightPad: 26)
  if !bool(p["bound"]) {
    c.text("Open a plugin in LUNA, or press a button under the screen", 20, STRIP_TOP + 40, F_NAME, DIM)
    return
  }
  for k in p["knobs"] as? [J] ?? [] {
    let i = Int(num(k["i"])), x0 = CGFloat(i) * COL
    c.line(x0, STRIP_TOP, x0, STRIP_BOTTOM, RULE)
    guard bool(k["live"]) else {
      if bool(k["missing"]) {
        c.text(str(k["name"]), x0 + 8, STRIP_TOP + 6, F_NAME, DIM, maxW: COL - 16)
        c.text("deleted", x0 + 8, STRIP_TOP + 26, F_SMALL, FAINT)
      } else {
        c.text("—", x0 + 10, STRIP_TOP + 40, F_VAL, FAINT)
      }
      if bool(k["pinned"]) { pinMark(c, x0) }
      continue
    }
    if bool(k["pinned"]) { pinMark(c, x0) }
    let touched = bool(k["touch"])
    if touched { c.fill(CGRect(x: x0 + 1, y: STRIP_TOP, width: COL - 2, height: STRIP_BOTTOM - STRIP_TOP), SEL_BG) }
    c.text(str(k["name"]), x0 + 8, STRIP_TOP + 6, F_NAME, touched ? ACCENT : TEXT, maxW: COL - 14)
    c.text(str(k["value"]).isEmpty ? "—" : str(k["value"]), x0 + 8, STRIP_TOP + 30, F_VAL, touched ? ACCENT : GREEN, maxW: COL - 14)
    let bx = x0 + 8, bw = COL - 16, by = STRIP_TOP + 78
    let frac = CGFloat(min(1, max(0, num(k["index"]) / 1023)))
    c.fill(CGRect(x: bx, y: by, width: bw, height: 4), FAINT)
    c.fill(CGRect(x: bx, y: by, width: bw * frac, height: 4), touched ? ACCENT : GREEN)
    if touched { c.ctx.setFillColor(TOUCH); c.ctx.fillEllipse(in: CGRect(x: x0 + COL - 14, y: STRIP_TOP + 8, width: 7, height: 7)) }
  }
  // the selected track's meter, small, in the header
  if let m = meters["sel"] as? [Any] { drawMeter(c, m, x: CGFloat(W) - 16, top: HDR_Y + 3, bottom: HDR_Y + HDR_H - 3) }
}

func render(_ state: J, _ meters: J) -> CGImage {
  let c = Canvas()
  c.fill(CGRect(x: 0, y: 0, width: CGFloat(W), height: CGFloat(H)), BG)
  let b = state["buttons"] as? J ?? [:]
  buttonRow(c, b["top"] as? [Any] ?? [], b["topOn"] as? [Any] ?? [], y0: 0)
  buttonRow(c, b["bottom"] as? [Any] ?? [], b["bottomOn"] as? [Any] ?? [], y0: CGFloat(H) - BTN_H)
  let mode = str(state["mode"])
  if mode.isEmpty || mode == "FADER" {
    if (state["strips"] as? [J] ?? []).isEmpty {
      header(c, state, left: "PushDesk", mid: "waiting for LUNA", right: "")
      c.text("Open PushDesk in LUNA (Add Ons)", 20, STRIP_TOP + 40, F_VAL, DIM)
    } else {
      renderTracks(c, state, meters)
    }
  } else {
    renderKnobset(c, state, meters)
  }
  return c.image()
}

// MARK: - Push 2 frame

let XOR: [UInt8] = [0xE7, 0xF3, 0xE7, 0xFF]
let HEADER: [UInt8] = [0xFF, 0xCC, 0xAA, 0x88] + [UInt8](repeating: 0, count: 12)

func frameBytes(_ img: CGImage) -> NSMutableData {
  var rgba = [UInt8](repeating: 0, count: W * H * 4)
  let ctx = CGContext(data: &rgba, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
  var out = [UInt8](repeating: 0, count: H * LINE_PX * 2)
  for y in 0..<H {
    let row = y * W * 4, o = y * LINE_PX * 2
    for x in 0..<W {
      let r = UInt16(rgba[row + x * 4]), g = UInt16(rgba[row + x * 4 + 1]), b = UInt16(rgba[row + x * 4 + 2])
      let v = (b >> 3) << 11 | (g >> 2) << 5 | (r >> 3) // blue high, red low
      out[o + x * 2] = UInt8(v & 0xFF)
      out[o + x * 2 + 1] = UInt8(v >> 8)
    }
  }
  for i in 0..<out.count { out[i] ^= XOR[i & 3] }
  return NSMutableData(bytes: out, length: out.count)
}

func savePNG(_ img: CGImage, _ path: String) -> Bool {
  guard let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return false }
  CGImageDestinationAddImage(d, img, nil)
  return CGImageDestinationFinalize(d)
}

// MARK: - USB

final class Push2 {
  static var lastSaid = ""
  /// The Push 2's interface 0 (its screen): every USB interface, checked by vendor, product and number.
  static func findScreenInterface() -> io_service_t {
    var it: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostInterface"), &it) == KERN_SUCCESS else { return 0 }
    defer { IOObjectRelease(it) }
    func prop(_ s: io_service_t, _ key: String) -> Int? {
      (IORegistryEntryCreateCFProperty(s, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber)?.intValue
    }
    while case let s = IOIteratorNext(it), s != 0 {
      if prop(s, "idVendor") == VENDOR, prop(s, "idProduct") == PRODUCT, prop(s, "bInterfaceNumber") == 0 { return s }
      IOObjectRelease(s)
    }
    return 0
  }
  /// Log a problem once, not every retry.
  static func say(_ s: String) { if s != lastSaid { lastSaid = s; log(s) } }
  let iface: IOUSBHostInterface
  let pipe: IOUSBHostPipe
  init?() {
    let service = Push2.findScreenInterface()
    guard service != 0 else { Push2.say("no Push 2 screen interface found (is the Push plugged in?)"); return nil }
    defer { IOObjectRelease(service) }
    do {
      iface = try IOUSBHostInterface(__ioService: service, options: [], queue: nil, interestHandler: nil)
      pipe = try iface.copyPipe(withAddress: 0x01)
    } catch {
      Push2.say("Push 2 found but its screen couldn't be opened (another app may have it): \(error.localizedDescription)")
      return nil
    }
  }
  func send(_ frame: NSMutableData) -> Bool {
    do {
      let head = NSMutableData(bytes: HEADER, length: HEADER.count)
      var n = 0
      try pipe.__sendIORequest(with: head, bytesTransferred: &n, completionTimeout: 1.0)
      let chunk = 16384
      var off = 0
      while off < frame.length {
        let len = min(chunk, frame.length - off)
        let part = NSMutableData(bytes: frame.bytes.advanced(by: off), length: len)
        try pipe.__sendIORequest(with: part, bytesTransferred: &n, completionTimeout: 1.0)
        off += len
      }
      return true
    } catch {
      log("lost the Push screen: \(error.localizedDescription)")
      return false
    }
  }
  deinit { iface.destroy() }
}

