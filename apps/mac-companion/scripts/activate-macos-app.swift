import AppKit
import Foundation

struct ActivationArguments {
    var bundleId = ""
    var appName = ""
    var timeoutMs = 4000
}

func parseArguments() -> ActivationArguments {
    var arguments = ActivationArguments()
    let cli = Array(CommandLine.arguments.dropFirst())

    var index = 0
    while index < cli.count {
        let current = cli[index]
        let next = index + 1 < cli.count ? cli[index + 1] : ""

        if current == "--bundle-id", !next.isEmpty {
            arguments.bundleId = next
            index += 2
            continue
        }

        if current == "--app-name", !next.isEmpty {
            arguments.appName = next
            index += 2
            continue
        }

        if current == "--timeout-ms", !next.isEmpty, let timeoutMs = Int(next) {
            arguments.timeoutMs = timeoutMs
            index += 2
            continue
        }

        index += 1
    }

    return arguments
}

func findRunningApplication(bundleId: String, appName: String) -> NSRunningApplication? {
    if !bundleId.isEmpty {
        let bundleMatches = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
        if let app = bundleMatches.first(where: { $0.isFinishedLaunching }) ?? bundleMatches.first {
            return app
        }
    }

    if !appName.isEmpty {
        let nameMatches = NSWorkspace.shared.runningApplications.filter { app in
            app.localizedName == appName
        }
        if let app = nameMatches.first(where: { $0.isFinishedLaunching }) ?? nameMatches.first {
            return app
        }
    }

    return nil
}

let arguments = parseArguments()
let deadline = Date().addingTimeInterval(Double(arguments.timeoutMs) / 1000.0)

while Date() < deadline {
    if let app = findRunningApplication(bundleId: arguments.bundleId, appName: arguments.appName) {
        if app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps]) {
            FileHandle.standardOutput.write(Data("activated".utf8))
            exit(0)
        }
    }

    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
}

let message = "Could not find a running app to activate."
FileHandle.standardError.write(Data(message.utf8))
exit(1)
