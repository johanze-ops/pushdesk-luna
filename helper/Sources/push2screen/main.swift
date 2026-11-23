// push2screen: draws the state files the companion writes on the Push 2 screen.
// (See Screen.swift for the format.)

import Foundation
import CoreGraphics

// MARK: - arguments

var statePath = "/tmp/pushdesk_luna_state.json"
var metersPath = "/tmp/pushdesk_luna_meters.json"
var exitWith: Int32? = nil
var renderOnly: String? = nil
do {
  var it = CommandLine.arguments.dropFirst().makeIterator()
  while let a = it.next() {
    switch a {
    case "--state": statePath = it.next() ?? statePath
    case "--meters": metersPath = it.next() ?? metersPath
    case "--exit-with": exitWith = Int32(it.next() ?? "")
    case "--render-only": renderOnly = it.next()
    default: FileHandle.standardError.write("unknown argument \(a)\n".data(using: .utf8)!); exit(2)
    }
  }
}


// MARK: - main

func mtime(_ p: String) -> Date? { (try? FileManager.default.attributesOfItem(atPath: p))?[.modificationDate] as? Date }

if let out = renderOnly {
  let ok = savePNG(render(load(statePath), load(metersPath)), out)
  log(ok ? "wrote \(out)" : "couldn't write \(out)")
  exit(ok ? 0 : 1)
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }
var push: Push2? = nil
var lastState: Date? = nil, lastMeters: Date? = nil, lastSent = Date.distantPast
var frame: NSMutableData? = nil
var lookedForPush = Date.distantPast
while true {
  if let pid = exitWith, kill(pid, 0) != 0, errno == ESRCH { log("parent gone: exiting"); exit(0) }
  if push == nil, Date().timeIntervalSince(lookedForPush) > 2 {
    lookedForPush = Date()
    push = Push2()
    if push != nil { log("Push 2 opened (\(String(VENDOR, radix: 16))/\(String(PRODUCT, radix: 16)))"); frame = nil }
  }
  let ms = mtime(statePath), mm = mtime(metersPath)
  if frame == nil || ms != lastState || mm != lastMeters {
    lastState = ms; lastMeters = mm
    frame = frameBytes(render(load(statePath), load(metersPath)))
    lastSent = .distantPast
  }
  if let p = push, let f = frame, Date().timeIntervalSince(lastSent) > (lastSent == .distantPast ? 0 : 1.0) {
    if p.send(f) { lastSent = Date() } else { push = nil }
  }
  usleep(33_000) // about 30 checks a second; stat() is cheap
}
