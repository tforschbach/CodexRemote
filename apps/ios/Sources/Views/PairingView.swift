import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    @State private var manualPairingURI = ""
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text("Connect to Your Mac")
                    .font(.largeTitle).bold()

                Text("Scan the QR code shown by the Mac companion or paste the pairing URI.")
                    .foregroundStyle(.secondary)

                HStack {
                    Button("Scan QR") {
                        showScanner = true
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Paste from Clipboard") {
                        if let clipboard = UIPasteboard.general.string {
                            manualPairingURI = clipboard
                        }
                    }
                    .buttonStyle(.bordered)
                }

                TextField("codexremote://pair?...", text: $manualPairingURI)
                    .textFieldStyle(.roundedBorder)

                Button("Pair Device") {
                    Task {
                        await viewModel.pairFromURI(manualPairingURI)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(manualPairingURI.isEmpty)

                Spacer()
            }
            .padding()
            .navigationTitle("Codex Remote")
            .sheet(isPresented: $showScanner) {
                QRCodeScannerView { scanned in
                    manualPairingURI = scanned
                    showScanner = false
                    Task {
                        await viewModel.pairFromURI(scanned)
                    }
                }
            }
        }
    }
}
