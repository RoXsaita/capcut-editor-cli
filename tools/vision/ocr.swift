// Read the text out of an image using Apple's Vision framework.
// No third-party dependency: pyobjc and pytesseract are both absent on a stock machine,
// and this is the same engine the OS uses, so it handles UI screenshots well.
// Prints one JSON array of {text, confidence, x, y, w, h} with a normalised, top-left origin.
//
//   ocr IMAGE [--languages en,ar]           one image, one JSON array
//   ocr --batch [--languages en,ar] < LIST  one image path per stdin line, one JSON line per
//                                           image: the array, or {"error": "..."}. One process
//                                           for a whole index instead of one per frame.
import Foundation
import Vision
import CoreGraphics
import ImageIO

struct OCRFailure: Error { let message: String }

let args = CommandLine.arguments
var languages: [String] = ["en-US"]
if let i = args.firstIndex(of: "--languages"), i + 1 < args.count {
    languages = args[i + 1].split(separator: ",").map(String.init)
}

func recognize(_ url: URL) throws -> [[String: Any]] {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw OCRFailure(message: "cannot read \(url.path)")
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false          // UI strings are not prose
    request.recognitionLanguages = languages

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) }
    catch { throw OCRFailure(message: "vision failed: \(error)") }

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
    return out
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!); exit(1)
}

if args.contains("--batch") {
    while let line = readLine() {
        let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.isEmpty { continue }
        let row: Any
        do { row = try recognize(URL(fileURLWithPath: path)) }
        catch let failure as OCRFailure { row = ["error": failure.message] }
        catch { row = ["error": "\(error)"] }
        var data = try! JSONSerialization.data(withJSONObject: row, options: [])
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}

guard args.count > 1 else { FileHandle.standardError.write("usage: ocr IMAGE [--languages en,ar] | ocr --batch [--languages en,ar] < LIST\n".data(using: .utf8)!); exit(2) }
do {
    let out = try recognize(URL(fileURLWithPath: args[1]))
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out, options: []))
} catch let failure as OCRFailure {
    fail(failure.message)
} catch {
    fail("\(error)")
}
