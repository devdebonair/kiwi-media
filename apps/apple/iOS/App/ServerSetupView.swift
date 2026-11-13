import SwiftUI

/// First run (or "Change Server"): where the Kiwi API lives, e.g. `http://100.122.182.74:3333`.
struct ServerSetupView: View {
    let message: String?

    @Environment(AppModel.self) private var app
    @State private var address = ""
    @State private var error: String?
    @State private var isConnecting = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Text("kiwi")
                .font(.system(size: 64, weight: .black, design: .rounded))
                .foregroundStyle(Theme.accent)
            Text("Connect to your Kiwi server")
                .font(.title3.weight(.semibold))
            Text("Enter the address of the Kiwi API, including its port (usually 3333).")
                .font(.subheadline)
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.center)
            TextField("http://192.168.1.20:3333", text: $address)
                .keyboardType(.URL)
                .textContentType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.go)
                .focused($fieldFocused)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 10).fill(.white.opacity(0.1)))
                .onSubmit(connect)
            Button(action: connect) {
                Group {
                    if isConnecting { ProgressView().tint(.black) } else { Text("Connect") }
                }
                .frame(maxWidth: .infinity)
            }
            .primaryAction()
            .disabled(isConnecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
            if let shown = error ?? message {
                Text(shown)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity)
        .background(Theme.background.ignoresSafeArea())
        .onAppear {
            if address.isEmpty, let current = app.api.baseURL { address = current.absoluteString }
        }
    }

    private func connect() {
        guard !isConnecting else { return }
        fieldFocused = false
        error = nil
        isConnecting = true
        Task {
            defer { isConnecting = false }
            do {
                try await app.connect(to: address)
            } catch {
                self.error = "Couldn't connect: \(error.localizedDescription)"
            }
        }
    }
}
