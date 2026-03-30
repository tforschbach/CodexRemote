import SwiftUI
import UIKit

@main
struct CodexRemoteApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var viewModel = AppViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(viewModel)
                .task {
                    await viewModel.bootstrap()
                }
                .onChange(of: scenePhase) { _, newValue in
                    viewModel.recordScenePhaseChange(newValue)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
                    viewModel.recordMemoryWarning()
                }
        }
    }
}
