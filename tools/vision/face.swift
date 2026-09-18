// On-device faces in video frames. Normalized top-left boxes, identical to ocr.swift.
import Foundation
import Vision
import AVFoundation
import ImageIO

let args = CommandLine.arguments
func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(2)
}
func faces(_ image: CGImage) throws -> [[String: Any]] {
    let request = VNDetectFaceRectanglesRequest()
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).map { face in
        let b = face.boundingBox
        return ["x": b.minX, "y": 1-b.maxY, "w": b.width, "h": b.height, "confidence": face.confidence]
    }
}
if args.count == 2 {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { die("cannot load image") }
    do { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: faces(image))); exit(0) }
    catch { die("face detection failed: \(error)") }
}
guard args.count == 4, let start = Double(args[2]), let duration = Double(args[3]),
      start >= 0, duration > 0, start.isFinite, duration.isFinite else {
    die("usage: face VIDEO START_SECONDS DURATION_SECONDS")
}
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 1000000)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 1000000)
var rows: [[String: Any]] = []
do {
    for i in 0..<Int(ceil(duration * 10)) {
        let t = start + Double(i) / 10
        let image = try generator.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 1000000), actualTime: nil)
        let boxes = try faces(image)
        rows.append(["t": t, "boxes": boxes])
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: rows))
} catch { die("face detection failed: \(error)") }
