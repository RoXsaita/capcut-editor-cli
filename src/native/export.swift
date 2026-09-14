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
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
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
if let home = find("HomePageDraftTitle:" + project) { click(home, count: 2); Thread.sleep(forTimeInterval: 1) }
if find("ExportDialog") == nil {
    _ = waitFor("MainWindowTitleBarExportBtn")
    keyboard("tell application \"System Events\" to keystroke \"e\" using command down")
}
_ = waitFor("ExportDialog")
func exportPath() -> String? {
    all(root).map { text($0, kAXValueAttribute) }.first { $0.hasPrefix("/") && $0.hasSuffix(".mp4") }
}
guard exportPath() != nil else { fail("EXPORT_PATH_UNREADABLE") }
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
guard windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && ($0[kCGWindowName as String] as? String) == "Export-" + project }) else { fail("EXPORT_WRONG_PROJECT: native export window title differs") }
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
