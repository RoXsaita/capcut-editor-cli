// Native CapCut export: accessibility identifiers, never fixed screen coordinates.
import Cocoa
import ApplicationServices
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(2) }
func attr(_ e: AXUIElement, _ k: String) -> AnyObject? {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(e, k as CFString, &value)
    return value
}
func text(_ e: AXUIElement, _ k: String) -> String { attr(e, k) as? String ?? "" }
func all(_ e: AXUIElement, _ depth: Int = 0) -> [AXUIElement] {
    if depth > 20 { return [] }
    return [e] + (attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []).flatMap { all($0, depth + 1) }
}
func click(_ e: AXUIElement, count: Int = 1) {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.lemon.lvoverseas" else { fail("EXPORT_FOCUS_LOST: retry when CapCut can keep focus briefly") }
    guard let pv = attr(e, kAXPositionAttribute), let sv = attr(e, kAXSizeAttribute) else { fail("EXPORT_CONTROL_GEOMETRY") }
    var p = CGPoint.zero; var s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p); AXValueGetValue(sv as! AXValue, .cgSize, &s)
    p.x += s.width / 2; p.y += s.height / 2
    CGWarpMouseCursorPosition(p)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.5)
    for n in 1...count {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
            event.flags = []
            event.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            event.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.04)
        }
    }
}
func keyboard(_ script: String, _ args: [String] = []) {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.lemon.lvoverseas" else { fail("EXPORT_FOCUS_LOST") }
    let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-e", script] + args
    do { try task.run(); task.waitUntilExit() } catch { fail("EXPORT_KEYBOARD_FAILED") }
    if task.terminationStatus != 0 { fail("EXPORT_KEYBOARD_FAILED") }
}
func typeName(_ value: String) {
    keyboard("on run argv\ntell application \"System Events\"\nkeystroke \"a\" using command down\nkeystroke (item 1 of argv)\nkey code 48\nend tell\nend run", [value])
    Thread.sleep(forTimeInterval: 0.3)
}
guard CommandLine.arguments.count == 3 else { fail("usage: export.swift PROJECT STAGING_NAME") }
let project = CommandLine.arguments[1], staging = CommandLine.arguments[2]
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
guard (session["CGSSessionScreenIsLocked"] as? Bool) != true else { fail("EXPORT_SESSION_LOCKED: unlock the Mac before native export") }
guard AXIsProcessTrusted() else { fail("EXPORT_ACCESSIBILITY_REQUIRED: grant accessibility to the invoking terminal/app") }
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.lemon.lvoverseas").first else { fail("EXPORT_APP_CLOSED: open CapCut on Home or the requested project") }
app.activate(options: [])
Thread.sleep(forTimeInterval: 0.5)
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(root, 2)
func find(_ id: String) -> AXUIElement? { all(root).first { text($0, kAXTitleAttribute) == id || text($0, kAXDescriptionAttribute) == id } }
func waitFor(_ id: String, seconds: Double = 15) -> AXUIElement {
    let end = Date().addingTimeInterval(seconds)
    repeat { if let e = find(id) { return e }; Thread.sleep(forTimeInterval: 0.2) } while Date() < end
    fail("EXPORT_CONTROL_MISSING: " + id)
}
if let close = find("automationcloseBtn") {
    click(close)
    let dismiss = Process(); dismiss.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    dismiss.arguments = ["-e", "tell application \"System Events\" to key code 53"]
    try dismiss.run(); dismiss.waitUntilExit(); Thread.sleep(forTimeInterval: 0.3)
}
// Opening the exact, verified Home card establishes project identity without
// Screen Recording access to CGWindow titles. Never infer identity from filename.
let target = "HomePageDraftTitle:" + project
func homeCards(_ nodes: [AXUIElement]? = nil) -> [AXUIElement] { (nodes ?? all(root)).filter { text($0, kAXDescriptionAttribute) == "HomePageDraft" } }
func rect(_ e: AXUIElement) -> CGRect? {
    guard let pv = attr(e, kAXPositionAttribute), let sv = attr(e, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero; var s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p); AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}
