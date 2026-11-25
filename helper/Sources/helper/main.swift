// pushdesk-luna-helper: the Push 2 screen for PushDesk in LUNA, as one small app.
//
// A LUNA Add On can't reach USB, so the PushDesk Add On sends what the Push screen should show
// to this helper on http://127.0.0.1:47829 (an Add On page may reach localhost without asking).
// The helper:
//   - starts at login (a LaunchAgent) and does nothing until LUNA is running;
//   - listens on 127.0.0.1:47829 only while LUNA runs (macOS tells it when LUNA opens/quits);
//   - takes the Push screen only while the Add On is talking (it sends a heartbeat every
//     second) and hands it back after 10 s of silence, or at once when LUNA quits, so Ableton
//     Live can use the Push otherwise.
// Only macOS frameworks: AppKit (to hear LUNA open and quit), Network (the local server),
// CoreGraphics/CoreText and IOUSBHost (Screen.swift).
//
//   pushdesk-luna-helper            run (what the LaunchAgent does)
//   pushdesk-luna-helper --version

import AppKit
import Foundation
import Network

let VERSION = "0.1.5"
let PORT: UInt16 = 47829
let IDLE: TimeInterval = 10
let LUNA_BUNDLE_ID = "com.uaudio.luna"

if CommandLine.arguments.contains("--version") { print("pushdesk-luna-helper \(VERSION)"); exit(0) }

// MARK: - the screen

/// What the Add On last sent, and the Push it's drawn on. Everything runs on one queue.
final class ScreenService {
  let q = DispatchQueue(label: "pushdesk.screen")
  private var state: J = [:], meters: J = [:]
  private var dirty = true
  private var lastPost = Date.distantPast
  private var push: Push2?
  private var frame: NSMutableData?
  private var lastSent = Date.distantPast
  private var lookedForPush = Date.distantPast
  private var timer: DispatchSourceTimer?
  private(set) var posts = 0

  func start() {
    q.async {
      guard self.timer == nil else { return }
      let t = DispatchSource.makeTimerSource(queue: self.q)
      t.schedule(deadline: .now(), repeating: .milliseconds(33))
      t.setEventHandler { [weak self] in self?.tick() }
      t.resume()
      self.timer = t
    }
  }

  /// Stop drawing and let go of the Push (LUNA quit).
  func stop() {
    q.sync {
      timer?.cancel(); timer = nil
      release("LUNA quit")
      state = [:]; meters = [:]; lastPost = .distantPast
    }
  }

  func receive(path: String, body: Data) -> Bool {
    guard let j = (try? JSONSerialization.jsonObject(with: body)) as? J else { return false }
    q.async {
      if path.hasPrefix("/meters") { self.meters = j } else { self.state = j }
      self.dirty = true
      self.lastPost = Date()
      self.posts += 1
    }
    return true
  }

  private func release(_ why: String) {
    if push != nil {
      push = nil // deinit destroys the interface: the screen is free for other apps
      frame = nil
      log("Push screen handed back (\(why))")
    }
  }

  private func tick() {
    guard Date().timeIntervalSince(lastPost) < IDLE else {
      release("no word from PushDesk for \(Int(IDLE)) s")
      return
    }
    if push == nil, Date().timeIntervalSince(lookedForPush) > 2 {
      lookedForPush = Date()
      push = Push2()
      if push != nil { log("Push screen taken"); frame = nil; dirty = true }
    }
    if dirty || frame == nil {
      frame = frameBytes(render(state, meters))
      dirty = false
      lastSent = .distantPast
    }
    // a new frame at once; an unchanged one again every second, or the Push blanks it
    if let p = push, let f = frame, lastSent == .distantPast || Date().timeIntervalSince(lastSent) > 1 {
      if p.send(f) { lastSent = Date() } else { push = nil }
    }
  }
}

// MARK: - the local server

/// A tiny HTTP server on 127.0.0.1: POST /state, POST /meters (JSON), GET /health.
final class LocalServer {
  private var listener: NWListener?
  private var wanted = false
  private let q = DispatchQueue(label: "pushdesk.server")
  private let screen: ScreenService
  init(screen: ScreenService) { self.screen = screen }

