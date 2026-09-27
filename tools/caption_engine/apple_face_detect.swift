import Foundation
import Vision
import ImageIO

func detectFaces(_ path: String) throws -> [[String: Double]] {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(
            domain: "CaptionFaceDetect",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "cannot load image"]
        )
    }
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    return (request.results ?? []).map { face in
        let box = face.boundingBox
        return [
            "x": box.origin.x,
            "y": box.origin.y,
            "w": box.size.width,
            "h": box.size.height,
            "confidence": Double(face.confidence),
        ]
    }
}

var output: [String: Any] = [:]
for path in CommandLine.arguments.dropFirst() {
    do {
        output[path] = try detectFaces(path)
    } catch {
        output[path] = ["error": error.localizedDescription]
    }
}
let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