func homeWindow() -> CGRect? {
    let window = attr(root, kAXMainWindowAttribute) ?? (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first
    guard let w = window else { return nil }
    return rect(w as! AXUIElement)
}
// One walk of the tree: the card that holds the exact title, only when it lies fully
// inside the window, and where every card sits (unchanged after a scroll = page end).
func homeState() -> (card: AXUIElement?, layout: [CGRect]) {
    let nodes = all(root), cards = homeCards(nodes), layout = cards.compactMap(rect)
    guard let title = nodes.first(where: { text($0, kAXTitleAttribute) == target || text($0, kAXDescriptionAttribute) == target }),
          let tr = rect(title), let window = homeWindow() else { return (nil, layout) }
    let point = CGPoint(x: tr.midX, y: tr.midY)
    let card = cards.first { rect($0).map { $0.contains(point) && window.contains($0) } == true }
    return (card, layout)
}
// What is under a screen point, only when it belongs to CapCut. A floating panel from
// another app (a recorder's guided-take or alarm panel, say) would take the wheel or the
// click, and the frontmost-app guard cannot see it. Returns the owner's name otherwise.
func capcutHit(_ p: CGPoint) -> (element: AXUIElement?, owner: String) {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 2)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &hit) == .success, let h = hit else { return (nil, "nothing readable") }
    var pid: pid_t = 0
    guard AXUIElementGetPid(h, &pid) == .success else { return (nil, "nothing readable") }
    if pid == app.processIdentifier { return (h, "CapCut") }
    return (nil, NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)")
}
func occluded(_ p: CGPoint, _ owner: String, over: String = "CapCut") -> Never {
    fail("EXPORT_POINT_OCCLUDED: \(owner) is over \(over) at (\(Int(p.x)), \(Int(p.y))); move it and retry")
}
// Home is one long Qt page and only the cards on screen are in the accessibility tree.
// A wheel over a card does not move it; a wheel over the page body does. Once the grid
// fills the window a fixed point lands on a card, so aim at the page outside the cards:
// the fixed point that worked by hand while it is clear of every card, then the margin
// right of the last column, then a gap between rows.
func wheelPoints(_ layout: [CGRect], _ w: CGRect) -> [CGPoint] {
    var points = [CGPoint(x: w.minX + w.width * 0.55, y: w.minY + w.height * 0.85)]
    if let right = layout.map(\.maxX).max(), w.maxX - right >= 24 {
        points.append(CGPoint(x: (right + w.maxX) / 2, y: w.minY + w.height * 0.85))
    }
    let rows = layout.sorted { $0.minY < $1.minY }
    for (a, b) in zip(rows, rows.dropFirst()) where b.minY - a.maxY >= 8 && a.maxY > w.minY && b.minY < w.maxY {
        points.append(CGPoint(x: w.midX, y: (a.maxY + b.minY) / 2)); break
    }
    return points.filter { p in w.contains(p) && !layout.contains { $0.insetBy(dx: -2, dy: -2).contains(p) } }
}
// Qt routes the wheel by hover, so move the pointer there first. `attempt` picks a later
// point when the first one did not move the page.
func scrollHome(_ pixels: Int32, _ layout: [CGRect], attempt: Int = 0) {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.lemon.lvoverseas" else { fail("EXPORT_FOCUS_LOST: retry when CapCut can keep focus briefly") }
    guard let w = homeWindow() else { fail("EXPORT_HOME_GEOMETRY") }
    let candidates = wheelPoints(layout, w)
    guard !candidates.isEmpty else { fail("EXPORT_HOME_GEOMETRY: no page area outside the cards to scroll") }
    let p = candidates[attempt % candidates.count]
    let (hit, owner) = capcutHit(p)
    if hit == nil { occluded(p, owner) }
    CGWarpMouseCursorPosition(p)
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.15)
    let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: pixels, wheel2: 0, wheel3: 0)!
    wheel.location = p; wheel.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.6)
}
// BEGIN cardHitAccepted: pure, so test/export-hit.test.mjs compiles it on its own.
// `hit` and `card` are ancestry chains, the element first and its parents after it.
// CapCut's Qt hit test stops at the window (a sheet when one is open), never the card,
// so a hit is the card's when it is the card, inside the card, or a container the card
// sits in. A sheet, another window or a sibling over the card is none of those.
func cardHitAccepted<T>(hit: [T], card: [T], same: (T, T) -> Bool) -> Bool {
    guard let h = hit.first, let c = card.first else { return false }
    return hit.contains { same($0, c) } || card.contains { same($0, h) }
}
// END cardHitAccepted
func ancestry(_ e: AXUIElement) -> [AXUIElement] {
    var chain = [e]
    while chain.count < 32, let parent = attr(chain[chain.count - 1], kAXParentAttribute) { chain.append(parent as! AXUIElement) }
    return chain
}
// The card is clicked at its centre (as click() does) only when CapCut owns that point and
// the hit is the card, inside it or one of its containers: never a CapCut sheet, another
// CapCut window, or another app's window above it.
func clickCard(_ card: AXUIElement) {
    guard let r = rect(card) else { fail("EXPORT_CONTROL_GEOMETRY") }
    let p = CGPoint(x: r.midX, y: r.midY)
    let (hit, owner) = capcutHit(p)
    guard let h = hit else { occluded(p, owner) }
    if !cardHitAccepted(hit: ancestry(h), card: ancestry(card), same: { CFEqual($0, $1) }) {
        occluded(p, "another CapCut element (" + text(h, kAXRoleAttribute) + ")", over: "the project card")
    }
    click(card)
}
if find(target) == nil {
    if find("ExportDialog") != nil { keyboard("tell application \"System Events\" to key code 53") }
    if let back = find("Back to home page") {
        guard AXUIElementPerformAction(back, kAXPressAction as CFString) == .success else { fail("EXPORT_HOME_FAILED") }
    }
}
// Cards take a few seconds to appear, after Back or on a freshly opened Home.
let cardsBy = Date().addingTimeInterval(10)
while homeCards().isEmpty && Date() < cardsBy { Thread.sleep(forTimeInterval: 0.25) }
if homeCards().isEmpty { fail("EXPORT_HOME_UNAVAILABLE: no project cards on CapCut Home") }
var state = homeState()
if state.card == nil { Thread.sleep(forTimeInterval: 1); state = homeState() }
// Older projects sit below the first row: page down, then back up, checking each step.
// A card already cut off by the window edge means the page has more to show.
let overflowed = homeWindow().map { w in state.layout.contains { $0.maxY > w.maxY + 1 || $0.minY < w.minY - 1 } } ?? false
var moved = false
for pixels: Int32 in [-240, 240] where state.card == nil {
    var still = 0
    for _ in 0..<60 {
        let before = state.layout
        scrollHome(pixels, before)
        state = homeState()
        if state.card != nil { break }
        if state.layout == before {
            // Before calling it the end of the page, try the wheel at another point.
            scrollHome(pixels, before, attempt: 1)
            state = homeState()
            if state.card != nil { break }
        }
        if state.layout != before { moved = true }
        still = state.layout == before ? still + 1 : 0
        if still >= 2 { break }
    }
}
let found = state.card
if found == nil && !moved {
    if overflowed { fail("EXPORT_HOME_SCROLL_STUCK: CapCut Home has more cards but did not move under the scroll wheel while looking for " + target) }
    fail("EXPORT_PROJECT_NOT_ON_HOME: no card titled " + target + "; Home did not scroll (a short library that fits on one screen, or the wheel did not reach the page). Check the CapCut draft name first")
}
guard let card = found else { fail("EXPORT_PROJECT_NOT_ON_HOME: no card titled " + target + " on CapCut Home after scrolling") }
clickCard(card)
_ = waitFor("MainWindowTitleBarExportBtn")
if find("ExportDialog") == nil {
    _ = waitFor("MainWindowTitleBarExportBtn")
    keyboard("tell application \"System Events\" to keystroke \"e\" using command down")
}
_ = waitFor("ExportDialog")
func exportPath() -> String? {
    all(root).map { text($0, kAXValueAttribute) }.first { $0.hasPrefix("/") && $0.hasSuffix(".mp4") }
}
if exportPath() == nil {
    click(waitFor("ExportFormatInput"))
    click(waitFor("mp4", seconds: 3))
    Thread.sleep(forTimeInterval: 0.3)
}
guard exportPath() != nil else { fail("EXPORT_PATH_UNREADABLE: select MP4") }
click(waitFor("ExportFileNameInput")); Thread.sleep(forTimeInterval: 0.2); typeName(staging)
guard let output = exportPath(), URL(fileURLWithPath: output).deletingPathExtension().lastPathComponent == staging else { fail("EXPORT_NAME_NOT_SET: " + (exportPath() ?? "none")) }
if FileManager.default.fileExists(atPath: output) { fail("EXPORT_STAGE_EXISTS") }
if let sync = find("automationbackupCheckBox"), (attr(sync, kAXValueAttribute) as? NSNumber)?.intValue == 1 { click(sync) }
_ = waitFor("ExportOkBtn")
guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.lemon.lvoverseas" else { fail("EXPORT_FOCUS_LOST") }
// CapCut's Qt export button acknowledges AXPress without exporting. The dialog's
// native default Return action works; do not synthesize blind retries.
let confirm = Process()
confirm.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
confirm.arguments = ["-e", "tell application \"System Events\" to key code 36"]
try confirm.run(); confirm.waitUntilExit()
guard confirm.terminationStatus == 0 else { fail("EXPORT_CONFIRM_FAILED") }
Thread.sleep(forTimeInterval: 1)
print(output)
