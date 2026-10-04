// Text and faces for many frames in one process, for the X-ray.
// Reads image paths from stdin, one per line; writes one JSON object per line:
//   {"path": P, "text": [{text, confidence, x, y, w, h}], "faces": [{x, y, w, h, confidence}]}
// Boxes are normalised with a top-left origin, the same shape as ocr.swift and face.swift.
// One process instead of one per frame: loading the Vision models dominates a single call.
import Foundation
import Vision
import ImageIO

var languages: [String] = ["en-US", "ar"]
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--languages"), i + 1 < args.count {
    languages = args[i + 1].split(separator: ",").map(String.init)
}
let fast = args.contains("--fast")
// --dual reads every frame twice, Latin-first and Arabic-first, because Vision only reads a
// script well when it leads the language list. The caller keeps the better line per box.
let dual = args.contains("--dual")

func box(_ b: CGRect) -> [String: Double] {
    ["x": Double(b.origin.x), "y": Double(1 - b.origin.y - b.size.height),
     "w": Double(b.size.width), "h": Double(b.size.height)]
}

while let line = readLine() {
    let path = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if path.isEmpty { continue }
    var record: [String: Any] = ["path": path]
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        record["error"] = "cannot read image"
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: record))
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        continue
    }
    func request(_ langs: [String]) -> VNRecognizeTextRequest {
        let r = VNRecognizeTextRequest()
        r.recognitionLevel = fast ? .fast : .accurate
        r.usesLanguageCorrection = false
        r.recognitionLanguages = langs
        return r
    }
    func lines(_ r: VNRecognizeTextRequest) -> [[String: Any]] {
        (r.results ?? []).compactMap { obs -> [String: Any]? in
            guard let top = obs.topCandidates(1).first else { return nil }
            var item: [String: Any] = box(obs.boundingBox)
            item["text"] = top.string
            item["confidence"] = Double(top.confidence)
            return item
        }
    }
    let text = request(languages)
    let second = request(Array(languages.reversed()))
    let faces = VNDetectFaceRectanglesRequest()
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform(dual ? [text, second, faces] : [text, faces])
        record["text"] = lines(text)
        if dual { record["text_alt"] = lines(second) }
        record["faces"] = (faces.results ?? []).map { face -> [String: Any] in
            var item: [String: Any] = box(face.boundingBox)
            item["confidence"] = Double(face.confidence)
            return item
        }
    } catch {
        record["error"] = "vision failed: \(error)"
    }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: record))
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
