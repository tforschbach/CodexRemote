import XCTest
@testable import CodexRemote

final class CodexRemoteTests: XCTestCase {
    func testJSONValueDecodesObject() throws {
        let json = """
        {
          "event": "message_delta",
          "chatId": "chat-1",
          "payload": {"delta": "hello"},
          "timestamp": 1
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(StreamEventEnvelope.self, from: json)

        XCTAssertEqual(envelope.event, "message_delta")
        XCTAssertEqual(envelope.chatId, "chat-1")
    }
}
