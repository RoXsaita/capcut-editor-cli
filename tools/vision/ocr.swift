// Read the text out of an image using Apple's Vision framework.
// No third-party dependency: pyobjc and pytesseract are both absent on a stock machine,
// and this is the same engine the OS uses, so it handles UI screenshots well.
// Prints one JSON array of {text, confidence, x, y, w, h} with a normalised, top-left origin.
import Foundation
import Vision
import CoreGraphics
import ImageIO

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: ocr IMAGE [--languages en,ar]\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
var languages: [String] = ["en-US"]
if let i = args.firstIndex(of: "--languages"), i + 1 < args.count {
    languages = args[i + 1].split(separator: ",").map(String.init)
}

guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write("cannot read \(url.path)\n".data(using: .utf8)!); exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false          // UI strings are not prose
request.recognitionLanguages = languages

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do { try handler.perform([request]) }
catch { FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!); exit(1) }

var out: [[String: Any]] = []
for obs in (request.results ?? []) {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox                      // Vision origin is bottom-left
    out.append([
        "text": top.string,
        "confidence": Double(top.confidence),
        "x": Double(b.origin.x), "y": Double(1 - b.origin.y - b.size.height),
        "w": Double(b.size.width), "h": Double(b.size.height),
    ])
}
let data = try! JSONSerialization.data(withJSONObject: out, options: [])
FileHandle.standardOutput.write(data)
