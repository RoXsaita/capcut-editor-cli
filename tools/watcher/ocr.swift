// On-device OCR for watcher keyframes (Apple Vision, no network).
// usage: ocr <image>... > ocr.ndjson   (one JSON line per image: {"file", "lines":[{"text","conf","box":[x,y,w,h]}]})
// Boxes are normalized, top-left origin. Language correction off: screens are code, names and URLs.
import Foundation
import Vision
import ImageIO

func recognize(_ path: String) -> [[String: Any]] {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let src = CGImageSourceCreateWithURL(url, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return [] }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    req.recognitionLanguages = ["en-US", "ar-SA"]
    req.automaticallyDetectsLanguage = true
    try? VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
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
    let rec: [String: Any] = ["file": (path as NSString).lastPathComponent, "lines": recognize(path)]
    let data = try! JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
