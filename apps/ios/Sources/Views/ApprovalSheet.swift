import SwiftUI

struct InlineApprovalStep: View {
    @EnvironmentObject private var viewModel: AppViewModel

    let approval: ApprovalRequest

    @State private var selectedScope: ApprovalScopeOption = .once

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: approval.iconName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22, height: 22)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                    Text(approval.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.primary)

                    HStack(spacing: 8) {
                        Text(approval.kindLabel.uppercased())

                        if let serverName = approval.serverName, !serverName.isEmpty {
                            Text(serverName)
                                .lineLimit(1)
                        }

                        Text("Risk \(approval.riskLevel.capitalized)")
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                }
            }

            Text(approval.summary)
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .center, spacing: 10) {
                Menu {
                    ForEach(approval.availableScopeOptions) { option in
                        Button {
                            selectedScope = option
                        } label: {
                            if option == selectedScope {
                                Label(option.title, systemImage: "checkmark")
                            } else {
                                Text(option.title)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(selectedScope.title)
                            .lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Spacer(minLength: 8)

                Button(approval.inlineCancelButtonTitle) {
                    Task { await viewModel.sendApproval("decline") }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Button(approval.inlineApproveButtonTitle) {
                    Task { await viewModel.sendApproval(selectedScope.decision) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
        )
        .onAppear {
            selectedScope = approval.defaultScopeOption
        }
        .onChange(of: approval.id) { _, _ in
            selectedScope = approval.defaultScopeOption
        }
    }
}
