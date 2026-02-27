import SwiftUI

@main
struct CodexRemoteApp: App {
    @StateObject private var viewModel = AppViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(viewModel)
                .task {
                    await viewModel.bootstrap()
                }
        }
    }
}
