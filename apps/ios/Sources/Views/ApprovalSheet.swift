import SwiftUI

struct ApprovalSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    let approval: ApprovalRequest

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(approval.title)
                    .font(.title2).bold()

                Label(approval.kindLabel, systemImage: approval.iconName)
                    .font(.subheadline)

                if let serverName = approval.serverName, !serverName.isEmpty {
                    Text(serverName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(approval.summary)
                    .font(.body)
                    .padding(12)
                    .background(Color.gray.opacity(0.1))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                Text("Risk: \(approval.riskLevel.capitalized)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                VStack(spacing: 10) {
                    Button(approval.approveButtonTitle) {
                        Task { await viewModel.sendApproval("approve") }
                    }
                    .buttonStyle(.borderedProminent)

                    if approval.supportsSessionAllow {
                        Button(approval.sessionAllowButtonTitle) {
                            Task { await viewModel.sendApproval("allow_for_session") }
                        }
                        .buttonStyle(.bordered)
                    }

                    if approval.supportsAlwaysAllow {
                        Button("Always Allow") {
                            Task { await viewModel.sendApproval("allow_always") }
                        }
                        .buttonStyle(.bordered)
                    }

                    Button(approval.declineButtonTitle, role: .destructive) {
                        Task { await viewModel.sendApproval("decline") }
                    }
                    .buttonStyle(.bordered)
                }
            }
            .padding()
            .navigationTitle("Approval")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
