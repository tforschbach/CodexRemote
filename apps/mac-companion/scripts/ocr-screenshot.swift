import AppKit
import Foundation
import Vision

struct OCRResult: Encodable {
    let text: String
    let lines: [String]
}

enum OCRScriptError: Error {
    case missingArgument
    case unreadableImage(String)
}

func makeCGImage(from path: String) throws -> CGImage {
    guard let image = NSImage(contentsOfFile: path) else {
        throw OCRScriptError.unreadableImage(path)
    }

    var proposedRect = CGRect.zero
    guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
        throw OCRScriptError.unreadableImage(path)
    }

    return cgImage
}

func recognizeText(in cgImage: CGImage) throws -> OCRResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])

    let observations = request.results ?? []
    let lines = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }

    return OCRResult(text: lines.joined(separator: "\n"), lines: lines)
}

do {
    guard CommandLine.arguments.count >= 2 else {
        throw OCRScriptError.missingArgument
    }

    let path = CommandLine.arguments[1]
    let cgImage = try makeCGImage(from: path)
    let result = try recognizeText(in: cgImage)

    let data = try JSONEncoder().encode(result)
    if let json = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data(json.utf8))
    }
} catch {
    let message: String
    switch error {
    case OCRScriptError.missingArgument:
        message = "Missing screenshot path argument"
    case OCRScriptError.unreadableImage(let path):
        message = "Could not read screenshot at \(path)"
    default:
        message = error.localizedDescription
    }

    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
