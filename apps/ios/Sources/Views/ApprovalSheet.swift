import SwiftUI

struct ApprovalSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    let approval: ApprovalRequest

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Approval Required")
                    .font(.title2).bold()

                Label(approval.kind.capitalized, systemImage: approval.kind == "command" ? "terminal" : "doc.text")
                    .font(.subheadline)

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
                    Button("Allow for Session") {
                        Task { await viewModel.sendApproval("allow_for_session") }
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Approve") {
                        Task { await viewModel.sendApproval("approve") }
                    }
                    .buttonStyle(.bordered)

                    Button("Decline", role: .destructive) {
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