  func start() {
    q.async { self.wanted = true; self.open() }
  }

  /// Listen; if the port is busy (a previous copy still letting go of it), try again in 2 s.
  private func open() {
    guard wanted, listener == nil else { return }
    do {
      let params = NWParameters.tcp
      params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: PORT)!)
      params.allowLocalEndpointReuse = true
      let l = try NWListener(using: params)
      l.stateUpdateHandler = { [unowned self] st in
        switch st {
        case .ready: log("listening on http://127.0.0.1:\(PORT)")
        case .failed(let e):
          log("can't listen on port \(PORT) yet: \(e); trying again in 2 s")
          self.listener?.cancel(); self.listener = nil
          self.q.asyncAfter(deadline: .now() + 2) { self.open() }
        default: break
        }
      }
      l.newConnectionHandler = { [weak self] c in self?.serve(c) }
      l.start(queue: q)
      listener = l
    } catch {
      log("can't start the local server: \(error); trying again in 2 s")
      q.asyncAfter(deadline: .now() + 2) { self.open() }
    }
  }

  func stop() {
    q.sync { wanted = false; listener?.cancel(); listener = nil }
  }

  private func serve(_ c: NWConnection) {
    c.start(queue: q)
    var buf = Data()
    func reply(_ status: String, _ body: Data = Data(), type: String = "application/json") {
      var head = "HTTP/1.1 \(status)\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\n"
      head += "Access-Control-Allow-Headers: Content-Type\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
      c.send(content: head.data(using: .utf8)! + body, completion: .contentProcessed { _ in c.cancel() })
    }
    func read() {
      c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, done, err in
        if let d = data { buf.append(d) }
        if buf.count > 8 << 20 { reply("413 Payload Too Large"); return }
        guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else {
          if done || err != nil { c.cancel() } else { read() }
          return
        }
        let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        let method = parts.count > 0 ? String(parts[0]) : "", path = parts.count > 1 ? String(parts[1]) : "/"
        let length = lines.dropFirst().compactMap { l -> Int? in
          let kv = l.split(separator: ":", maxSplits: 1)
          return kv.count == 2 && kv[0].lowercased() == "content-length" ? Int(kv[1].trimmingCharacters(in: .whitespaces)) : nil
        }.first ?? 0
        let body = buf[end.upperBound...]
        if body.count < length { if done || err != nil { c.cancel() } else { read() }; return }
        switch method {
        case "OPTIONS": reply("204 No Content")
        case "GET":
          let j: J = ["ok": true, "app": "pushdesk-luna-helper", "version": VERSION, "posts": self.screen.posts]
          reply("200 OK", (try? JSONSerialization.data(withJSONObject: j)) ?? Data())
        case "POST":
          if path.hasPrefix("/state") || path.hasPrefix("/meters") {
            reply(self.screen.receive(path: path, body: Data(body.prefix(length))) ? "204 No Content" : "400 Bad Request")
          } else { reply("404 Not Found") }
        default: reply("405 Method Not Allowed")
        }
      }
    }
    read()
  }
}

// MARK: - following LUNA

let screen = ScreenService()
let server = LocalServer(screen: screen)
var lunaRunning = false

func lunaIsRunning() -> Bool {
  NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == LUNA_BUNDLE_ID && !$0.isTerminated }
}

/// LUNA opened or quit: serve while it runs, and nothing otherwise.
func check() {
  let running = lunaIsRunning()
  guard running != lunaRunning else { return }
  lunaRunning = running
  if running {
    log("LUNA is running: waiting for PushDesk")
    server.start()
    screen.start()
  } else {
    log("LUNA quit: stopping")
    server.stop()
    screen.stop()
  }
}

let nc = NSWorkspace.shared.notificationCenter
for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
  nc.addObserver(forName: name, object: nil, queue: .main) { _ in check() }
}

// Quit cleanly on SIGTERM / SIGINT (launchd, Ctrl-C): let go of the Push first.
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  s.setEventHandler { log("stopping"); server.stop(); screen.stop(); exit(0) }
  s.resume()
  signalSources.append(s)
}

log("pushdesk-luna-helper \(VERSION): starts with LUNA, stops when LUNA quits")
check()
RunLoop.main.run()
