// On-device OCR for watcher keyframes (Apple Vision, no network).
// usage: ocr <image>... > ocr.ndjson   (one JSON line per image: {"file", "lines":[{"text","conf","box":[x,y,w,h]}]},
//        or {"file", "error": "decode"|"vision"} when the image cannot be read or Vision fails)
// Boxes are normalized, top-left origin. Language correction off: screens are code, names and URLs.
// A failure is reported, never an empty "lines": pick.py drops errored frames, while an empty list
// would read as a text-free screen and pass the OCR gate.
import Foundation
import Vision
import ImageIO

enum OCRError: String, Error { case decode, vision }

func recognize(_ path: String) throws -> [[String: Any]] {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw OCRError.decode }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US", "ar-SA"]
    req.automaticallyDetectsLanguage = true
    do {
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
    } catch {
        throw OCRError.vision
    }
    var out: [[String: Any]] = []
    for o in req.results ?? [] {
        guard let c = o.topCandidates(1).first else { continue }
        let b = o.boundingBox
        out.append(["text": c.string, "conf": (c.confidence * 100).rounded() / 100,
                    "box": [b.minX, 1 - b.maxY, b.width, b.height].map { ($0 * 1000).rounded() / 1000 }])
    }
    return out
}

for path in CommandLine.arguments.dropFirst() {
    var rec: [String: Any] = ["file": (path as NSString).lastPathComponent]
    do {
        rec["lines"] = try recognize(path)
    } catch let e as OCRError {
        rec["error"] = e.rawValue
    } catch {
        rec["error"] = OCRError.vision.rawValue
    }
    let data = try! JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
